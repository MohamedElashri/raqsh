use super::*;
use board_ipc::{Call, Credential, Failure, MAX_OPERATION_BYTES, Request, Section, VERSION};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const BOARD_PAGE: u32 = 20;
const NODE_PAGE: u32 = 12;
const EDGE_PAGE: u32 = 40;
const FEEDBACK_PAGE: u32 = 20;
const DELTA_PAGE: usize = 12;
const DELTA_BYTES: usize = 512 * 1024;
const FEEDBACK_LIMIT: u32 = 128;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: Id,
    pub project_id: Id,
    pub board_id: Option<Id>,
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub revision: u64,
    pub changes: Vec<Change>,
    pub actor: String,
}

impl From<Receipt> for Delta {
    fn from(receipt: Receipt) -> Self {
        Self {
            revision: receipt.revision,
            changes: receipt.changes,
            actor: receipt.actor,
        }
    }
}

pub enum BoardUpdate {
    Revision { scope: Scope, revision: u64 },
    Feedback(Id),
    Bindings,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaPage {
    pub revision: u64,
    pub deltas: Vec<Delta>,
    pub next_revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub id: Id,
    pub sequence: u64,
    pub binding_id: Id,
    pub board_id: Id,
    pub revision: u64,
    pub text: String,
    pub state: String,
    pub ack_id: Option<Id>,
    pub response_id: Option<Id>,
    pub response: Option<String>,
    pub created_at: u64,
}

const FEEDBACK_COLUMNS: &str =
    "id,sequence,binding_id,board_id,revision,text,state,ack_id,response_id,response,created_at";

fn optional_id(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<Id>> {
    if matches!(row.get_ref(index)?, rusqlite::types::ValueRef::Null) {
        Ok(None)
    } else {
        id(row, index).map(Some)
    }
}

fn binding_row(row: &Row<'_>) -> rusqlite::Result<Binding> {
    Ok(Binding {
        id: id(row, 0)?,
        project_id: id(row, 1)?,
        board_id: optional_id(row, 2)?,
        label: row.get(3)?,
    })
}

fn feedback_row(row: &Row<'_>) -> rusqlite::Result<Feedback> {
    Ok(Feedback {
        id: id(row, 0)?,
        sequence: unsigned(row, 1)?,
        binding_id: id(row, 2)?,
        board_id: id(row, 3)?,
        revision: unsigned(row, 4)?,
        text: row.get(5)?,
        state: row.get(6)?,
        ack_id: optional_id(row, 7)?,
        response_id: optional_id(row, 8)?,
        response: row.get(9)?,
        created_at: unsigned(row, 10)?,
    })
}

fn digest(credential: &Credential) -> [u8; 32] {
    Sha256::digest(credential.secret).into()
}

fn message(text: &str) -> Result<&str> {
    let text = text.trim();
    if text.is_empty() || text.len() > 4096 || text.contains('\0') {
        return Err("Enter a message of 1–4096 bytes.".into());
    }
    Ok(text)
}

fn paged<T: Serialize>(mut items: Vec<T>, offset: u32, limit: u32) -> Value {
    let next = (items.len() > limit as usize).then(|| offset.saturating_add(limit));
    items.truncate(limit as usize);
    json!({ "items": items, "nextOffset": next })
}

struct Denied;
impl std::fmt::Debug for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Denied")
    }
}
impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The pairing does not authorize this request.")
    }
}
impl std::error::Error for Denied {}

fn map_failure(error: Box<dyn std::error::Error + Send + Sync>) -> Failure {
    if error.is::<Denied>() {
        Failure::new("forbidden", error.to_string())
    } else if let Some(board_domain::Error::Conflict { current }) =
        error.downcast_ref::<board_domain::Error>()
    {
        Failure::current(*current, error.to_string())
    } else if error.is::<rusqlite::Error>() {
        Failure::new(
            "storage",
            "Board storage could not complete the request. Retry with the same operation ID.",
        )
    } else {
        Failure::new("invalid_request", error.to_string())
    }
}

impl Store {
    pub fn pair(
        &mut self,
        scope: Scope,
        label: &str,
        project_wide: bool,
        credential: &Credential,
    ) -> Result<Binding> {
        self.scoped(scope)?;
        let label = title(label)?;
        if label.len() > 120 {
            return Err("Enter a client name of up to 120 bytes.".into());
        }
        let board = (!project_wide).then_some(scope.board_id);
        let count: u32 = self.db.query_row(
            "SELECT count(*) FROM bindings WHERE project_id=?1 AND revoked_at IS NULL",
            [scope.project_id.to_string()],
            |row| row.get(0),
        )?;
        if count >= 64 {
            return Err("This project reached its active pairing limit.".into());
        }
        self.db.execute(
            "INSERT INTO bindings (id,project_id,board_id,label,secret_hash,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![credential.binding_id.to_string(), scope.project_id.to_string(), board.map(|id| id.to_string()),
                label, digest(credential).as_slice(), i64::try_from(now())?],
        )?;
        Ok(Binding {
            id: credential.binding_id,
            project_id: scope.project_id,
            board_id: board,
            label: label.to_owned(),
        })
    }

    pub fn bindings(&self, scope: Scope) -> Result<Vec<Binding>> {
        self.scoped(scope)?;
        let mut stmt = self.db.prepare(
            "SELECT id,project_id,board_id,label FROM bindings WHERE project_id=?1 AND (board_id IS NULL OR board_id=?2) AND revoked_at IS NULL ORDER BY created_at,id",
        )?;
        Ok(stmt
            .query_map(
                params![scope.project_id.to_string(), scope.board_id.to_string()],
                binding_row,
            )?
            .collect::<rusqlite::Result<_>>()?)
    }

    fn authenticate(&self, credential: &Credential) -> Result<Binding> {
        let (binding, secret): (Binding, Vec<u8>) = self.db.query_row(
            "SELECT id,project_id,board_id,label,secret_hash FROM bindings WHERE id=?1 AND revoked_at IS NULL",
            [credential.binding_id.to_string()], |row| Ok((binding_row(row)?, row.get(4)?)),
        ).optional()?.ok_or(Denied)?;
        if !bool::from(secret.as_slice().ct_eq(&digest(credential))) {
            return Err(Denied.into());
        }
        Ok(binding)
    }

    fn scoped_binding(&self, scope: Scope, binding: Id) -> Result<Binding> {
        self.scoped(scope)?;
        self.db.query_row(
            "SELECT id,project_id,board_id,label FROM bindings WHERE id=?1 AND project_id=?2 AND (board_id IS NULL OR board_id=?3) AND revoked_at IS NULL",
            params![binding.to_string(), scope.project_id.to_string(), scope.board_id.to_string()], binding_row,
        ).optional()?.ok_or_else(|| Denied.into())
    }

    fn revoke(&mut self, binding: Id) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE bindings SET revoked_at=?2 WHERE id=?1 AND revoked_at IS NULL",
            params![binding.to_string(), i64::try_from(now())?],
        )?;
        tx.execute(
            "UPDATE feedback SET state='cancelled' WHERE binding_id=?1 AND state='queued'",
            [binding.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn revoke_pairing(&mut self, scope: Scope, binding: Id) -> Result<()> {
        self.scoped_binding(scope, binding)?;
        self.revoke(binding)
    }

    fn authorize_board(&self, binding: &Binding, board: Id) -> Result<Board> {
        if binding.board_id.is_some_and(|allowed| allowed != board) {
            return Err(Denied.into());
        }
        self.board_info(binding.project_id, board).map_err(|error| {
            if error.is::<rusqlite::Error>() {
                error
            } else {
                Denied.into()
            }
        })
    }

    fn permitted_boards(&self, binding: &Binding, offset: u32) -> Result<Value> {
        if let Some(board) = binding.board_id {
            let info = self.authorize_board(binding, board)?;
            return Ok(paged(
                if offset == 0 { vec![info] } else { Vec::new() },
                offset,
                BOARD_PAGE,
            ));
        }
        let mut stmt = self.db.prepare(&format!(
            "SELECT {BOARD_COLUMNS} FROM boards WHERE project_id=?1 ORDER BY id LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = stmt
            .query_map(
                params![binding.project_id.to_string(), BOARD_PAGE + 1, offset],
                board_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(paged(rows, offset, BOARD_PAGE))
    }

    fn paired_open(&mut self, binding: &Binding, input: board_ipc::Open) -> Result<Board> {
        if input.project_id.is_some_and(|id| id != binding.project_id) {
            return Err(Denied.into());
        }
        match (input.board_id, input.title, input.operation_id) {
            (Some(board), None, None) => self.authorize_board(binding, board),
            (None, Some(name), Some(operation))
                if binding.board_id.is_none() && !operation.is_nil() =>
            {
                let title = title(&name)?;
                if let Some((actor, board, old_title)) = self
                    .db
                    .query_row(
                        "SELECT binding_id,board_id,title FROM board_creations WHERE id=?1",
                        [operation.to_string()],
                        |row| Ok((id(row, 0)?, id(row, 1)?, row.get::<_, String>(2)?)),
                    )
                    .optional()?
                {
                    if actor != binding.id || old_title != title {
                        return Err("Operation ID already belongs to another request.".into());
                    }
                    return self.authorize_board(binding, board);
                }
                let tx = self.db.transaction()?;
                let board = Self::insert_board(&tx, binding.project_id, title, None)?;
                tx.execute(
                    "INSERT INTO board_creations VALUES (?1,?2,?3,?4)",
                    params![
                        operation.to_string(),
                        binding.id.to_string(),
                        board.id.to_string(),
                        title
                    ],
                )?;
                tx.commit()?;
                Ok(board)
            }
            (None, Some(_), Some(_)) if binding.board_id.is_some() => Err(Denied.into()),
            _ => Err("Supply either a board ID or a title and operation ID.".into()),
        }
    }

    fn scene_page(&self, info: &Board, input: &board_ipc::Get) -> Result<Value> {
        let offset = input.offset.unwrap_or(0);
        if offset > 0 && input.revision != Some(info.semantic_revision) {
            return Err(board_domain::Error::Conflict {
                current: info.semantic_revision,
            }
            .into());
        }
        let (query, limit) = match input.section.unwrap_or(Section::Nodes) {
            Section::Nodes => (
                "SELECT body FROM nodes WHERE board_id=?1 ORDER BY id LIMIT ?2 OFFSET ?3",
                NODE_PAGE,
            ),
            Section::Edges => (
                "SELECT body FROM edges WHERE board_id=?1 ORDER BY id LIMIT ?2 OFFSET ?3",
                EDGE_PAGE,
            ),
        };
        let mut stmt = self.db.prepare(query)?;
        let mut rows = stmt.query(params![info.id.to_string(), limit + 1, offset])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(serde_json::from_str::<Value>(&row.get::<_, String>(0)?)?);
        }
        Ok(
            json!({ "board": info, "section": input.section.unwrap_or(Section::Nodes),
            "page": paged(items, offset, limit) }),
        )
    }

    pub fn desktop_deltas(&self, scope: Scope, after: u64) -> Result<DeltaPage> {
        let active = self.scoped(scope)?;
        self.deltas(scope.board_id, active.board.semantic_revision, after)
    }

    fn deltas(&self, board: Id, revision: u64, after: u64) -> Result<DeltaPage> {
        if after > revision {
            return Err(board_domain::Error::Conflict { current: revision }.into());
        }
        let mut stmt = self.db.prepare(
            "SELECT response FROM receipts WHERE board_id=?1 AND revision>?2 ORDER BY revision LIMIT ?3",
        )?;
        let mut rows = stmt.query(params![
            board.to_string(),
            i64::try_from(after)?,
            DELTA_PAGE as u32
        ])?;
        let mut deltas = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let delta = Delta::from(serde_json::from_str::<Receipt>(&row.get::<_, String>(0)?)?);
            let size = serde_json::to_vec(&delta)?.len();
            if bytes > 0 && bytes + size > DELTA_BYTES {
                break;
            }
            if size > board_ipc::MAX_REPLY / 2 {
                return Err("This revision requires a paginated snapshot.".into());
            }
            bytes += size;
            deltas.push(delta);
        }
        let next_revision = deltas.last().map_or(after, |delta| delta.revision);
        Ok(DeltaPage {
            revision,
            deltas,
            next_revision,
        })
    }

    pub fn queue_feedback(
        &mut self,
        scope: Scope,
        recipient: Id,
        id: Id,
        text: &str,
    ) -> Result<Feedback> {
        self.scoped_binding(scope, recipient)?;
        let revision = self.scoped(scope)?.board.semantic_revision;
        let text = message(text)?;
        if id.is_nil() {
            return Err("A feedback ID is required.".into());
        }
        if let Some(prior) = self
            .db
            .query_row(
                &format!("SELECT {FEEDBACK_COLUMNS} FROM feedback WHERE id=?1"),
                [id.to_string()],
                feedback_row,
            )
            .optional()?
        {
            if prior.binding_id != recipient
                || prior.board_id != scope.board_id
                || prior.text != text
            {
                return Err("Feedback ID already belongs to another request.".into());
            }
            return Ok(prior);
        }
        let pending: u32 = self.db.query_row(
            "SELECT count(*) FROM feedback WHERE binding_id=?1 AND board_id=?2 AND state IN ('queued','offered')",
            params![recipient.to_string(), scope.board_id.to_string()], |row| row.get(0),
        )?;
        if pending >= FEEDBACK_LIMIT {
            return Err("The feedback queue is full for this client and board.".into());
        }
        Ok(self.db.query_row(
            &format!("INSERT INTO feedback (id,binding_id,board_id,revision,text,state,created_at) VALUES (?1,?2,?3,?4,?5,'queued',?6) RETURNING {FEEDBACK_COLUMNS}"),
            params![id.to_string(), recipient.to_string(), scope.board_id.to_string(), i64::try_from(revision)?, text, i64::try_from(now())?],
            feedback_row,
        )?)
    }

    pub fn desktop_feedback(&self, scope: Scope, before: Option<u64>) -> Result<Vec<Feedback>> {
        self.scoped(scope)?;
        let mut stmt = self.db.prepare(
            &format!("SELECT {FEEDBACK_COLUMNS} FROM feedback WHERE board_id=?1 AND sequence<?2 ORDER BY sequence DESC LIMIT ?3"),
        )?;
        Ok(stmt
            .query_map(
                params![
                    scope.board_id.to_string(),
                    i64::try_from(before.unwrap_or(i64::MAX as u64))?,
                    FEEDBACK_PAGE
                ],
                feedback_row,
            )?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn cancel_feedback(&mut self, scope: Scope, id: Id) -> Result<()> {
        self.scoped(scope)?;
        let changed = self.db.execute("UPDATE feedback SET state='cancelled' WHERE id=?1 AND board_id=?2 AND state IN ('queued','cancelled')",
            params![id.to_string(), scope.board_id.to_string()])?;
        if changed == 0 {
            return Err("Only queued feedback can be cancelled.".into());
        }
        Ok(())
    }

    fn read_feedback(&mut self, binding: &Binding, board: Id, after: u64) -> Result<(Value, bool)> {
        let tx = self.db.transaction()?;
        let mut items = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {FEEDBACK_COLUMNS} FROM feedback WHERE binding_id=?1 AND board_id=?2 AND sequence>?3 AND state!='cancelled' ORDER BY sequence LIMIT ?4"
            ))?;
            stmt.query_map(
                params![
                    binding.id.to_string(),
                    board.to_string(),
                    i64::try_from(after)?,
                    FEEDBACK_PAGE
                ],
                feedback_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut changed = false;
        for item in items.iter_mut().filter(|item| item.state == "queued") {
            changed = true;
            tx.execute(
                "UPDATE feedback SET state='offered' WHERE id=?1",
                [item.id.to_string()],
            )?;
            item.state = "offered".to_owned();
        }
        tx.commit()?;
        let next = items.last().map_or(after, |item| item.sequence);
        Ok((json!({ "items": items, "nextCursor": next }), changed))
    }

    fn recipient_feedback(&self, binding: &Binding, board: Id, feedback: Id) -> Result<Feedback> {
        self.db.query_row(&format!("SELECT {FEEDBACK_COLUMNS} FROM feedback WHERE id=?1 AND binding_id=?2 AND board_id=?3"),
            params![feedback.to_string(), binding.id.to_string(), board.to_string()], feedback_row).optional()?.ok_or_else(|| Denied.into())
    }

    fn acknowledge(&mut self, binding: &Binding, ack: board_ipc::Ack) -> Result<Feedback> {
        if ack.operation_id.is_nil() {
            return Err("An acknowledgement ID is required.".into());
        }
        let item = self.recipient_feedback(binding, ack.board_id, ack.feedback_id)?;
        if item.ack_id == Some(ack.operation_id) {
            return Ok(item);
        }
        if item.state != "offered" {
            return Err("Feedback must be offered before it can be acknowledged.".into());
        }
        Ok(self.db.query_row(
            &format!("UPDATE feedback SET state='acknowledged',ack_id=?2 WHERE id=?1 RETURNING {FEEDBACK_COLUMNS}"),
            params![ack.feedback_id.to_string(), ack.operation_id.to_string()], feedback_row,
        )?)
    }

    fn response(&mut self, binding: &Binding, post: board_ipc::Post) -> Result<Feedback> {
        if post.operation_id.is_nil() {
            return Err("A response ID is required.".into());
        }
        let text = message(&post.text)?;
        let item = self.recipient_feedback(binding, post.board_id, post.feedback_id)?;
        if item.ack_id != Some(post.ack_id) {
            return Err("The acknowledgement ID does not match this feedback.".into());
        }
        if let Some(prior) = item.response_id {
            if prior == post.operation_id && item.response.as_deref() == Some(text) {
                return Ok(item);
            }
            return Err("This feedback already has a response.".into());
        }
        Ok(self.db.query_row(
            &format!("UPDATE feedback SET response_id=?2,response=?3 WHERE id=?1 RETURNING {FEEDBACK_COLUMNS}"),
            params![post.feedback_id.to_string(), post.operation_id.to_string(), text], feedback_row,
        )?)
    }

    pub fn bridge(
        &mut self,
        request: Request,
    ) -> std::result::Result<(Value, Option<BoardUpdate>), Failure> {
        if request.version != VERSION {
            return Err(Failure::new("version", "Unsupported desktop IPC version."));
        }
        if request.request_id.is_nil() {
            return Err(Failure::new("invalid_request", "A request ID is required."));
        }
        self.dispatch(request).map_err(map_failure)
    }

    fn dispatch(&mut self, request: Request) -> Result<(Value, Option<BoardUpdate>)> {
        let binding = self.authenticate(&request.credential)?;
        if matches!(request.call, Call::Revoke(_)) {
            self.revoke(binding.id)?;
            return Ok((json!({ "revoked": true }), Some(BoardUpdate::Bindings)));
        }
        self.project_available(binding.project_id)?;
        let value = match request.call {
            Call::BoardList(input) => {
                if input.project_id.is_some_and(|id| id != binding.project_id) {
                    return Err(Denied.into());
                }
                self.permitted_boards(&binding, input.offset.unwrap_or(0))?
            }
            Call::BoardOpen(input) => json!(self.paired_open(&binding, input)?),
            Call::BoardGet(input) => {
                let board = self.authorize_board(&binding, input.board_id)?;
                if let Some(after) = input.since_revision {
                    if input.offset.is_some() || input.section.is_some() || input.revision.is_some()
                    {
                        return Err("Use either a snapshot page or a revision cursor.".into());
                    }
                    json!(self.deltas(board.id, board.semantic_revision, after)?)
                } else {
                    self.scene_page(&board, &input)?
                }
            }
            Call::BoardApply(input) => {
                self.authorize_board(&binding, input.board_id)?;
                let request = bounded_json(&input.operation)?;
                if request.len() > MAX_OPERATION_BYTES {
                    return Err("Operation exceeds 128 KiB.".into());
                }
                let result = self.apply_as(Mutation {
                    project: binding.project_id,
                    board: input.board_id,
                    actor: Some(binding.id),
                    id: input.operation.id,
                    request,
                    input: MutationInput::Operation(input.operation),
                })?;
                return delta_result(result);
            }
            Call::BoardSetTaskStatus(input) => {
                self.authorize_board(&binding, input.board_id)?;
                let request = bounded_json(&input)?;
                let result = self.apply_as(Mutation {
                    project: binding.project_id,
                    board: input.board_id,
                    actor: Some(binding.id),
                    id: input.operation_id,
                    request,
                    input: MutationInput::Status {
                        task: input.task_id,
                        status: input.status,
                        expected: input.expected_revision,
                    },
                })?;
                return delta_result(result);
            }
            Call::BoardGetFeedback(input) => {
                self.authorize_board(&binding, input.board_id)?;
                let (page, changed) =
                    self.read_feedback(&binding, input.board_id, input.after.unwrap_or(0))?;
                return Ok((
                    page,
                    changed.then_some(BoardUpdate::Feedback(input.board_id)),
                ));
            }
            Call::BoardAckFeedback(input) => {
                self.authorize_board(&binding, input.board_id)?;
                let feedback = self.acknowledge(&binding, input)?;
                return Ok((
                    json!(feedback),
                    Some(BoardUpdate::Feedback(feedback.board_id)),
                ));
            }
            Call::BoardPostResponse(input) => {
                self.authorize_board(&binding, input.board_id)?;
                let feedback = self.response(&binding, input)?;
                return Ok((
                    json!(feedback),
                    Some(BoardUpdate::Feedback(feedback.board_id)),
                ));
            }
            Call::BoardSessionState(_) => json!({
                "binding": binding, "connection": "connected",
                "feedback": "portable_tools", "liveSteering": "unsupported",
            }),
            Call::Revoke(_) => unreachable!("handled before validating the project root"),
        };
        Ok((value, None))
    }
}

fn delta_result(commit: Commit) -> Result<(Value, Option<BoardUpdate>)> {
    let delta = Delta::from(commit.receipt);
    let value = serde_json::to_value(&delta)?;
    Ok((
        value,
        commit.scope.map(|scope| BoardUpdate::Revision {
            scope,
            revision: delta.revision,
        }),
    ))
}
