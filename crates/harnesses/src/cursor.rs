use super::{Harness, generic};

pub const HARNESS: Harness = Harness {
    id: "cursor",
    name: "Cursor Agent CLI",
    executables: &["agent", "cursor-agent"],
    instructions: "Add the server to .cursor/mcp.json, then approve the named server in Cursor Agent CLI. Check discovery with agent mcp list-tools.",
    render: generic,
    automatic: None,
};
