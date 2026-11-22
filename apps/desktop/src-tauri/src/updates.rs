use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tauri::{
    AppHandle, State,
    utils::{config::BundleType, platform::bundle_type},
};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const RELEASES: &str = "https://github.com/MohamedElashri/raqsh/releases/download";
const PUBLIC_KEY: Option<&str> = option_env!("RAQSH_UPDATER_PUBLIC_KEY");

fn public_key() -> Option<String> {
    #[cfg(all(target_os = "macos", feature = "macos-live-test"))]
    if fixture_origin().is_some() {
        return std::env::var("VISUAL_BOARD_TEST_UPDATE_KEY").ok();
    }
    PUBLIC_KEY
        .filter(|key| !key.trim().is_empty())
        .map(str::to_owned)
}

#[cfg(all(target_os = "macos", feature = "macos-live-test"))]
fn fixture_origin() -> Option<String> {
    if !std::env::args_os().any(|arg| arg == "--macos-live=updater") {
        return None;
    }
    let port: u16 = std::env::var("VISUAL_BOARD_TEST_UPDATE_PORT")
        .ok()?
        .parse()
        .ok()?;
    Some(format!("https://127.0.0.1:{port}"))
}

#[derive(Default)]
pub struct Updates(Mutex<Session>);

#[derive(Default)]
enum Session {
    #[default]
    Idle,
    Current,
    Available(Box<Update>),
    Downloaded(Box<Update>, Arc<Vec<u8>>),
    Installed(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    version: Option<String>,
    stage: &'static str,
}

fn package_asset() -> Option<&'static str> {
    match bundle_type() {
        Some(BundleType::App) => Some("raqsh-macos-universal.app.tar.gz"),
        Some(BundleType::Deb) => Some("raqsh-linux-x86_64.deb"),
        Some(BundleType::Rpm) => Some("raqsh-linux-x86_64.rpm"),
        _ => None,
    }
}

impl Session {
    fn info(&self, app: &AppHandle) -> UpdateInfo {
        let (stage, version) = match self {
            Self::Idle if package_asset().is_none() || public_key().is_none() => ("disabled", None),
            Self::Idle => ("idle", None),
            Self::Current => ("current", None),
            Self::Available(update) => ("available", Some(update.version.clone())),
            Self::Downloaded(update, _) => ("downloaded", Some(update.version.clone())),
            Self::Installed(version) => ("installed", Some(version.clone())),
        };
        UpdateInfo {
            current_version: app.package_info().version.to_string(),
            version,
            stage,
        }
    }
}

#[tauri::command]
pub async fn update_info(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<UpdateInfo, String> {
    Ok(updates.0.lock().await.info(&app))
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<UpdateInfo, String> {
    let mut session = updates
        .0
        .try_lock()
        .map_err(|_| "An update action is already running.")?;
    if matches!(*session, Session::Downloaded(..) | Session::Installed(_)) {
        return Ok(session.info(&app));
    }
    let (Some(asset), Some(key)) = (package_asset(), public_key()) else {
        return Err("Updates require a signed release build of Raqsh.".into());
    };
    let builder = app
        .updater_builder()
        .pubkey(key)
        .version_comparator(|current, release| {
            release.version.pre.is_empty() && release.version > current
        })
        .timeout(Duration::from_secs(15))
        .configure_client(|client| client.https_only(true));
    let release_root = RELEASES.to_owned();
    #[cfg(all(target_os = "macos", feature = "macos-live-test"))]
    let (builder, release_root) = if let Some(origin) = fixture_origin() {
        let endpoint = format!("{origin}/latest.json")
            .parse::<tauri::Url>()
            .map_err(|error| error.to_string())?;
        let builder = builder
            .endpoints(vec![endpoint])
            .map_err(|error| error.to_string())?
            .configure_client(|client| {
                client
                    .https_only(true)
                    .danger_accept_invalid_certs(true)
                    .danger_accept_invalid_hostnames(true)
                    .no_proxy()
            });
        (builder, format!("{origin}/download"))
    } else {
        (builder, release_root)
    };
    let result = builder
        .build()
        .map_err(|error| format!("Could not start the update check. {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check GitHub for updates. {error}"))?;
    *session = if let Some(mut update) = result {
        let expected = format!("{release_root}/v{}/{asset}", update.version);
        if update.download_url.as_str() != expected {
            return Err("The update points to an unexpected release asset.".into());
        }
        update.timeout = Some(Duration::from_secs(120));
        Session::Available(Box::new(update))
    } else {
        Session::Current
    };
    Ok(session.info(&app))
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<UpdateInfo, String> {
    let mut session = updates
        .0
        .try_lock()
        .map_err(|_| "An update action is already running.")?;
    let Session::Available(update) = &*session else {
        return Err("Check for an available update first.".into());
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Could not download and verify the update. {error}"))?;
    *session = Session::Downloaded(update.clone(), Arc::new(bytes));
    Ok(session.info(&app))
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<UpdateInfo, String> {
    let mut session = updates
        .0
        .try_lock()
        .map_err(|_| "An update action is already running.")?;
    let Session::Downloaded(update, bytes) = &*session else {
        return Err("Download the update first.".into());
    };
    let installer = update.clone();
    let package = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || installer.install(package.as_slice()))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("Could not install the update. {error}"))?;
    *session = Session::Installed(update.version.clone());
    Ok(session.info(&app))
}

#[tauri::command]
pub async fn restart_updated(app: AppHandle, updates: State<'_, Updates>) -> Result<(), String> {
    if !matches!(
        *updates
            .0
            .try_lock()
            .map_err(|_| "An update action is already running.")?,
        Session::Installed(_)
    ) {
        return Err("Install the update first.".into());
    }
    app.request_restart();
    Ok(())
}
