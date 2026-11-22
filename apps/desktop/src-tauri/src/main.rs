use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewWindowBuilder, WindowEvent};

mod bridge;
mod commands;
mod file_dialog;

fn main() -> tauri::Result<()> {
    #[cfg(feature = "combined-mcp")]
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "mcp") {
        visual_board_mcp::main_entry(std::env::args_os().skip(2), true)?;
        return Ok(());
    }

    let (socket_owner, socket) = board_ipc::SocketOwner::bind()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    tauri::async_runtime::set(runtime.handle().clone());
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
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
            commands::pair_client,
            commands::list_bindings,
            commands::revoke_client,
            commands::queue_feedback,
            commands::list_feedback,
            commands::cancel_feedback,
            commands::board_deltas,
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
            app.manage(commands::Desktop::start(
                app.path().app_data_dir()?.join("library"),
            )?);
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
                _ => None,
            }) {
                window = window
                    .initialization_script(format!("window.__BOARD_FIXTURE__ = '{fixture}';"));
            }
            let window = window.build()?;
            #[cfg(target_os = "linux")]
            window.with_webview(|webview| {
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
