use super::{Harness, generic};

pub const HARNESS: Harness = Harness {
    id: "kiro",
    name: "Kiro CLI",
    executables: &["kiro-cli"],
    instructions: "Add the server to .kiro/settings/mcp.json. Open a Kiro CLI session and check /mcp. Make sure your selected Kiro agent allows those tools.",
    render: generic,
    automatic: None,
};
