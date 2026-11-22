use super::{Harness, generic};

pub const HARNESS: Harness = Harness {
    id: "cline",
    name: "Cline CLI",
    executables: &["cline"],
    instructions: "Add the server to ~/.cline/data/settings/cline_mcp_settings.json or the file at CLINE_MCP_SETTINGS_PATH. Review it in Cline's MCP settings.",
    render: generic,
    automatic: None,
};
