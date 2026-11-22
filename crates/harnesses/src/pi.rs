use super::{Commands, Harness, Setup, mcp_servers};
use std::io;

pub const HARNESS: Harness = Harness {
    id: "pi",
    name: "Pi",
    executables: &["pi"],
    instructions: "Requires Pi with built-in MCP. Add the server to .pi/mcp.json and trust the project in Pi. An extension that replaces built-in MCP may need its own setup.",
    render,
    automatic: Some(Commands {
        add,
        remove,
        check_version: Some(supports_mcp),
    }),
};

fn supports_mcp(output: &[u8]) -> bool {
    let Ok(version) = std::str::from_utf8(output) else {
        return false;
    };
    let parts: Vec<_> = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(str::parse::<u32>)
        .collect();
    matches!(parts.as_slice(), [Ok(major), Ok(minor), Ok(patch)] if (*major, *minor, *patch) >= (1, 6, 0))
}

fn render(setup: &Setup) -> io::Result<String> {
    let mut entry = setup.stdio();
    entry["exposure"] = "direct".into();
    mcp_servers(setup, entry)
}

fn add(setup: &Setup) -> Vec<String> {
    [
        "mcp".into(),
        "add".into(),
        setup.server.clone(),
        "--exposure".into(),
        "direct".into(),
    ]
    .into_iter()
    .chain(setup.env_flags())
    .chain(["--".into()])
    .chain(setup.command())
    .collect()
}

fn remove(server: &str) -> Vec<String> {
    ["mcp", "remove", server].map(str::to_owned).into()
}
