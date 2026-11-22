use super::{Commands, Harness, Setup, mcp_servers};
use serde_json::Value;
use std::io;

pub const HARNESS: Harness = Harness {
    id: "claude",
    name: "Claude Code",
    executables: &["claude"],
    instructions: "Add the server to the project's .mcp.json, then approve it in Claude Code.",
    render,
    automatic: Some(Commands {
        add,
        remove,
        check_version: None,
    }),
};

fn entry(setup: &Setup) -> Value {
    let mut entry = setup.stdio();
    entry["type"] = "stdio".into();
    entry
}

fn render(setup: &Setup) -> io::Result<String> {
    mcp_servers(setup, entry(setup))
}

fn add(setup: &Setup) -> Vec<String> {
    let mut args: Vec<_> = ["mcp", "add-json", "--scope", "user"]
        .map(str::to_owned)
        .into();
    args.extend([setup.server.clone(), entry(setup).to_string()]);
    args
}

fn remove(server: &str) -> Vec<String> {
    ["mcp", "remove", server, "--scope", "user"]
        .map(str::to_owned)
        .into()
}
