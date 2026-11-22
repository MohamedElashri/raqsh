use super::{Harness, Setup, mcp_servers};
use serde_json::json;
use std::io;

pub const HARNESS: Harness = Harness {
    id: "copilot",
    name: "GitHub Copilot CLI",
    executables: &["copilot"],
    instructions: "Add the server to the project's .mcp.json, then check /mcp in Copilot CLI. Your organization's MCP allowlist may require approval.",
    render,
    automatic: None,
};

fn render(setup: &Setup) -> io::Result<String> {
    let mut entry = setup.stdio();
    entry["type"] = "stdio".into();
    entry["tools"] = json!(["*"]);
    mcp_servers(setup, entry)
}
