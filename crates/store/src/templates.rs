use super::{Page, Result, Scope, Store, bounded_json, check_budget, entry_bytes, id};
use board_domain::{
    Board, Document, Drawing, Edge, EdgeKind, FORMAT, Graph, Id, MAX_DOCUMENT_BYTES, Node,
    NodeKind, Priority, SCHEMA_VERSION, Status, title,
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const FORMAT_NAME: &str = "dev.local.raqsh.template";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateDocument {
    format: String,
    version: u32,
    title: String,
    cards: Vec<TemplateCard>,
    dependencies: Vec<TemplateDependency>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemplateCard {
    id: Id,
    kind: NodeKind,
    title: String,
    description: String,
    priority: Priority,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    parent: Option<Id>,
    order: i64,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemplateDependency {
    from: Id,
    to: Id,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    id: Id,
    title: String,
    card_count: u32,
}

impl TemplateDocument {
    pub fn parse(input: &str) -> Result<Self> {
        if input.len() > MAX_DOCUMENT_BYTES {
            return Err("Template file exceeds the 8 MiB limit.".into());
        }
        let mut document: Self = serde_json::from_str(input)?;
        document.validate()?;
        Ok(document)
    }

    fn validate(&mut self) -> Result<()> {
        if self.format != FORMAT_NAME || self.version != FORMAT_VERSION {
            return Err("Unsupported template file format or version.".into());
        }
        self.title = title(&self.title)?.to_owned();
        self.cards
            .sort_unstable_by_key(|card| (card.order, card.id));
        let document = self.board_document(&self.title);
        let graph = Graph::from_rows(document.nodes, document.edges)?;
        let mut semantic_bytes = 0;
        for node in graph.nodes.values() {
            semantic_bytes += entry_bytes(node)?;
        }
        for edge in graph.edges.values() {
            semantic_bytes += entry_bytes(edge)?;
        }
        check_budget(semantic_bytes, bounded_json(&document.drawing)?.len())
    }

    fn board_document(&self, board_title: &str) -> Document {
        Document {
            format: FORMAT.to_owned(),
            schema_version: SCHEMA_VERSION,
            title: board_title.to_owned(),
            nodes: self
                .cards
                .iter()
                .map(|card| Node {
                    id: card.id,
                    kind: card.kind,
                    title: card.title.clone(),
                    description: card.description.clone(),
                    status: Status::Todo,
                    status_source: None,
                    priority: card.priority,
                    dropped: false,
                    x: card.x,
                    y: card.y,
                    width: card.width,
                    height: card.height,
                    parent: card.parent,
                    order: card.order,
                    revision: 0,
                })
                .collect(),
            edges: self
                .dependencies
                .iter()
                .map(|dependency| Edge {
                    id: Id::new_v4(),
                    from: dependency.from,
                    to: dependency.to,
                    kind: EdgeKind::Dependency,
                    revision: 0,
                })
                .collect(),
            drawing: Drawing::default(),
        }
    }
}

impl Store {
    pub fn capture_board_template(&self, scope: Scope) -> Result<TemplateDocument> {
        let active = self.scoped(scope)?;
        let ids: HashMap<_, _> = active
            .graph
            .nodes
            .keys()
            .map(|id| (*id, Id::new_v4()))
            .collect();
        let mut nodes: Vec<_> = active.graph.nodes.values().collect();
        nodes.sort_unstable_by_key(|node| (node.order, node.id));
        let mut document = TemplateDocument {
            format: FORMAT_NAME.into(),
            version: FORMAT_VERSION,
            title: active.board.title.clone(),
            cards: nodes
                .into_iter()
                .enumerate()
                .map(|(order, node)| TemplateCard {
                    id: ids[&node.id],
                    kind: node.kind,
                    title: node.title.clone(),
                    description: node.description.clone(),
                    priority: node.priority,
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                    parent: node.parent.map(|parent| ids[&parent]),
                    order: order as i64,
                })
                .collect(),
            dependencies: active
                .graph
                .edges
                .values()
                .filter(|edge| edge.kind == EdgeKind::Dependency)
                .map(|edge| TemplateDependency {
                    from: ids[&edge.from],
                    to: ids[&edge.to],
                })
                .collect(),
        };
        document.validate()?;
        Ok(document)
    }

    pub fn save_board_template(
        &mut self,
        id: Id,
        mut document: TemplateDocument,
    ) -> Result<TemplateInfo> {
        if id.is_nil() {
            return Err("A template needs a valid identifier.".into());
        }
        document.validate()?;
        let data = bounded_json(&document)?;
        let info = TemplateInfo {
            id,
            title: document.title,
            card_count: document.cards.len() as u32,
        };
        if let Some(existing) = self.template_data(id)? {
            if existing != data {
                return Err("This template identifier is already in use.".into());
            }
            return Ok(info);
        }
        self.db.execute(
            "INSERT INTO board_templates (id, title, card_count, data) VALUES (?1, ?2, ?3, ?4)",
            params![id.to_string(), info.title, info.card_count, data],
        )?;
        Ok(info)
    }

    pub fn board_templates(&self, offset: u32) -> Result<Page<TemplateInfo>> {
        let mut stmt = self.db.prepare(
            "SELECT id, title, card_count FROM board_templates ORDER BY title COLLATE NOCASE, id LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt
            .query_map(params![super::PAGE_SIZE as u32 + 1, offset], |row| {
                Ok(TemplateInfo {
                    id: id(row, 0)?,
                    title: row.get(1)?,
                    card_count: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Page::from_rows(rows, offset))
    }

    fn template_data(&self, id: Id) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT data FROM board_templates WHERE id = ?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn read_board_template(&self, id: Id) -> Result<String> {
        self.template_data(id)?
            .ok_or("This template could not be found.".into())
    }

    pub fn new_board_from_template(
        &mut self,
        project: Id,
        id: Id,
        board_title: &str,
    ) -> Result<Board> {
        let template = TemplateDocument::parse(&self.read_board_template(id)?)?;
        let input = bounded_json(&template.board_document(title(board_title)?))?;
        self.import(project, &input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use board_domain::Label;
    use std::{fs, path::PathBuf};

    struct Library(PathBuf);

    impl Library {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("raqsh-templates-{}", Id::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn card(title: &str, kind: NodeKind, order: i64, parent: Option<Id>) -> TemplateCard {
        TemplateCard {
            id: Id::new_v4(),
            kind,
            title: title.into(),
            description: "Repeat this on the release branch.".into(),
            priority: Priority::High,
            x: 104.0,
            y: 44.0 + order as f64 * 100.0,
            width: 248.0,
            height: 80.0,
            parent,
            order,
        }
    }

    fn sample() -> TemplateDocument {
        let group = card("Release checks", NodeKind::Group, 0, None);
        let extract = card("Extract the archive", NodeKind::Task, 1, Some(group.id));
        let install = card("Test install", NodeKind::Task, 2, Some(group.id));
        let dependency = TemplateDependency {
            from: extract.id,
            to: install.id,
        };
        TemplateDocument {
            format: FORMAT_NAME.into(),
            version: FORMAT_VERSION,
            title: "Release template".into(),
            cards: vec![group, extract, install],
            dependencies: vec![dependency],
        }
    }

    #[test]
    fn rejects_unsupported_fields_and_invalid_graphs() {
        let mut document = sample();
        document.version = 2;
        assert!(TemplateDocument::parse(&bounded_json(&document).unwrap()).is_err());

        document.version = FORMAT_VERSION;
        document.cards[1].parent = Some(Id::new_v4());
        assert!(TemplateDocument::parse(&bounded_json(&document).unwrap()).is_err());
        document.cards[1].parent = Some(document.cards[0].id);
        document.dependencies.push(TemplateDependency {
            from: document.cards[2].id,
            to: document.cards[1].id,
        });
        assert!(TemplateDocument::parse(&bounded_json(&document).unwrap()).is_err());

        let mut payload = serde_json::to_value(sample()).unwrap();
        payload["cards"][0]["statusSource"] = serde_json::json!(Id::new_v4());
        assert!(TemplateDocument::parse(&serde_json::to_string(&payload).unwrap()).is_err());
        assert!(TemplateDocument::parse(&" ".repeat(MAX_DOCUMENT_BYTES + 1)).is_err());
    }

    #[test]
    fn captures_only_reusable_structure_and_instantiates_independent_boards() {
        let library = Library::new();
        let db = library.0.join("library/boards.sqlite3");
        let path = library.0.join("other project");
        fs::create_dir(&path).unwrap();
        let mut store = Store::open(&db).unwrap();
        let project = store.add_project(&library.0).unwrap();
        let destination = store.add_project(&path).unwrap();
        let mut original = sample().board_document("Original release");
        original.nodes[1].status = Status::Done;
        original.nodes[2].dropped = true;
        original.edges.push(Edge {
            id: Id::new_v4(),
            from: original.nodes[0].id,
            to: original.nodes[1].id,
            kind: EdgeKind::Annotation,
            revision: 0,
        });
        original.drawing.labels.push(Label {
            x: 2.0,
            y: 4.0,
            text: "Drawing stays here.".into(),
        });
        let board = store
            .import(project.id, &bounded_json(&original).unwrap())
            .unwrap();
        let open = store.open_board(project.id, board.id).unwrap();
        let invalid = Scope {
            instance: Id::new_v4(),
            ..open.scope
        };
        assert!(store.capture_board_template(invalid).is_err());
        let template = store.capture_board_template(open.scope).unwrap();
        let template_id = Id::new_v4();
        assert_eq!(template.cards.len(), 3);
        assert_eq!(template.dependencies.len(), 1);
        assert!(
            !template
                .cards
                .iter()
                .any(|card| open.nodes.iter().any(|node| node.id == card.id))
        );
        let payload = bounded_json(&template).unwrap();
        for key in [
            "status",
            "dropped",
            "statusSource",
            "drawing",
            "revision",
            "projectId",
        ] {
            assert!(!payload.contains(&format!("\"{key}\"")));
        }
        assert_eq!(
            store
                .save_board_template(template_id, template)
                .unwrap()
                .card_count,
            3
        );
        store
            .save_board_template(template_id, TemplateDocument::parse(&payload).unwrap())
            .unwrap();
        assert!(store.save_board_template(template_id, sample()).is_err());
        assert_eq!(store.board_templates(0).unwrap().items.len(), 1);
        drop(store);

        let mut store = Store::open(&db).unwrap();
        assert_eq!(store.read_board_template(template_id).unwrap(), payload);
        assert_eq!(
            store.board_templates(0).unwrap().items[0].title,
            "Original release"
        );
        let applied = store
            .new_board_from_template(destination.id, template_id, "Next release")
            .unwrap();
        let new = store.open_board(destination.id, applied.id).unwrap();
        assert_ne!(new.board.id, board.id);
        assert_eq!(new.board.title, "Next release");
        assert_eq!(
            (new.board.semantic_revision, new.board.drawing_revision),
            (0, 0)
        );
        assert!(new.drawing.labels.is_empty());
        assert_eq!(new.edges.len(), 1);
        assert!(new.nodes.iter().all(|node| !node.dropped
            && node.status == Status::Todo
            && node.status_source.is_none()
            && node.priority == Priority::High));
        let group = new
            .nodes
            .iter()
            .find(|node| node.title == "Release checks")
            .unwrap();
        let extract = new
            .nodes
            .iter()
            .find(|node| node.title == "Extract the archive")
            .unwrap();
        let install = new
            .nodes
            .iter()
            .find(|node| node.title == "Test install")
            .unwrap();
        assert_eq!(extract.parent, Some(group.id));
        assert_eq!(
            (extract.x, extract.y, extract.width, extract.height),
            (104.0, 144.0, 248.0, 80.0)
        );
        assert_eq!(
            (new.edges[0].from, new.edges[0].to),
            (extract.id, install.id)
        );
        assert!(
            !open
                .nodes
                .iter()
                .any(|before| new.nodes.iter().any(|after| before.id == after.id))
        );
        assert!(
            store
                .new_board_from_template(Id::new_v4(), template_id, "Missing project")
                .is_err()
        );
    }
}
