use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewWindowBuilder, WindowEvent};

mod board_skill;
mod bridge;
mod commands;
mod file_dialog;
mod mcp_setup;
mod preferences;
mod updates;

fn main() -> tauri::Result<()> {
    #[cfg(feature = "combined-mcp")]
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "mcp") {
        raqsh_mcp::main_entry(std::env::args_os().skip(2), true)?;
        return Ok(());
    }

    #[cfg(all(target_os = "macos", feature = "macos-live-test"))]
    let live_test = std::env::args().find_map(|arg| match arg.as_str() {
        "--macos-live=edit" => Some("edit"),
        "--macos-live=provider" => Some("provider"),
        "--macos-live=about" => Some("about"),
        "--macos-live=sync-card" => Some("sync-card"),
        "--macos-live=feedback-history" => Some("feedback-history"),
        "--macos-live=updater" => Some("updater"),
        "--macos-live=screenshot" => Some("screenshot"),
        "--macos-live=screenshot-agents" => Some("screenshot-agents"),
        "--macos-live=reopen" => Some("reopen"),
        "--macos-live=reopen-edits" => Some("reopen-edits"),
        "--macos-live=legacy" => Some("legacy"),
        "--macos-live=stress" => Some("stress"),
        _ => None,
    });
    #[cfg(all(target_os = "macos", feature = "macos-live-test"))]
    if live_test == Some("updater") {
        let executable = std::env::current_exe()?;
        let contents = executable.parent().and_then(std::path::Path::parent);
        if contents.is_some_and(|path| path.join("Resources/update-fixture").is_file())
            && let Some(result) = std::env::args().find_map(|arg| {
                arg.strip_prefix("--update-fixture-result=")
                    .map(str::to_owned)
            })
        {
            std::fs::write(result, "restarted")?;
            return Ok(());
        }
    }
    #[cfg(all(target_os = "macos", feature = "macos-live-test"))]
    let live_library = if live_test.is_some() {
        if std::env::var_os("RAQSH_TEST_LIBRARY").is_none()
            || std::env::var_os("RAQSH_RUNTIME_DIR").is_none()
        {
            return Err(std::io::Error::other(
                "The macOS live test requires an isolated library and runtime directory",
            )
            .into());
        }
        Some(board_ipc::default_library()?)
    } else {
        None
    };
    let (socket_owner, socket) = board_ipc::SocketOwner::bind()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    tauri::async_runtime::set(runtime.handle().clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_preferences,
            commands::save_preferences,
            commands::list_projects,
            commands::choose_project,
            commands::list_boards,
            commands::create_board,
            commands::rename_board,
            commands::delete_board,
            commands::open_board,
            commands::close_board,
            commands::apply_operation,
            commands::save_drawing,
            commands::export_board,
            commands::export_preview,
            commands::import_board,
            commands::open_benchmark,
            commands::finish_close,
            commands::open_about_link,
            commands::pair_client,
            commands::mcp_clients,
            commands::install_board_skill,
            commands::save_board_skill,
            commands::connect_client,
            commands::client_config,
            commands::list_bindings,
            commands::revoke_client,
            commands::queue_feedback,
            commands::list_feedback,
            commands::cancel_feedback,
            commands::board_deltas,
            updates::update_info,
            updates::check_update,
            updates::download_update,
            updates::install_update,
            updates::restart_updated,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let desktop = window.state::<commands::Desktop>();
                if !desktop.permit_close.swap(false, Ordering::AcqRel) {
                    api.prevent_close();
                    let _ = window.emit_to("main", "desktop-close-requested", ());
                }
            }
        })
        .setup(move |app| {
            let library = app.path().app_data_dir()?.join("library");
            #[cfg(all(target_os = "macos", feature = "macos-live-test"))]
            let library = live_library.unwrap_or(library);
            app.manage(commands::Desktop::start(library)?);
            app.manage(bridge::RuntimeBridge::start(
                app.handle().clone(),
                socket_owner,
                socket,
            )?);
            let config = app.config();
            let dev_origin = if cfg!(feature = "custom-protocol") {
                None
            } else {
                config.build.dev_url.as_ref().map(|url| url.origin())
            };

            let mut window = WebviewWindowBuilder::from_config(app, &config.app.windows[0])?
                .disable_drag_drop_handler()
                .enable_clipboard_access()
                .on_navigation(move |url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || dev_origin.as_ref() == Some(&url.origin())
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            if let Some(fixture) = std::env::args().find_map(|arg| match arg.as_str() {
                "--fixture=empty" => Some("empty"),
                "--fixture=tiny" => Some("tiny"),
                "--fixture=ordinary" => Some("ordinary"),
                "--fixture=normal" => Some("normal"),
                "--fixture=stress" => Some("stress"),
                "--fixture=showcase" => Some("showcase"),
                _ => None,
            }) {
                window = window
                    .initialization_script(format!("window.__BOARD_FIXTURE__ = '{fixture}';"));
            }
            #[cfg(all(target_os = "macos", feature = "macos-live-test"))]
            if let Some(mode) = live_test {
                let script = include_str!("../../../../bench/scripts/macos-live.js");
                let provider = match std::env::var("RAQSH_TEST_PROVIDER").as_deref() {
                    Ok("codex") => "codex",
                    Ok("claude") => "claude",
                    _ => "generic",
                };
                window = window
                    .initialization_script(format!(
                        "window.__RAQSH_LIVE_MODE__ = '{mode}'; window.__RAQSH_LIVE_PROVIDER__ = '{provider}';\n{script}"
                    ))
                    .on_document_title_changed(|window, title| {
                        if let Some(report) = title.strip_prefix("raqsh-live:") {
                            println!("raqsh-live:{report}");
                            if report.starts_with("{\"event\":\"pass\"") {
                                let _ = window.close();
                            }
                        }
                    });
            }
            let _window = window.build()?;
            #[cfg(target_os = "linux")]
            _window.with_webview(|webview| {
                use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};
                if let Some(settings) = webview.inner().settings() {
                    settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
                }
            })?;
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<bridge::RuntimeBridge>().stop();
            }
        });
    Ok(())
}
