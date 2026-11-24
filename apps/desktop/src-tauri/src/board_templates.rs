use crate::{
    commands::{Desktop, save_file},
    file_dialog::Save,
};
use board_domain::{Board, Id};
use board_store::{
    Page, Scope,
    templates::{TemplateDocument, TemplateInfo},
};
use tauri::{State, WebviewWindow};

#[tauri::command]
pub async fn capture_board_template(
    state: State<'_, Desktop>,
    scope: Scope,
) -> Result<TemplateDocument, String> {
    state
        .call(move |store| store.capture_board_template(scope))
        .await
}

#[tauri::command]
pub async fn save_board_template(
    state: State<'_, Desktop>,
    id: Id,
    document: TemplateDocument,
) -> Result<TemplateInfo, String> {
    state
        .call(move |store| store.save_board_template(id, document))
        .await
}

#[tauri::command]
pub async fn update_board_template(
    state: State<'_, Desktop>,
    id: Id,
    expected: TemplateDocument,
    document: TemplateDocument,
) -> Result<TemplateDocument, String> {
    state
        .call(move |store| store.update_board_template(id, expected, document))
        .await
}

#[tauri::command]
pub async fn list_board_templates(
    state: State<'_, Desktop>,
    offset: u32,
) -> Result<Page<TemplateInfo>, String> {
    state.call(move |store| store.board_templates(offset)).await
}

#[tauri::command]
pub async fn read_board_template(
    state: State<'_, Desktop>,
    id: Id,
) -> Result<TemplateDocument, String> {
    state
        .call(move |store| TemplateDocument::parse(&store.read_board_template(id)?))
        .await
}

#[tauri::command]
pub async fn decode_board_template(input: String) -> Result<TemplateDocument, String> {
    tauri::async_runtime::spawn_blocking(move || TemplateDocument::parse(&input))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("Could not read the template. {error}"))
}

#[tauri::command]
pub async fn export_board_template(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    id: Id,
) -> Result<bool, String> {
    let document = state
        .call(move |store| store.read_board_template(id))
        .await?;
    save_file(
        window,
        Save {
            title: "Export template",
            filename: "template.raqsh-template",
            suffix: "raqsh-template",
        },
        document.into_bytes(),
    )
    .await
}

#[tauri::command]
pub async fn new_board_from_template(
    state: State<'_, Desktop>,
    project: Id,
    id: Id,
    title: String,
) -> Result<Board, String> {
    state
        .call(move |store| store.new_board_from_template(project, id, &title))
        .await
}
