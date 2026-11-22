use super::{Commands, Harness, RUNTIME_ENV, Setup};
use std::io;

pub const HARNESS: Harness = Harness {
    id: "codex",
    name: "Codex",
    executables: &["codex"],
    instructions: "Add the server to Codex's config.toml. Open a new Codex session.",
    render,
    automatic: Some(Commands {
        add,
        remove,
        check_version: None,
    }),
};

fn render(setup: &Setup) -> io::Result<String> {
    let command = serde_json::to_string(&setup.program)
        .map_err(io::Error::other)?
        .replace('\u{7f}', "\\u007f");
    let args = serde_json::to_string(&setup.args).map_err(io::Error::other)?;
    let env_vars = RUNTIME_ENV
        .iter()
        .map(|key| format!("\"{key}\""))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "[mcp_servers.{}]\ncommand = {command}\nargs = {args}\nenv_vars = [{env_vars}]\n",
        setup.server
    ))
}

fn add(setup: &Setup) -> Vec<String> {
    ["mcp".into(), "add".into(), setup.server.clone()]
        .into_iter()
        .chain(setup.env_flags())
        .chain(["--".into()])
        .chain(setup.command())
        .collect()
}

fn remove(server: &str) -> Vec<String> {
    ["mcp", "remove", server].map(str::to_owned).into()
}
