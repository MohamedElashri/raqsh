use board_domain::Id;
use raqsh_harnesses::{
    Harness, Setup, enabled_harness, enabled_harnesses, generic, registered_harnesses, server_name,
};
use serde::Serialize;
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, time::timeout};

#[derive(Serialize)]
pub struct Client {
    id: &'static str,
    name: &'static str,
    installed: bool,
    automatic: bool,
    #[serde(rename = "skillPath")]
    skill_path: Option<String>,
}

#[derive(Serialize)]
pub struct Configuration {
    text: String,
    instructions: Option<&'static str>,
    server: String,
}

fn executable_file(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|file| file.is_file() && file.permissions().mode() & 0o111 != 0)
}

fn client_directories() -> Vec<PathBuf> {
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
            PathBuf::from("/bin"),
        ])
        .filter(|directory| directory.is_absolute())
        .collect()
}

pub(crate) fn find_local_executable(names: &[&str]) -> Option<PathBuf> {
    client_directories()
        .into_iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| executable_file(path))
}

fn find_client(harness: &Harness) -> Option<PathBuf> {
    find_local_executable(harness.executables)
}

pub fn clients() -> Vec<Client> {
    enabled_harnesses()
        .map(|harness| Client {
            skill_path: harness.skill_directory().map(|directory| {
                format!(
                    "{directory}/skills/{}/{}",
                    crate::board_skill::FOLDER,
                    crate::board_skill::FILE
                )
            }),
            id: harness.id,
            name: harness.name,
            installed: find_client(harness).is_some(),
            automatic: harness.automatic.is_some(),
        })
        .collect()
}

pub fn named(id: &str) -> Result<&'static Harness, String> {
    enabled_harness(id).ok_or_else(|| format!("Raqsh setup is unavailable for {id}."))
}

fn helper_path() -> Result<PathBuf, String> {
    let path = env::current_exe()
        .map_err(|error| error.to_string())?
        .with_file_name("raqsh-mcp");
    executable_file(&path).then_some(path).ok_or_else(|| {
        "The Raqsh MCP helper is missing. Reinstall Raqsh before pairing a client.".into()
    })
}

fn setup(binding: Id, harness: Option<&Harness>) -> Result<Setup, String> {
    Setup::new(
        &helper_path()?,
        binding,
        false,
        server_name(binding, harness),
    )
    .map_err(|error| error.to_string())
}

pub fn configuration(binding: Id, harness: Option<&Harness>) -> Result<Configuration, String> {
    let setup = setup(binding, harness)?;
    let text = match harness {
        Some(harness) => (harness.render)(&setup),
        None => generic(&setup),
    }
    .map_err(|error| error.to_string())?;
    Ok(Configuration {
        text,
        instructions: harness.map(|harness| harness.instructions),
        server: setup.server,
    })
}

fn marker(library: &Path, binding: Id, harness: &Harness) -> PathBuf {
    library
        .join("pairings")
        .join(format!("{binding}.{}", harness.id))
}

fn command(harness: &Harness) -> Result<Command, String> {
    let program = find_client(harness)
        .ok_or_else(|| format!("Install {} before connecting it to Raqsh.", harness.name))?;
    let mut command = Command::new(program);
    // A GUI-launched process may need these paths for the provider's shebang.
    if let Ok(path) = env::join_paths(client_directories()) {
        command.env("PATH", path);
    }
    command.stdin(Stdio::null()).kill_on_drop(true);
    Ok(command)
}

async fn registration_command(harness: &Harness) -> Result<Command, String> {
    let command = command(harness)?;
    if let Some(check) = harness
        .automatic
        .as_ref()
        .and_then(|commands| commands.check_version)
    {
        let mut version = self::command(harness)?;
        let output = timeout(
            Duration::from_secs(3),
            version.arg("--version").stderr(Stdio::null()).output(),
        )
        .await;
        if !matches!(output, Ok(Ok(output)) if output.status.success() && check(&output.stdout)) {
            return Err(format!("Update {} to use automatic setup.", harness.name));
        }
    }
    Ok(command)
}

async fn run(harness: &Harness, command: &mut Command) -> Result<(), String> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let status = timeout(Duration::from_secs(12), command.status())
        .await
        .map_err(|_| format!("{} took too long to update its MCP settings.", harness.name))?
        .map_err(|error| format!("Could not start {}. {error}", harness.name))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} could not update its MCP settings.",
            harness.name
        ))
    }
}

pub async fn configure(library: &Path, binding: Id, harness: &Harness) -> Result<(), String> {
    let automatic = harness
        .automatic
        .as_ref()
        .ok_or_else(|| format!("Use MCP configuration to set up {}.", harness.name))?;
    let registration = marker(library, binding, harness);
    if registration.is_file() {
        return Ok(());
    }
    let setup = setup(binding, Some(harness))?;
    let mut command = registration_command(harness).await?;
    let pending = registration.with_added_extension("pending");
    if !pending.is_file() {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|error| error.to_string())?;
    }
    // The pending marker survives an interruption, so revoke can still find the entry.
    if let Err(error) = run(harness, command.args((automatic.add)(&setup))).await {
        return match remove(library, binding, harness).await {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error} {cleanup}")),
        };
    }
    fs::rename(pending, registration).map_err(|error| error.to_string())
}

async fn remove(library: &Path, binding: Id, harness: &Harness) -> Result<(), String> {
    let registration = marker(library, binding, harness);
    let pending = registration.with_added_extension("pending");
    if !registration.is_file() && !pending.is_file() {
        return Ok(());
    }
    let Some(automatic) = &harness.automatic else {
        return Ok(());
    };
    let name = server_name(binding, Some(harness));
    let result = match registration_command(harness).await {
        Ok(mut command) => run(harness, command.args((automatic.remove)(&name))).await,
        Err(error) => Err(error),
    };
    result.map_err(|error| {
        format!(
            "{error} Remove {name} from {}'s MCP settings.",
            harness.name
        )
    })?;
    for path in [registration, pending] {
        if let Err(error) = fs::remove_file(path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
    }
    Ok(())
}

pub async fn unregister(library: &Path, binding: Id) -> Result<(), String> {
    let mut failures = Vec::new();
    for harness in registered_harnesses() {
        if let Err(error) = remove(library, binding, harness).await {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("Access was revoked. {}", failures.join(" ")))
    }
}
