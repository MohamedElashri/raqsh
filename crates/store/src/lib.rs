use board_domain::{
    Board, Change, Document, Drawing, Edge, FORMAT, Graph, Id, MAX_DOCUMENT_BYTES, Node, Operation,
    Project, Receipt, SCHEMA_VERSION, title,
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub mod bridge;

const DB_VERSION: u32 = 2;
const LOCAL_ACTOR: &str = "desktop";
const PAGE_SIZE: usize = 100;
// Reserve room for the portable envelope, title, and JSON separators.
const PORTABLE_OVERHEAD: usize = 8192;
const BOARD_COLUMNS: &str = "id, project_id, title, schema_version, semantic_revision, drawing_revision, created_at, updated_at";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub project_id: Id,
    pub board_id: Id,
    pub instance: Id,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBoard {
    pub scope: Scope,
    pub board: Board,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub drawing: Drawing,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_offset: Option<u32>,
}

impl<T> Page<T> {
    fn from_rows(mut items: Vec<T>, offset: u32) -> Self {
        let next_offset = (items.len() > PAGE_SIZE)
            .then(|| offset.checked_add(PAGE_SIZE as u32))
            .flatten();
        items.truncate(PAGE_SIZE);
        Self { items, next_offset }
    }
}

struct Active {
    scope: Scope,
    board: Board,
    graph: Graph,
    drawing_generation: u64,
    semantic_bytes: usize,
    drawing_bytes: usize,
}

struct Commit {
    scope: Option<Scope>,
    receipt: Receipt,
    sqlite_commit_micros: u64,
}

enum MutationInput {
    Operation(Operation),
    Status {
        task: Id,
        status: board_domain::Status,
        expected: u64,
    },
}

struct Mutation {
    project: Id,
    board: Id,
    actor: Option<Id>,
    id: Id,
    request: String,
    input: MutationInput,
}

pub struct Store {
    db: Connection,
    active: Option<Active>,
    _owner: fs::File,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn id(row: &Row<'_>, index: usize) -> rusqlite::Result<Id> {
    row.get::<_, String>(index)?.parse().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn unsigned(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    u64::try_from(row.get::<_, i64>(index)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn project_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: id(row, 0)?,
        root: row.get(1)?,
        title: row.get(2)?,
    })
}

fn board_row(row: &Row<'_>) -> rusqlite::Result<Board> {
    Ok(Board {
        id: id(row, 0)?,
        project_id: id(row, 1)?,
        title: row.get(2)?,
        schema_version: row.get(3)?,
        semantic_revision: unsigned(row, 4)?,
        drawing_revision: unsigned(row, 5)?,
        created_at: unsigned(row, 6)?,
        updated_at: unsigned(row, 7)?,
    })
}

fn bounded_json<T: Serialize>(value: &T) -> Result<String> {
    let text = serde_json::to_string(value)?;
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err("Board data exceeds the 8 MiB limit.".into());
    }
    Ok(text)
}

fn check_budget(semantic_bytes: usize, drawing_bytes: usize) -> Result<()> {
    if semantic_bytes + drawing_bytes + PORTABLE_OVERHEAD > MAX_DOCUMENT_BYTES {
        return Err("This board reached the portable file size limit.".into());
    }
    Ok(())
}

fn entry_bytes<T: Serialize>(entry: &T) -> Result<usize> {
    Ok(serde_json::to_string(entry)?.len() + 1)
}

fn ensure_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}

fn canonical_root(path: &Path) -> Result<String> {
    let path = path
        .canonicalize()
        .map_err(|_| "Project folder could not be opened.")?;
    if !path.is_dir() {
        return Err("Choose an existing directory for the project.".into());
    }
    Ok(path
        .to_str()
        .ok_or("Project folder path must be valid UTF-8.")?
        .to_owned())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        ensure_directory(path.parent().ok_or("Database needs a parent directory.")?)?;
        let owner = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.with_extension("lock"))?;
        owner
            .try_lock()
            .map_err(|error| format!("Another window may own this board library. {error}"))?;
        let mut db = Connection::open(path)?;
        db.busy_timeout(Duration::from_millis(1500))?;
        db.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA;",
        )?;
        let migration = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let version: u32 = migration.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > DB_VERSION {
            return Err("This board database requires a newer app version.".into());
        }
        if version == 0 {
            migration.execute_batch(include_str!("schema.sql"))?;
        }
        if version < 2 {
            migration.execute_batch(include_str!("bridge.sql"))?;
            migration.pragma_update(None, "user_version", DB_VERSION)?;
        }
        migration.commit()?;
        Ok(Self {
            db,
            active: None,
            _owner: owner,
        })
    }

    pub fn projects(&self, offset: u32) -> Result<Page<Project>> {
        let mut stmt = self.db.prepare("SELECT id, root, title FROM projects ORDER BY title COLLATE NOCASE, id LIMIT ?1 OFFSET ?2")?;
        let rows = stmt
            .query_map(params![PAGE_SIZE as u32 + 1, offset], project_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Page::from_rows(rows, offset))
    }

    pub fn add_project(&mut self, path: &Path) -> Result<Project> {
        let root = canonical_root(path)?;
        if let Some(project) = self
            .db
            .query_row(
                "SELECT id, root, title FROM projects WHERE root = ?1",
                [&root],
                project_row,
            )
            .optional()?
        {
            return Ok(project);
        }
        let name = Path::new(&root)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(root.as_str());
        let project = Project {
            id: Id::new_v4(),
            title: title(name).unwrap_or("Project").to_owned(),
            root,
        };
        self.db.execute(
            "INSERT INTO projects VALUES (?1, ?2, ?3)",
            params![project.id.to_string(), project.root, project.title],
        )?;
        Ok(project)
    }

    pub fn relocate_project(&mut self, project: Id, path: &Path) -> Result<Project> {
        let root = canonical_root(path)?;
        if self
            .db
            .query_row(
                "SELECT id FROM projects WHERE root = ?1 AND id != ?2",
                params![root, project.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some()
        {
            return Err("That folder is already assigned to another project.".into());
        }
        self.db
            .query_row(
                "UPDATE projects SET root = ?1 WHERE id = ?2 RETURNING id, root, title",
                params![root, project.to_string()],
                project_row,
            )
            .optional()?
            .ok_or_else(|| "Project no longer exists.".into())
    }

    fn project_available(&self, project: Id) -> Result<String> {
        let root: String = self
            .db
            .query_row(
                "SELECT root FROM projects WHERE id=?1",
                [project.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or("Project no longer exists.")?;
        if canonical_root(Path::new(&root)).as_ref().ok() != Some(&root) {
            return Err(
                "Project folder moved or is unavailable. Use Locate folder to reconnect it.".into(),
            );
        }
        Ok(root)
    }

    pub fn boards(&self, project: Id, offset: u32) -> Result<Page<Board>> {
        let mut stmt = self.db.prepare(&format!("SELECT {BOARD_COLUMNS} FROM boards WHERE project_id = ?1 ORDER BY updated_at DESC, id LIMIT ?2 OFFSET ?3"))?;
        let rows = stmt
            .query_map(
                params![project.to_string(), PAGE_SIZE as u32 + 1, offset],
                board_row,
            )?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Page::from_rows(rows, offset))
    }

    fn insert_board(
        db: &Connection,
        project: Id,
        name: &str,
        drawing: Option<&str>,
    ) -> Result<Board> {
        let name = title(name)?;
        let board_id = Id::new_v4().to_string();
        Ok(db.query_row(&format!("INSERT INTO boards (id,project_id,title,schema_version,drawing,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6) RETURNING {BOARD_COLUMNS}"),
            params![board_id, project.to_string(), name, SCHEMA_VERSION, drawing, i64::try_from(now())?], board_row)?)
    }

    pub fn create_board(&mut self, project: Id, name: &str) -> Result<Board> {
        self.project_available(project)?;
        Self::insert_board(&self.db, project, name, None)
    }

    pub fn rename_board(&mut self, project: Id, board: Id, name: &str) -> Result<Board> {
        let result = self.db.query_row(&format!("UPDATE boards SET title = ?1, updated_at = ?2 WHERE project_id = ?3 AND id = ?4 RETURNING {BOARD_COLUMNS}"),
            params![title(name)?, i64::try_from(now())?, project.to_string(), board.to_string()], board_row).optional()?.ok_or("Board no longer exists in this project.")?;
        if let Some(active) = self
            .active
            .as_mut()
            .filter(|active| active.board.id == board)
        {
            active.board = result.clone();
        }
        Ok(result)
    }

    pub fn delete_board(&mut self, project: Id, board: Id) -> Result<()> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.board.id == board)
        {
            return Err("Close the active board before deleting it.".into());
        }
        let removed = self.db.execute(
            "DELETE FROM boards WHERE project_id = ?1 AND id = ?2",
            params![project.to_string(), board.to_string()],
        )?;
        if removed == 0 {
            return Err("Board no longer exists in this project.".into());
        }
        Ok(())
    }

    fn scene_rows<T: DeserializeOwned + Serialize>(
        &self,
        query: &str,
        board: Id,
    ) -> Result<(Vec<T>, usize)> {
        let mut stmt = self.db.prepare(query)?;
        let mut rows = stmt.query([board.to_string()])?;
        let mut values = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let value = serde_json::from_str(&row.get::<_, String>(0)?)?;
            bytes += entry_bytes(&value)?;
            values.push(value);
        }
        Ok((values, bytes))
    }

    fn read_drawing(&self, board: Id) -> Result<(Drawing, usize)> {
        let text: Option<String> = self.db.query_row(
            "SELECT drawing FROM boards WHERE id=?1",
            [board.to_string()],
            |row| row.get(0),
        )?;
        let (drawing, bytes): (Drawing, usize) = match text {
            Some(text) => (serde_json::from_str(&text)?, text.len()),
            None => (Drawing::default(), 0),
        };
        drawing.validate()?;
        Ok((drawing, bytes))
    }

    pub fn open_board(&mut self, project: Id, board: Id) -> Result<OpenBoard> {
        if self.active.is_some() {
            return Err("Close the current board before opening another.".into());
        }
        self.project_available(project)?;
        let (metadata, graph, semantic_bytes) = self.load_semantic(project, board)?;
        let (drawing, drawing_bytes) = self.read_drawing(board)?;
        let scope = Scope {
            project_id: project,
            board_id: board,
            instance: Id::new_v4(),
        };
        let opened = OpenBoard {
            scope,
            board: metadata.clone(),
            nodes: graph.nodes.values().cloned().collect(),
            edges: graph.edges.values().cloned().collect(),
            drawing,
        };
        self.active = Some(Active {
            scope,
            board: metadata,
            graph,
            drawing_generation: 0,
            semantic_bytes,
            drawing_bytes,
        });
        Ok(opened)
    }

    fn board_info(&self, project: Id, board: Id) -> Result<Board> {
        let metadata = self
            .db
            .query_row(
                &format!("SELECT {BOARD_COLUMNS} FROM boards WHERE project_id = ?1 AND id = ?2"),
                params![project.to_string(), board.to_string()],
                board_row,
            )
            .optional()?
            .ok_or("Board no longer exists in this project.")?;
        if metadata.schema_version != SCHEMA_VERSION {
            return Err("Unsupported saved board schema.".into());
        }
        Ok(metadata)
    }

    fn load_semantic(&self, project: Id, board: Id) -> Result<(Board, Graph, usize)> {
        let metadata = self.board_info(project, board)?;
        let (nodes, node_bytes) =
            self.scene_rows("SELECT body FROM nodes WHERE board_id=?1", board)?;
        let (edges, edge_bytes) =
            self.scene_rows("SELECT body FROM edges WHERE board_id=?1", board)?;
        Ok((
            metadata,
            Graph::from_rows(nodes, edges)?,
            node_bytes + edge_bytes,
        ))
    }

    fn scoped(&self, scope: Scope) -> Result<&Active> {
        self.active
            .as_ref()
            .filter(|active| active.scope == scope)
            .ok_or_else(|| "This editor instance no longer owns the open board.".into())
    }

    pub fn open_project_root(&self, scope: Scope) -> Result<PathBuf> {
        self.scoped(scope)?;
        self.project_available(scope.project_id).map(PathBuf::from)
    }

    pub fn close_board(&mut self, scope: Scope) -> Result<()> {
        self.scoped(scope)?;
        self.active = None;
        Ok(())
    }

    fn upsert_node(db: &Connection, board: &str, node: &Node) -> Result<()> {
        db.execute("INSERT INTO nodes VALUES (?1,?2,?3) ON CONFLICT(board_id,id) DO UPDATE SET body=excluded.body", params![board, node.id.to_string(), serde_json::to_string(node)?])?;
        Ok(())
    }

    fn upsert_edge(db: &Connection, board: &str, edge: &Edge) -> Result<()> {
        db.execute("INSERT INTO edges VALUES (?1,?2,?3) ON CONFLICT(board_id,id) DO UPDATE SET body=excluded.body", params![board, edge.id.to_string(), serde_json::to_string(edge)?])?;
        Ok(())
    }

    pub fn apply(&mut self, scope: Scope, operation: Operation) -> Result<Receipt> {
        self.apply_timed(scope, operation)
            .map(|(receipt, _)| receipt)
    }

    pub fn apply_timed(&mut self, scope: Scope, operation: Operation) -> Result<(Receipt, u64)> {
        self.scoped(scope)?;
        let request = bounded_json(&operation)?;
        self.apply_as(Mutation {
            project: scope.project_id,
            board: scope.board_id,
            actor: None,
            id: operation.id,
            request,
            input: MutationInput::Operation(operation),
        })
        .map(|commit| (commit.receipt, commit.sqlite_commit_micros))
    }

    fn apply_as(&mut self, mutation: Mutation) -> Result<Commit> {
        let Mutation {
            project,
            board,
            actor,
            id,
            request,
            input,
        } = mutation;
        let board_id = board.to_string();
        let operation_id = id.to_string();
        let actor_name = actor.map_or_else(|| LOCAL_ACTOR.to_owned(), |id| id.to_string());
        if let Some((prior_board, prior_actor, saved, response)) = self
            .db
            .query_row(
                "SELECT board_id, actor, request, response FROM receipts WHERE id=?1",
                [&operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?
        {
            if prior_board != board_id || prior_actor != actor_name || saved != request {
                return Err("Operation ID already belongs to another request.".into());
            }
            return Ok(Commit {
                scope: None,
                receipt: serde_json::from_str(&response)?,
                sqlite_commit_micros: 0,
            });
        }
        let staged;
        let active = match self
            .active
            .as_ref()
            .filter(|item| item.board.id == board && item.board.project_id == project)
        {
            Some(active) => active,
            None => {
                let (metadata, graph, semantic_bytes) = self.load_semantic(project, board)?;
                let drawing_bytes = self.db.query_row(
                    "SELECT COALESCE(length(CAST(drawing AS BLOB)),0) FROM boards WHERE id=?1",
                    [&board_id],
                    |row| row.get::<_, u32>(0),
                )? as usize;
                staged = Active {
                    scope: Scope {
                        project_id: project,
                        board_id: board,
                        instance: Id::nil(),
                    },
                    board: metadata,
                    graph,
                    drawing_generation: 0,
                    semantic_bytes,
                    drawing_bytes,
                };
                &staged
            }
        };
        let explicitly_reported = matches!(input, MutationInput::Status { .. });
        let mut operation = match input {
            MutationInput::Operation(operation) => operation,
            MutationInput::Status {
                task,
                status,
                expected,
            } => {
                if expected != active.board.semantic_revision {
                    return Err(board_domain::Error::Conflict {
                        current: active.board.semantic_revision,
                    }
                    .into());
                }
                let mut node = active
                    .graph
                    .nodes
                    .get(&task)
                    .filter(|node| node.kind == board_domain::NodeKind::Task)
                    .ok_or("Task does not exist on the board.")?
                    .clone();
                node.status = status;
                Operation {
                    id,
                    expected_revision: expected,
                    changes: vec![Change::SetNode { node }],
                }
            }
        };
        for change in &mut operation.changes {
            if let Change::SetNode { node } = change {
                node.status_source = match active.graph.nodes.get(&node.id) {
                    Some(prior) if prior.status == node.status && !explicitly_reported => {
                        prior.status_source
                    }
                    _ => actor,
                };
            }
        }
        let scope = (!active.scope.instance.is_nil()).then_some(active.scope);
        let started = Instant::now();
        let current = active.board.semantic_revision;
        let (graph, changes, inverse) = active.graph.reduce(current, &operation)?;
        let mut semantic_bytes = active.semantic_bytes;
        for change in &inverse {
            semantic_bytes -= match change {
                Change::SetNode { node } => entry_bytes(node)?,
                Change::SetEdge { edge } => entry_bytes(edge)?,
                _ => 0,
            };
        }
        for change in &changes {
            semantic_bytes += match change {
                Change::SetNode { node } => entry_bytes(node)?,
                Change::SetEdge { edge } => entry_bytes(edge)?,
                _ => 0,
            };
        }
        check_budget(semantic_bytes, active.drawing_bytes)?;
        let receipt = Receipt {
            revision: current + 1,
            changes,
            inverse,
            committed_at: now(),
            reducer_micros: started.elapsed().as_micros() as u64,
            actor: actor_name.clone(),
        };
        let tx = self.db.transaction()?;
        for change in &receipt.changes {
            match change {
                Change::SetNode { node } => Self::upsert_node(&tx, &board_id, node)?,
                Change::SetEdge { edge } => Self::upsert_edge(&tx, &board_id, edge)?,
                Change::RemoveNode { id } => {
                    tx.execute(
                        "DELETE FROM nodes WHERE board_id=?1 AND id=?2",
                        params![board_id, id.to_string()],
                    )?;
                }
                Change::RemoveEdge { id } => {
                    tx.execute(
                        "DELETE FROM edges WHERE board_id=?1 AND id=?2",
                        params![board_id, id.to_string()],
                    )?;
                }
            }
        }
        tx.execute(
            "UPDATE boards SET semantic_revision=?1, updated_at=?2 WHERE id=?3",
            params![
                i64::try_from(receipt.revision)?,
                i64::try_from(receipt.committed_at)?,
                board_id
            ],
        )?;
        tx.execute(
            "INSERT INTO receipts (id,board_id,actor,request,response,revision) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                operation_id,
                board_id,
                actor_name,
                request,
                serde_json::to_string(&receipt)?,
                i64::try_from(receipt.revision)?
            ],
        )?;
        let commit_started = Instant::now();
        tx.commit()?;
        let sqlite_commit_micros = commit_started.elapsed().as_micros() as u64;
        if let Some(active) = self
            .active
            .as_mut()
            .filter(|item| Some(item.scope) == scope)
        {
            active.graph = graph;
            active.semantic_bytes = semantic_bytes;
            active.board.semantic_revision = receipt.revision;
            active.board.updated_at = receipt.committed_at;
        }
        Ok(Commit {
            scope,
            receipt,
            sqlite_commit_micros,
        })
    }

    pub fn save_drawing(
        &mut self,
        scope: Scope,
        expected: u64,
        generation: u64,
        drawing: Drawing,
    ) -> Result<u64> {
        let active = self.scoped(scope)?;
        let current = active.board.drawing_revision;
        drawing.validate()?;
        let text = bounded_json(&drawing)?;
        check_budget(active.semantic_bytes, text.len())?;
        if generation > 0
            && generation == active.drawing_generation
            && expected.checked_add(1) == Some(current)
        {
            let saved: String = self.db.query_row(
                "SELECT drawing FROM boards WHERE id=?1",
                [scope.board_id.to_string()],
                |row| row.get(0),
            )?;
            if saved == text {
                return Ok(current);
            }
            return Err("Drawing generation already belongs to another checkpoint.".into());
        }
        if expected != current || generation <= active.drawing_generation {
            return Err(format!(
                "Drawing revision changed to {current}. Reopen the board to refresh it."
            )
            .into());
        }
        let revision = current.checked_add(1).ok_or("Drawing revision overflow.")?;
        let saved_at = now();
        self.db.execute(
            "UPDATE boards SET drawing=?1, drawing_revision=?2, updated_at=?3 WHERE id=?4",
            params![
                text,
                i64::try_from(revision)?,
                i64::try_from(saved_at)?,
                scope.board_id.to_string()
            ],
        )?;
        let active = self.active.as_mut().expect("scoped active board");
        active.board.drawing_revision = revision;
        active.board.updated_at = saved_at;
        active.drawing_generation = generation;
        active.drawing_bytes = text.len();
        Ok(revision)
    }

    pub fn export(&self, scope: Scope) -> Result<String> {
        let active = self.scoped(scope)?;
        bounded_json(&Document {
            format: FORMAT.to_owned(),
            schema_version: SCHEMA_VERSION,
            title: active.board.title.clone(),
            nodes: active
                .graph
                .nodes
                .values()
                .cloned()
                .map(|mut node| {
                    node.status_source = None;
                    node
                })
                .collect(),
            edges: active.graph.edges.values().cloned().collect(),
            drawing: self.read_drawing(scope.board_id)?.0,
        })
    }

    pub fn import(&mut self, project: Id, input: &str) -> Result<Board> {
        if input.len() > MAX_DOCUMENT_BYTES {
            return Err("Board file exceeds the 8 MiB limit.".into());
        }
        self.project_available(project)?;
        let (title, graph, drawing) = serde_json::from_str::<Document>(input)?.remap()?;
        let drawing = bounded_json(&drawing)?;
        let mut semantic_bytes = 0;
        for node in graph.nodes.values() {
            semantic_bytes += entry_bytes(node)?;
        }
        for edge in graph.edges.values() {
            semantic_bytes += entry_bytes(edge)?;
        }
        check_budget(semantic_bytes, drawing.len())?;
        let tx = self.db.transaction()?;
        let board = Self::insert_board(&tx, project, &title, Some(&drawing))?;
        let id = board.id.to_string();
        for node in graph.nodes.values() {
            Self::upsert_node(&tx, &id, node)?;
        }
        for edge in graph.edges.values() {
            Self::upsert_edge(&tx, &id, edge)?;
        }
        tx.commit()?;
        Ok(board)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use board_domain::{ExcalidrawScene, Label, NodeKind, Priority, Status};
    use serde_json::{Value, json};
    use std::path::PathBuf;

    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("raqsh-test-{}", Id::new_v4()));
            ensure_directory(&root).unwrap();
            Self(root)
        }
        fn database(&self) -> PathBuf {
            self.0.join("library/boards.sqlite3")
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn drawing(text: &str) -> Drawing {
        Drawing {
            labels: vec![Label {
                x: 1.0,
                y: 2.0,
                text: text.into(),
            }],
            ..Drawing::default()
        }
    }

    fn operation() -> Operation {
        Operation {
            id: Id::new_v4(),
            expected_revision: 0,
            changes: vec![Change::SetNode {
                node: Node {
                    id: Id::new_v4(),
                    kind: NodeKind::Question,
                    title: "خطة".into(),
                    description: String::new(),
                    status: Status::Blocked,
                    status_source: None,
                    priority: Priority::High,
                    dropped: false,
                    x: 10.0,
                    y: 10.0,
                    width: 100.0,
                    height: 60.0,
                    parent: None,
                    order: 0,
                    revision: 0,
                },
            }],
        }
    }

    #[test]
    fn persists_receipts_and_checkpoints_and_rejects_stale_editor_instances() {
        let folder = Folder::new();
        let path = folder.database();
        let mut store = Store::open(&path).unwrap();
        assert!(Store::open(&path).is_err());
        for (pragma, expected) in [
            ("user_version", DB_VERSION),
            ("synchronous", 3),
            ("foreign_keys", 1),
        ] {
            let value: u32 = store
                .db
                .pragma_query_value(None, pragma, |row| row.get(0))
                .unwrap();
            assert_eq!(value, expected);
        }
        assert_eq!(
            store
                .db
                .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
        let project = store.add_project(&folder.0).unwrap();
        let board = store.create_board(project.id, "Plan").unwrap();
        let scope = store.open_board(project.id, board.id).unwrap().scope;
        assert!(store.open_board(project.id, board.id).is_err());
        assert!(store.delete_board(project.id, board.id).is_err());
        let op = operation();
        let saved = store.apply(scope, op.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(store.apply(scope, op.clone()).unwrap(), saved);
        assert!(
            store
                .apply(
                    scope,
                    Operation {
                        expected_revision: 1,
                        ..op.clone()
                    }
                )
                .is_err()
        );
        assert!(
            store
                .apply(
                    scope,
                    Operation {
                        id: Id::new_v4(),
                        ..op.clone()
                    }
                )
                .is_err()
        );

        let scene = drawing("Committed");
        assert_eq!(store.save_drawing(scope, 0, 4, scene.clone()).unwrap(), 1);
        assert_eq!(store.save_drawing(scope, 0, 4, scene.clone()).unwrap(), 1);
        assert!(
            store
                .save_drawing(scope, 0, 4, drawing("Different"))
                .is_err()
        );
        assert!(store.save_drawing(scope, 1, 3, drawing("Stale")).is_err());
        assert!(store.save_drawing(scope, 0, 5, drawing("Stale")).is_err());
        let exported = store.export(scope).unwrap();
        assert!(!exported.contains(project.root.as_str()));
        store.close_board(scope).unwrap();
        drop(store);

        let mut store = Store::open(&path).unwrap();
        let opened = store.open_board(project.id, board.id).unwrap();
        assert_eq!(
            (
                opened.board.semantic_revision,
                opened.board.drawing_revision
            ),
            (1, 1)
        );
        assert_eq!(opened.drawing, scene);
        assert!(store.apply(scope, op.clone()).is_err());
        assert!(
            store
                .save_drawing(scope, 1, 9, drawing("Other editor"))
                .is_err()
        );
        assert_eq!(store.apply(opened.scope, op.clone()).unwrap(), saved);
        let imported = store.import(project.id, &exported).unwrap();
        assert_ne!(imported.id, board.id);
        store.close_board(opened.scope).unwrap();
        let copied = store.open_board(project.id, imported.id).unwrap();
        assert_eq!(copied.drawing, scene);
        assert_ne!(copied.nodes[0].id, opened.nodes[0].id);
        assert_eq!(copied.nodes[0].title, opened.nodes[0].title);
        assert!(store.apply(copied.scope, op).is_err());
    }

    #[test]
    fn round_trips_native_scene_and_remaps_task_bindings() {
        let folder = Folder::new();
        let mut store = Store::open(&folder.database()).unwrap();
        let project = store.add_project(&folder.0).unwrap();
        let board = store.create_board(project.id, "Native scene").unwrap();
        let scope = store.open_board(project.id, board.id).unwrap().scope;
        let op = operation();
        let Change::SetNode { node } = &op.changes[0] else {
            panic!("test needs a task");
        };
        let card_id = node.id;
        store.apply(scope, op).unwrap();
        let scene = ExcalidrawScene {
            version: 1,
            background: "#f0f0ed".into(),
            grid_size: Some(20),
            elements: vec![
                json!({
                    "id": "arrow", "type": "arrow", "isDeleted": false,
                    "x": 4, "y": 3, "width": 9, "height": 5, "angle": 0,
                    "startBinding": { "elementId": format!("raqsh-card-{card_id}"), "gap": 2 },
                    "elbowed": true, "points": [[0, 0], [5, 0], [5, 5], [9, 5]],
                    "strokeStyle": "dashed", "groupIds": ["examples"]
                }),
                json!({
                    "id": "image", "type": "image", "isDeleted": false,
                    "x": 4, "y": 3, "width": 9, "height": 5, "angle": 0, "fileId": "image-data"
                })
            ],
            files: [("image-data".into(), json!({
                "id": "image-data", "mimeType": "image/svg+xml", "dataURL": "data:image/svg+xml;base64,PHN2Zy8+"
            }))].into(),
        };
        let drawing = Drawing {
            excalidraw: Some(scene.clone()),
            ..Drawing::default()
        };
        assert_eq!(store.save_drawing(scope, 0, 1, drawing.clone()).unwrap(), 1);
        assert_eq!(store.save_drawing(scope, 0, 1, drawing.clone()).unwrap(), 1);
        let mut invalid = drawing.clone();
        invalid.excalidraw.as_mut().unwrap().files.clear();
        assert!(store.save_drawing(scope, 1, 2, invalid).is_err());
        let exported = store.export(scope).unwrap();
        store.close_board(scope).unwrap();
        let reopened = store.open_board(project.id, board.id).unwrap();
        assert_eq!(reopened.drawing, drawing);
        store.close_board(reopened.scope).unwrap();

        let imported = store.import(project.id, &exported).unwrap();
        let copied = store.open_board(project.id, imported.id).unwrap();
        let mut expected = scene;
        let new_card = copied.nodes[0].id;
        assert_ne!(new_card, card_id);
        expected.elements[0]["startBinding"]["elementId"] =
            Value::String(format!("raqsh-card-{new_card}"));
        assert_eq!(copied.drawing.excalidraw.unwrap(), expected);
    }

    #[test]
    fn migrates_phase_one_receipts_and_preserves_scope() {
        let folder = Folder::new();
        let path = folder.database();
        ensure_directory(path.parent().unwrap()).unwrap();
        let old = Connection::open(&path).unwrap();
        old.execute_batch(include_str!("schema.sql")).unwrap();
        old.pragma_update(None, "user_version", 1).unwrap();
        let project = Id::new_v4();
        let board = Id::new_v4();
        let operation = operation();
        old.execute(
            "INSERT INTO projects VALUES (?1,?2,'Old project')",
            params![
                project.to_string(),
                folder.0.canonicalize().unwrap().to_str(),
            ],
        )
        .unwrap();
        old.execute("INSERT INTO boards (id,project_id,title,schema_version,semantic_revision,created_at,updated_at) VALUES (?1,?2,'Old board',1,1,1,1)",
            params![board.to_string(), project.to_string()]).unwrap();
        let (_, changes, inverse) = Graph::default().reduce(0, &operation).unwrap();
        let receipt = Receipt {
            revision: 1,
            changes,
            inverse,
            committed_at: 1,
            reducer_micros: 0,
            actor: LOCAL_ACTOR.into(),
        };
        old.execute(
            "INSERT INTO receipts VALUES (?1,?2,?3,?4,?5)",
            params![
                operation.id.to_string(),
                board.to_string(),
                LOCAL_ACTOR,
                serde_json::to_string(&operation).unwrap(),
                serde_json::to_string(&receipt).unwrap()
            ],
        )
        .unwrap();
        if let Change::SetNode { node } = &receipt.changes[0] {
            Store::upsert_node(&old, &board.to_string(), node).unwrap();
        }
        drop(old);

        let mut store = Store::open(&path).unwrap();
        let open = store.open_board(project, board).unwrap();
        assert_eq!(open.board.schema_version, 1);
        assert_eq!(open.nodes.len(), 1);
        assert_eq!(store.apply(open.scope, operation).unwrap(), receipt);
        assert_eq!(
            store.desktop_deltas(open.scope, 0).unwrap().deltas[0].revision,
            1
        );
    }

    #[test]
    fn feedback_is_bound_and_acknowledgement_is_explicit() {
        use board_ipc::{Ack, Call, Credential, GetFeedback, Request, VERSION};
        let folder = Folder::new();
        let mut store = Store::open(&folder.database()).unwrap();
        let project = store.add_project(&folder.0).unwrap();
        let board = store.create_board(project.id, "Board").unwrap();
        let other = store.create_board(project.id, "Other").unwrap();
        let open = store.open_board(project.id, board.id).unwrap();
        let a = Credential::new().unwrap();
        let b = Credential::new().unwrap();
        store.pair(open.scope, "A", false, &a).unwrap();
        store.pair(open.scope, "B", true, &b).unwrap();
        let event = Id::new_v4();
        assert_eq!(
            store
                .queue_feedback(open.scope, a.binding_id, event, "Review")
                .unwrap()
                .state,
            "queued"
        );
        let request = |credential: &Credential, call| Request {
            version: VERSION,
            request_id: Id::new_v4(),
            credential: credential.clone(),
            call,
        };
        let ack = Id::new_v4();
        let make_ack = |board_id| {
            Call::BoardAckFeedback(Ack {
                board_id,
                feedback_id: event,
                operation_id: ack,
            })
        };
        assert_eq!(
            store
                .bridge(request(&a, make_ack(board.id)))
                .err()
                .unwrap()
                .code,
            "invalid_request"
        );
        assert_eq!(
            store
                .bridge(request(&b, make_ack(board.id)))
                .err()
                .unwrap()
                .code,
            "forbidden"
        );
        assert_eq!(
            store
                .bridge(request(&b, make_ack(other.id)))
                .err()
                .unwrap()
                .code,
            "forbidden"
        );
        store
            .bridge(request(
                &a,
                Call::BoardGetFeedback(GetFeedback {
                    board_id: board.id,
                    after: None,
                }),
            ))
            .unwrap();
        assert!(store.cancel_feedback(open.scope, event).is_err());
        let first = store.bridge(request(&a, make_ack(board.id))).unwrap().0;
        assert_eq!(first["state"], "acknowledged");
        assert_eq!(
            store.bridge(request(&a, make_ack(board.id))).unwrap().0,
            first
        );
        store.revoke_pairing(open.scope, a.binding_id).unwrap();
        assert_eq!(
            store
                .bridge(request(&a, make_ack(board.id)))
                .err()
                .unwrap()
                .code,
            "forbidden"
        );
    }

    #[test]
    fn handles_project_relocation_and_scoped_board_metadata() {
        let folder = Folder::new();
        let old = folder.0.join("old");
        let new = folder.0.join("new");
        let linked = folder.0.join("linked");
        ensure_directory(&old).unwrap();
        ensure_directory(&linked).unwrap();
        let mut store = Store::open(&folder.database()).unwrap();
        let a = store.add_project(&old).unwrap();
        assert_eq!(store.add_project(&old.join(".")).unwrap().id, a.id);
        let b = store.add_project(&linked).unwrap();
        assert_ne!(a.id, b.id);
        let board = store.create_board(a.id, "Old title").unwrap();
        assert!(store.open_board(b.id, board.id).is_err());
        assert!(store.rename_board(b.id, board.id, "Wrong project").is_err());
        assert!(store.delete_board(b.id, board.id).is_err());
        fs::rename(&old, &new).unwrap();
        assert!(store.open_board(a.id, board.id).is_err());
        assert!(store.relocate_project(a.id, &linked).is_err());
        assert_eq!(store.relocate_project(a.id, &new).unwrap().id, a.id);
        store.rename_board(a.id, board.id, "New title").unwrap();
        let opened = store.open_board(a.id, board.id).unwrap();
        assert_eq!(opened.board.title, "New title");
        store.close_board(opened.scope).unwrap();
        store.delete_board(a.id, board.id).unwrap();
        assert!(store.boards(a.id, 0).unwrap().items.is_empty());
    }
}
