use std::path::PathBuf;
use tauri::WebviewWindow;

pub struct Save {
    pub title: &'static str,
    pub filename: &'static str,
    pub suffix: &'static str,
}

#[cfg(target_os = "linux")]
pub async fn choose(window: WebviewWindow, save: Option<Save>) -> Result<Option<PathBuf>, String> {
    use gtk::{FileChooserAction, FileChooserNative, prelude::*};
    use tokio::sync::oneshot;

    let (send, reply) = oneshot::channel();
    let main = window.clone();
    main.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = match window.gtk_window() {
                Ok(parent) => {
                    let (title, action) = if let Some(save) = &save {
                        (save.title, FileChooserAction::Save)
                    } else {
                        (
                            "Choose a project or worktree",
                            FileChooserAction::SelectFolder,
                        )
                    };
                    let dialog =
                        FileChooserNative::new(Some(title), Some(&parent), action, None, None);
                    dialog.set_modal(true);
                    dialog.set_local_only(true);
                    if let Some(save) = save {
                        dialog.set_current_name(save.filename);
                        let filter = gtk::FileFilter::new();
                        filter.add_pattern(&format!("*.{}", save.suffix));
                        dialog.add_filter(filter);
                        dialog.set_do_overwrite_confirmation(true);
                    }
                    let selected = dialog.run_future().await == gtk::ResponseType::Accept;
                    Ok(selected.then(|| dialog.filename()).flatten())
                }
                Err(error) => Err(error.to_string()),
            };
            let _ = send.send(result);
        });
    })
    .map_err(|error| error.to_string())?;
    reply
        .await
        .map_err(|_| "File chooser closed unexpectedly.".to_owned())?
}

#[cfg(not(target_os = "linux"))]
pub async fn choose(_window: WebviewWindow, save: Option<Save>) -> Result<Option<PathBuf>, String> {
    let dialog = rfd::AsyncFileDialog::new();
    let selection = if let Some(save) = save {
        dialog
            .set_title(save.title)
            .add_filter(save.suffix, &[save.suffix])
            .set_file_name(save.filename)
            .save_file()
            .await
    } else {
        dialog
            .set_title("Choose a project or worktree")
            .pick_folder()
            .await
    };
    Ok(selection.map(|file| file.path().to_owned()))
}
