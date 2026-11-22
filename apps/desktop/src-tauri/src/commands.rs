use board_domain::{Board, Drawing, Id, Operation, Project};
use board_store::{OpenBoard, Page, Scope, Store};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    time::Instant,
};
use tauri::{
    State, WebviewWindow,
    ipc::{InvokeBody, Request},
};
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce(&mut board_store::Result<Store>) + Send>;
type Reply<T> = Result<T, String>;

pub struct Desktop {
    queue: SyncSender<Job>,
    library: PathBuf,
    pub permit_close: AtomicBool,
}

impl Desktop {
    pub fn start(library: PathBuf) -> std::io::Result<Self> {
        let (queue, mailbox) = mpsc::sync_channel::<Job>(8);
        let path = library.join("boards.sqlite3");
        std::thread::Builder::new()
            .name("board-store".into())
            .spawn(move || {
                let mut store = Store::open(&path);
                for job in mailbox {
                    job(&mut store);
                }
            })?;
        Ok(Self {
            queue,
            library,
            permit_close: AtomicBool::new(false),
        })
    }

    pub(crate) async fn call<T: Send + 'static>(
        &self,
        task: impl FnOnce(&mut Store) -> board_store::Result<T> + Send + 'static,
    ) -> Reply<T> {
        let (send, reply) = oneshot::channel();
        self.queue
            .try_send(Box::new(move |store| {
                let result = match store {
                    Ok(store) => task(store).map_err(|error| error.to_string()),
                    Err(error) => Err(format!("Could not open the local board database. {error}")),
                };
                let _ = send.send(result);
            }))
            .map_err(|_| "Board storage is busy. Try again.".to_owned())?;
        reply
            .await
            .map_err(|_| "Board storage stopped responding.".to_owned())?
    }
}

#[tauri::command]
pub async fn list_projects(state: State<'_, Desktop>, offset: u32) -> Reply<Page<Project>> {
    state.call(move |store| store.projects(offset)).await
}

#[tauri::command]
pub async fn choose_project(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    relocate: Option<Id>,
) -> Reply<Option<Project>> {
    let Some(path) = crate::file_dialog::choose(window, None).await? else {
        return Ok(None);
    };
    state
        .call(move |store| match relocate {
            Some(project) => store.relocate_project(project, &path),
            None => store.add_project(&path),
        })
        .await
        .map(Some)
}

#[tauri::command]
pub async fn list_boards(
    state: State<'_, Desktop>,
    project: Id,
    offset: u32,
) -> Reply<Page<Board>> {
    state.call(move |store| store.boards(project, offset)).await
}

#[tauri::command]
pub async fn create_board(state: State<'_, Desktop>, project: Id, title: String) -> Reply<Board> {
    state
        .call(move |store| store.create_board(project, &title))
        .await
}

#[tauri::command]
pub async fn rename_board(
    state: State<'_, Desktop>,
    project: Id,
    board: Id,
    title: String,
) -> Reply<Board> {
    state
        .call(move |store| store.rename_board(project, board, &title))
        .await
}

#[tauri::command]
pub async fn delete_board(state: State<'_, Desktop>, project: Id, board: Id) -> Reply<()> {
    state
        .call(move |store| store.delete_board(project, board))
        .await
}

#[tauri::command]
pub async fn open_board(state: State<'_, Desktop>, project: Id, board: Id) -> Reply<OpenBoard> {
    state
        .call(move |store| store.open_board(project, board))
        .await
}

#[tauri::command]
pub async fn close_board(state: State<'_, Desktop>, scope: Scope) -> Reply<()> {
    state.call(move |store| store.close_board(scope)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResponse {
    #[serde(flatten)]
    receipt: board_domain::Receipt,
    queue_micros: u64,
    storage_micros: u64,
    sqlite_commit_micros: u64,
}

#[tauri::command]
pub async fn apply_operation(
    state: State<'_, Desktop>,
    scope: Scope,
    operation: Operation,
) -> Reply<OperationResponse> {
    let queued = Instant::now();
    state
        .call(move |store| {
            let start = Instant::now();
            let queue_micros = (start - queued).as_micros() as u64;
            let (receipt, sqlite_commit_micros) = store.apply_timed(scope, operation)?;
            Ok(OperationResponse {
                receipt,
                queue_micros,
                storage_micros: start.elapsed().as_micros() as u64,
                sqlite_commit_micros,
            })
        })
        .await
}

#[tauri::command]
pub async fn save_drawing(
    state: State<'_, Desktop>,
    scope: Scope,
    expected: u64,
    generation: u64,
    drawing: Drawing,
) -> Reply<u64> {
    state
        .call(move |store| store.save_drawing(scope, expected, generation, drawing))
        .await
}

#[tauri::command]
pub async fn export_board(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    scope: Scope,
) -> Reply<bool> {
    let document = state.call(move |store| store.export(scope)).await?;
    save_file(window, "visualboard", document.into_bytes()).await
}

#[tauri::command]
pub async fn export_preview(window: WebviewWindow, request: Request<'_>) -> Reply<bool> {
    let format = match request
        .headers()
        .get("x-board-image")
        .and_then(|header| header.to_str().ok())
    {
        Some("png") => "png",
        Some("svg") => "svg",
        _ => return Err("Unsupported image format.".into()),
    };
    let InvokeBody::Raw(payload) = request.body() else {
        return Err("Expected image data.".into());
    };
    if payload.len() > 24 * 1024 * 1024 {
        return Err("Image exceeds the export size limit.".into());
    }
    save_file(window, format, payload.clone()).await
}

async fn save_file(window: WebviewWindow, suffix: &'static str, data: Vec<u8>) -> Reply<bool> {
    let Some(destination) = crate::file_dialog::choose(window, Some(suffix)).await? else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || write_export(&destination, &data))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("Could not write the export. {error}"))?;
    Ok(true)
}

fn write_export(destination: &Path, data: &[u8]) -> std::io::Result<()> {
    let temporary = destination.with_file_name(format!(".visualboard-export-{}.tmp", Id::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = file.write_all(data).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| std::fs::rename(&temporary, destination));
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[tauri::command]
pub async fn import_board(state: State<'_, Desktop>, project: Id, input: String) -> Reply<Board> {
    if input.len() > board_domain::MAX_DOCUMENT_BYTES {
        return Err("Board file exceeds the 8 MiB limit.".into());
    }
    state.call(move |store| store.import(project, &input)).await
}

#[tauri::command]
pub async fn open_benchmark(
    state: State<'_, Desktop>,
    fixture: String,
    input: String,
) -> Reply<OpenBoard> {
    let root = std::env::var_os("VISUAL_BOARD_BENCH_PROJECT")
        .ok_or("Benchmark project was not enabled at launch.")?;
    if !matches!(
        fixture.as_str(),
        "empty" | "tiny" | "ordinary" | "normal" | "stress"
    ) {
        return Err("Unknown benchmark fixture.".into());
    }
    let root = PathBuf::from(root);
    state
        .call(move |store| {
            let project = store.add_project(&root)?;
            let board = store
                .boards(project.id, 0)?
                .items
                .into_iter()
                .find(|board| board.title == fixture);
            let board = match board {
                Some(board) => board,
                None => store.import(project.id, &input)?,
            };
            store.open_board(project.id, board.id)
        })
        .await
}

#[tauri::command]
pub fn finish_close(window: WebviewWindow, state: State<'_, Desktop>) -> Reply<()> {
    state.permit_close.store(true, Ordering::Release);
    window.close().map_err(|error| {
        state.permit_close.store(false, Ordering::Release);
        error.to_string()
    })
}

#[tauri::command]
pub async fn pair_client(
    state: State<'_, Desktop>,
    scope: Scope,
    label: String,
    project_wide: bool,
) -> Reply<board_store::bridge::Binding> {
    let library = state.library.clone();
    state
        .call(move |store| {
            let credential = board_ipc::Credential::new()?;
            let binding = store.pair(scope, &label, project_wide, &credential)?;
            if let Err(error) = board_ipc::save_credential(&library, &credential) {
                store.revoke_pairing(scope, binding.id)?;
                return Err(error.into());
            }
            Ok(binding)
        })
        .await
}

#[tauri::command]
pub async fn list_bindings(
    state: State<'_, Desktop>,
    scope: Scope,
) -> Reply<Vec<board_store::bridge::Binding>> {
    state.call(move |store| store.bindings(scope)).await
}

#[tauri::command]
pub async fn revoke_client(state: State<'_, Desktop>, scope: Scope, binding: Id) -> Reply<()> {
    let library = state.library.clone();
    state
        .call(move |store| {
            store.revoke_pairing(scope, binding)?;
            board_ipc::remove_credential(&library, binding)?;
            Ok(())
        })
        .await
}

#[tauri::command]
pub async fn queue_feedback(
    state: State<'_, Desktop>,
    scope: Scope,
    binding: Id,
    id: Id,
    text: String,
) -> Reply<board_store::bridge::Feedback> {
    state
        .call(move |store| store.queue_feedback(scope, binding, id, &text))
        .await
}

#[tauri::command]
pub async fn list_feedback(
    state: State<'_, Desktop>,
    scope: Scope,
    before: Option<u64>,
) -> Reply<Vec<board_store::bridge::Feedback>> {
    state
        .call(move |store| store.desktop_feedback(scope, before))
        .await
}

#[tauri::command]
pub async fn cancel_feedback(state: State<'_, Desktop>, scope: Scope, id: Id) -> Reply<()> {
    state
        .call(move |store| store.cancel_feedback(scope, id))
        .await
}

#[tauri::command]
pub async fn board_deltas(
    state: State<'_, Desktop>,
    scope: Scope,
    since: u64,
) -> Reply<board_store::bridge::DeltaPage> {
    state
        .call(move |store| store.desktop_deltas(scope, since))
        .await
}
