use super::{Harness, generic};

pub const HARNESS: Harness = Harness {
    id: "qwen",
    name: "Qwen Code",
    executables: &["qwen"],
    instructions: "Add the server to .qwen/settings.json. Open a trusted project in Qwen Code and inspect /mcp. Review tool approvals as prompted.",
    render: generic,
    automatic: None,
};
