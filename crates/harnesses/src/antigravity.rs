use super::{Harness, generic};

pub const HARNESS: Harness = Harness {
    id: "antigravity",
    name: "Google Antigravity CLI",
    executables: &["agy"],
    instructions: "Add the server to .agents/mcp_config.json in your workspace or ~/.gemini/config/mcp_config.json for your user. Check it in Antigravity CLI with /mcp.",
    render: generic,
    automatic: None,
};
