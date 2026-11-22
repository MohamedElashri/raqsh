use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
pub use uuid::Uuid as Id;

pub const FORMAT: &str = "dev.local.visualboard.board";
pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_NODES: usize = 2_000;
const MAX_EDGES: usize = 4_000;
pub const MAX_CHANGES: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Invalid(&'static str),
    Conflict { current: u64 },
}

impl std::fmt::Display for Error {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => out.write_str(message),
            Self::Conflict { current } => write!(
                out,
                "Board revision changed to {current}. Reopen the board to refresh it."
            ),
        }
    }
}

impl std::error::Error for Error {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub id: Id,
    pub root: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Board {
    pub id: Id,
    pub project_id: Id,
    pub title: String,
    pub schema_version: u32,
    pub semantic_revision: u64,
    pub drawing_revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    #[default]
    Task,
    Decision,
    Question,
    Blocker,
    Group,
    Note,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    #[default]
    Todo,
    InProgress,
    Blocked,
    Done,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Low,
    #[default]
    Normal,
    High,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: Id,
    pub kind: NodeKind,
    pub title: String,
    pub description: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_source: Option<Id>,
    pub priority: Priority,
    pub dropped: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub parent: Option<Id>,
    pub order: i64,
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    Dependency,
    Annotation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edge {
    pub id: Id,
    pub from: Id,
    pub to: Id,
    pub kind: EdgeKind,
    pub revision: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Graph {
    pub nodes: BTreeMap<Id, Node>,
    pub edges: BTreeMap<Id, Edge>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    SetNode { node: Node },
    RemoveNode { id: Id },
    SetEdge { edge: Edge },
    RemoveEdge { id: Id },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub id: Id,
    pub expected_revision: u64,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub revision: u64,
    pub changes: Vec<Change>,
    pub inverse: Vec<Change>,
    pub committed_at: u64,
    pub reducer_micros: u64,
    pub actor: String,
}

pub fn title(value: &str) -> Result<&str, Error> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 1024 || trimmed.contains('\0') {
        return Err(Error::Invalid("Enter a title of 1–1024 bytes."));
    }
    Ok(trimmed)
}

fn point(x: f64, y: f64) -> bool {
    (-100_000.0..=100_000.0).contains(&x) && (-100_000.0..=100_000.0).contains(&y)
}

impl Graph {
    pub fn from_rows(nodes: Vec<Node>, edges: Vec<Edge>) -> Result<Self, Error> {
        let counts = (nodes.len(), edges.len());
        let graph = Self {
            nodes: nodes.into_iter().map(|node| (node.id, node)).collect(),
            edges: edges.into_iter().map(|edge| (edge.id, edge)).collect(),
        };
        if counts != (graph.nodes.len(), graph.edges.len()) {
            return Err(Error::Invalid("Duplicate card or edge ID."));
        }
        graph.validate()?;
        Ok(graph)
    }

    fn validate(&self) -> Result<(), Error> {
        if self.nodes.len() > MAX_NODES || self.edges.len() > MAX_EDGES {
            return Err(Error::Invalid("Board exceeds card or edge limits."));
        }
        for node in self.nodes.values() {
            title(&node.title)?;
            if node.id.is_nil()
                || !point(node.x, node.y)
                || !(48.0..=4096.0).contains(&node.width)
                || !(32.0..=4096.0).contains(&node.height)
                || node.description.len() > 16_384
                || node.description.contains('\0')
                || !(-1_000_000_000..=1_000_000_000).contains(&node.order)
            {
                return Err(Error::Invalid(
                    "Invalid card geometry, description or order.",
                ));
            }
            if let Some(parent) = node.parent
                && self
                    .nodes
                    .get(&parent)
                    .is_none_or(|parent| parent.kind != NodeKind::Group)
            {
                return Err(Error::Invalid(
                    "A card's parent must be a group on this board.",
                ));
            }
        }
        let mut references = HashSet::new();
        for edge in self.edges.values() {
            if edge.id.is_nil()
                || edge.from == edge.to
                || !self.nodes.contains_key(&edge.from)
                || !self.nodes.contains_key(&edge.to)
                || !references.insert((edge.from, edge.to, edge.kind))
            {
                return Err(Error::Invalid("Invalid or duplicate board edge."));
            }
        }
        self.acyclic(
            self.nodes
                .values()
                .filter_map(|node| node.parent.map(|parent| (parent, node.id))),
            "Group membership contains a cycle.",
        )?;
        self.acyclic(
            self.edges
                .values()
                .filter(|edge| edge.kind == EdgeKind::Dependency)
                .map(|edge| (edge.from, edge.to)),
            "Dependencies contain a cycle.",
        )
    }

    fn acyclic(
        &self,
        edges: impl Iterator<Item = (Id, Id)>,
        error: &'static str,
    ) -> Result<(), Error> {
        let mut incoming: HashMap<_, usize> = self.nodes.keys().map(|&id| (id, 0)).collect();
        let mut outgoing: HashMap<Id, Vec<Id>> = HashMap::new();
        for (from, to) in edges {
            *incoming.get_mut(&to).expect("validated endpoint") += 1;
            outgoing.entry(from).or_default().push(to);
        }
        let mut ready: Vec<_> = incoming
            .iter()
            .filter_map(|(&id, &degree)| (degree == 0).then_some(id))
            .collect();
        let mut visited = 0;
        while let Some(id) = ready.pop() {
            visited += 1;
            for next in outgoing.get(&id).into_iter().flatten() {
                let degree = incoming.get_mut(next).expect("validated endpoint");
                *degree -= 1;
                if *degree == 0 {
                    ready.push(*next);
                }
            }
        }
        if visited == self.nodes.len() {
            Ok(())
        } else {
            Err(Error::Invalid(error))
        }
    }

    pub fn reduce(
        &self,
        current: u64,
        operation: &Operation,
    ) -> Result<(Self, Vec<Change>, Vec<Change>), Error> {
        if operation.expected_revision != current {
            return Err(Error::Conflict { current });
        }
        if operation.id.is_nil()
            || operation.changes.is_empty()
            || operation.changes.len() > MAX_CHANGES
        {
            return Err(Error::Invalid("Invalid operation ID or batch size."));
        }
        let revision = current
            .checked_add(1)
            .ok_or(Error::Invalid("Board revision overflow."))?;
        let mut next = self.clone();
        let mut forward = Vec::new();
        let mut inverse = Vec::new();
        let mut touched = HashSet::new();
        for change in &operation.changes {
            let (key, applied, previous) = match change {
                Change::SetNode { node } => {
                    let mut node = node.clone();
                    node.title = title(&node.title)?.to_owned();
                    node.revision = revision;
                    let previous = next
                        .nodes
                        .insert(node.id, node.clone())
                        .map_or(Change::RemoveNode { id: node.id }, |node| Change::SetNode {
                            node,
                        });
                    ((true, node.id), Change::SetNode { node }, previous)
                }
                Change::RemoveNode { id } => {
                    let node = next
                        .nodes
                        .remove(id)
                        .ok_or(Error::Invalid("Card does not exist."))?;
                    ((true, *id), change.clone(), Change::SetNode { node })
                }
                Change::SetEdge { edge } => {
                    let mut edge = edge.clone();
                    edge.revision = revision;
                    let previous = next
                        .edges
                        .insert(edge.id, edge.clone())
                        .map_or(Change::RemoveEdge { id: edge.id }, |edge| Change::SetEdge {
                            edge,
                        });
                    ((false, edge.id), Change::SetEdge { edge }, previous)
                }
                Change::RemoveEdge { id } => {
                    let edge = next
                        .edges
                        .remove(id)
                        .ok_or(Error::Invalid("Edge does not exist."))?;
                    ((false, *id), change.clone(), Change::SetEdge { edge })
                }
            };
            if !touched.insert(key) {
                return Err(Error::Invalid("A batch may change each card or edge once."));
            }
            forward.push(applied);
            inverse.push(previous);
        }
        next.validate()?;
        inverse.reverse();
        Ok((next, forward, inverse))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Ink {
    #[default]
    Green,
    Slate,
    Blue,
    Red,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub points: Vec<[f64; 2]>,
    pub color: Ink,
    pub width: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Label {
    pub x: f64,
    pub y: f64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Arrow {
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub color: Ink,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Drawing {
    pub strokes: Vec<Stroke>,
    pub labels: Vec<Label>,
    pub arrows: Vec<Arrow>,
}

impl Drawing {
    pub fn validate(&self) -> Result<(), Error> {
        let mut ids = HashSet::new();
        if self.strokes.len() > 2_000
            || self.labels.len() > 1_000
            || self.arrows.len() > 1_000
            || self
                .strokes
                .iter()
                .map(|stroke| stroke.points.len())
                .sum::<usize>()
                > 180_000
            || self.strokes.iter().any(|stroke| {
                stroke.id.is_empty()
                    || stroke.id.len() > 64
                    || !ids.insert(&stroke.id)
                    || !point(stroke.x, stroke.y)
                    || !(1.0..=12.0).contains(&stroke.width)
                    || !(2..=1024).contains(&stroke.points.len())
                    || stroke
                        .points
                        .iter()
                        .any(|&[x, y]| !point(stroke.x + x, stroke.y + y))
            })
            || self
                .labels
                .iter()
                .any(|label| !point(label.x, label.y) || title(&label.text).is_err())
            || self.arrows.iter().any(|arrow| {
                !point(arrow.from[0], arrow.from[1])
                    || !point(arrow.to[0], arrow.to[1])
                    || arrow.from == arrow.to
            })
        {
            return Err(Error::Invalid(
                "Invalid drawing or drawing size limit exceeded.",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub format: String,
    pub schema_version: u32,
    pub title: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub drawing: Drawing,
}

impl Document {
    pub fn remap(self) -> Result<(String, Graph, Drawing), Error> {
        if self.format != FORMAT || self.schema_version != SCHEMA_VERSION {
            return Err(Error::Invalid(
                "Unsupported board file format or schema version.",
            ));
        }
        let title = title(&self.title)?.to_owned();
        self.drawing.validate()?;
        let graph = Graph::from_rows(self.nodes, self.edges)?;
        let ids: HashMap<_, _> = graph.nodes.keys().map(|&id| (id, Id::new_v4())).collect();
        let mut nodes: Vec<_> = graph.nodes.into_values().collect();
        nodes.sort_unstable_by_key(|node| (node.order, node.id));
        for (order, node) in nodes.iter_mut().enumerate() {
            node.id = ids[&node.id];
            node.parent = node.parent.map(|id| ids[&id]);
            node.order = order as i64;
            node.revision = 0;
            node.status_source = None;
        }
        let edges = graph
            .edges
            .into_values()
            .map(|mut edge| {
                edge.id = Id::new_v4();
                edge.from = ids[&edge.from];
                edge.to = ids[&edge.to];
                edge.revision = 0;
                edge
            })
            .collect();
        let mut drawing = self.drawing;
        for stroke in &mut drawing.strokes {
            stroke.id = Id::new_v4().to_string();
        }
        Ok((title, Graph::from_rows(nodes, edges)?, drawing))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(kind: NodeKind, order: i64) -> Node {
        Node {
            id: Id::new_v4(),
            kind,
            order,
            title: "Card".into(),
            description: String::new(),
            status: Status::Todo,
            status_source: None,
            priority: Priority::Normal,
            dropped: false,
            x: 0.0,
            y: 0.0,
            width: 216.0,
            height: 86.0,
            parent: None,
            revision: 0,
        }
    }

    fn edge(from: Id, to: Id) -> Edge {
        Edge {
            id: Id::new_v4(),
            from,
            to,
            kind: EdgeKind::Dependency,
            revision: 0,
        }
    }

    #[test]
    fn reject_invalid_graphs() {
        let mut a = node(NodeKind::Group, 0);
        let mut b = node(NodeKind::Group, 1);
        assert!(Graph::from_rows(vec![a.clone(), a.clone()], vec![]).is_err());
        assert!(Graph::from_rows(vec![a.clone()], vec![edge(a.id, b.id)]).is_err());
        assert!(
            Graph::from_rows(
                vec![a.clone(), b.clone()],
                vec![edge(a.id, b.id), edge(b.id, a.id)]
            )
            .is_err()
        );
        a.parent = Some(b.id);
        b.parent = Some(a.id);
        assert!(Graph::from_rows(vec![a, b], vec![]).is_err());
    }

    #[test]
    fn atomic_delta_inverse_and_revision_guards() {
        let original = node(NodeKind::Task, 0);
        let graph = Graph::from_rows(vec![original.clone()], vec![]).unwrap();
        let mut updated = original.clone();
        updated.title = "  Updated  ".into();
        let change = Change::SetNode { node: updated };
        let mut operation = Operation {
            id: Id::new_v4(),
            expected_revision: 0,
            changes: vec![change.clone(), change.clone()],
        };
        assert!(graph.reduce(0, &operation).is_err());
        operation.changes.pop();
        assert!(matches!(
            graph.reduce(1, &operation),
            Err(Error::Conflict { current: 1 })
        ));
        operation.id = Id::nil();
        assert!(graph.reduce(0, &operation).is_err());
        operation.id = Id::new_v4();
        let (after, forward, inverse) = graph.reduce(0, &operation).unwrap();
        assert_eq!(
            forward,
            [Change::SetNode {
                node: after.nodes[&original.id].clone()
            }]
        );
        assert_eq!(after.nodes[&original.id].title, "Updated");
        assert_eq!(graph.nodes[&original.id], original);
        let redo = Operation {
            id: Id::new_v4(),
            expected_revision: 1,
            changes: inverse,
        };
        let (restored, _, _) = after.reduce(1, &redo).unwrap();
        assert_eq!(
            restored.nodes[&original.id],
            Node {
                revision: 2,
                ..original
            }
        );
    }

    #[test]
    fn portable_import_remaps_references_and_validates_scene() {
        let a = node(NodeKind::Group, 0);
        let mut b = node(NodeKind::Task, 1);
        b.parent = Some(a.id);
        let link = edge(a.id, b.id);
        let mut document = Document {
            format: FORMAT.into(),
            schema_version: SCHEMA_VERSION,
            title: "Board".into(),
            nodes: vec![a.clone(), b.clone()],
            edges: vec![link.clone()],
            drawing: Drawing::default(),
        };
        document.drawing.arrows.push(Arrow {
            from: [f64::INFINITY, 0.0],
            to: [0.0, 0.0],
            color: Ink::Blue,
        });
        assert!(document.clone().remap().is_err());
        document.drawing.arrows.clear();
        let (_, copied, _) = document.remap().unwrap();
        let new_edge = copied.edges.values().next().unwrap();
        assert_ne!(new_edge.id, link.id);
        assert_ne!(new_edge.from, a.id);
        assert_ne!(new_edge.to, b.id);
        assert_eq!(copied.nodes[&new_edge.to].parent, Some(new_edge.from));
        assert_eq!(copied.nodes[&new_edge.from].kind, NodeKind::Group);
    }
}
