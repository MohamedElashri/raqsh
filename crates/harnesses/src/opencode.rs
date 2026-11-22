use super::{Harness, Setup, pretty};
use serde_json::json;
use std::io;

pub const HARNESS: Harness = Harness {
    id: "opencode",
    name: "OpenCode",
    executables: &["opencode"],
    instructions: "For OpenCode v2, merge this entry under mcp.servers in your project's opencode.json or opencode.jsonc. OpenCode v1 uses a different schema. Check the entry with opencode mcp list.",
    render,
    automatic: None,
};

fn render(setup: &Setup) -> io::Result<String> {
    let command: Vec<_> = setup.command().collect();
    pretty(json!({ "mcp": { "servers": { (&setup.server): {
        "type": "local", "command": command, "environment": setup.environment, "codemode": false
    } } } }))
}
