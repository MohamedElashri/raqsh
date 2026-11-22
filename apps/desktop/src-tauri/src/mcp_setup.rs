use board_domain::Id;
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, time::timeout};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Claude,
}

impl Provider {
    fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
        }
    }
}

const PROVIDERS: [Provider; 2] = [Provider::Codex, Provider::Claude];

fn executable_file(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|file| file.is_file() && file.permissions().mode() & 0o111 != 0)
}

fn find_client(provider: Provider) -> Option<PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();
    let home = env::var_os("HOME").map(PathBuf::from);
    env::split_paths(&path)
        .chain(home.into_iter().flat_map(|root| {
            [
                root.join(".local/bin"),
                root.join(".npm-global/bin"),
                root.join(".bun/bin"),
            ]
        }))
        .chain([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ])
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(provider.executable()))
        .find(|path| executable_file(path))
}

pub fn installed_clients() -> Vec<Provider> {
    PROVIDERS
        .into_iter()
        .filter(|provider| find_client(*provider).is_some())
        .collect()
}

fn helper_path() -> Result<PathBuf, String> {
    let path = env::current_exe()
        .map_err(|error| error.to_string())?
        .with_file_name("raqsh-mcp");
    executable_file(&path).then_some(path).ok_or_else(|| {
        "The Raqsh MCP helper is missing. Reinstall Raqsh before pairing a client.".into()
    })
}

fn server_name(binding: Id) -> String {
    format!("raqsh-{binding}")
}

fn forwarded_environment() -> serde_json::Map<String, serde_json::Value> {
    let names = [
        "XDG_DATA_HOME",
        "XDG_RUNTIME_DIR",
        "RAQSH_RUNTIME_DIR",
        #[cfg(feature = "macos-live-test")]
        "RAQSH_TEST_LIBRARY",
    ];
    names
        .into_iter()
        .filter_map(|key| env::var(key).ok().map(|value| (key.into(), value.into())))
        .collect()
}

fn entry(binding: Id) -> Result<serde_json::Value, String> {
    let helper = helper_path()?;
    let command = helper
        .to_str()
        .ok_or("The path to Raqsh must be valid UTF-8.")?;
    Ok(serde_json::json!({
        "command": command, "args": ["serve", "--pairing", binding], "env": forwarded_environment(),
    }))
}

pub fn generic_config(binding: Id) -> Result<String, String> {
    serde_json::to_string_pretty(
        &serde_json::json!({ "mcpServers": { (server_name(binding)): entry(binding)? } }),
    )
    .map_err(|error| error.to_string())
}

fn marker(library: &Path, binding: Id, provider: Provider) -> PathBuf {
    library
        .join("pairings")
        .join(format!("{binding}.{}", provider.executable()))
}

async fn run(provider: Provider, mut command: Command) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let status = timeout(Duration::from_secs(12), command.status())
        .await
        .map_err(|_| {
            format!(
                "{} took too long to update its MCP settings.",
                provider.name()
            )
        })?
        .map_err(|error| format!("Could not start {}. {error}", provider.name()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} could not update its MCP settings.",
            provider.name()
        ))
    }
}

fn command(provider: Provider) -> Result<Command, String> {
    let program = find_client(provider)
        .ok_or_else(|| format!("Install {} before connecting it to Raqsh.", provider.name()))?;
    let mut command = Command::new(program);
    // GUI-launched apps may lack the Node path needed by a provider's shebang.
    let path = env::var_os("PATH").unwrap_or_default();
    let home = env::var_os("HOME").map(PathBuf::from);
    let directories = env::split_paths(&path)
        .chain(home.into_iter().map(|root| root.join(".local/bin")))
        .chain([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ])
        .filter(|directory| directory.is_absolute());
    if let Ok(path) = env::join_paths(directories) {
        command.env("PATH", path);
    }
    command.arg("mcp");
    Ok(command)
}

pub async fn configure(library: &Path, binding: Id, provider: Provider) -> Result<(), String> {
    let entry = entry(binding)?;
    let mut command = command(provider)?;
    let name = server_name(binding);
    let marker = marker(library, binding, provider);
    if marker.is_file() {
        return Ok(());
    }
    match provider {
        Provider::Codex => {
            command.args(["add", &name]);
            for (key, value) in forwarded_environment() {
                command.args([
                    "--env",
                    &format!("{key}={}", value.as_str().unwrap_or_default()),
                ]);
            }
            command.args([
                "--",
                entry["command"].as_str().expect("generated command"),
                "serve",
                "--pairing",
                &binding.to_string(),
            ]);
        }
        Provider::Claude => {
            let mut entry = entry;
            entry["type"] = "stdio".into();
            command.args(["add-json", "--scope", "user", &name, &entry.to_string()]);
        }
    }
    // The marker makes cleanup possible even if the provider exits during registration.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
        .map_err(|error| error.to_string())?;
    if let Err(error) = run(provider, command).await {
        let _ = remove(library, binding, provider).await;
        let _ = fs::remove_file(marker);
        return Err(error);
    }
    Ok(())
}

async fn remove(library: &Path, binding: Id, provider: Provider) -> Result<(), String> {
    let marker = marker(library, binding, provider);
    if !marker.is_file() {
        return Ok(());
    }
    let mut command = command(provider)?;
    command.args(["remove", &server_name(binding)]);
    if matches!(provider, Provider::Claude) {
        command.args(["--scope", "user"]);
    }
    run(provider, command).await?;
    fs::remove_file(marker).map_err(|error| error.to_string())
}

pub async fn unregister(library: &Path, binding: Id) -> Result<(), String> {
    let mut failures = Vec::new();
    for provider in PROVIDERS {
        if let Err(error) = remove(library, binding, provider).await {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("Access was revoked. {}", failures.join(" ")))
    }
}
