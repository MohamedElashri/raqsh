use crate::commands::{Desktop, Reply, open_web_link};
use board_domain::{
    Id,
    verification::{CardVerification, VerificationDraft},
};
use board_store::Scope;
use tauri::State;

#[tauri::command]
pub async fn list_verification(
    state: State<'_, Desktop>,
    scope: Scope,
) -> Reply<Vec<CardVerification>> {
    state
        .call(move |store| store.board_verification(scope))
        .await
}

#[tauri::command]
pub async fn save_verification(
    state: State<'_, Desktop>,
    scope: Scope,
    card: Id,
    id: Id,
    check: VerificationDraft,
) -> Reply<CardVerification> {
    state
        .call(move |store| store.record_verification(scope, card, id, check))
        .await
}

#[tauri::command]
pub async fn remove_verification(
    state: State<'_, Desktop>,
    scope: Scope,
    card: Id,
    id: Id,
) -> Reply<()> {
    state
        .call(move |store| store.remove_verification(scope, card, id))
        .await
}

#[tauri::command]
pub async fn open_verification_reference(
    state: State<'_, Desktop>,
    scope: Scope,
    id: Id,
) -> Reply<()> {
    let link = state
        .call(move |store| store.verification_reference(scope, id))
        .await?;
    open_web_link(link).await
}
