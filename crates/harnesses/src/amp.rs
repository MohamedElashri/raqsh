use super::{Harness, Setup, pretty};
use serde_json::json;
use std::io;

pub const HARNESS: Harness = Harness {
    id: "amp",
    name: "Amp CLI",
    executables: &["amp"],
    instructions: "Add the server to .amp/settings.json and approve the named workspace server in a local Amp CLI session.",
    render,
    automatic: None,
};

fn render(setup: &Setup) -> io::Result<String> {
    pretty(json!({ "amp.mcpServers": { (&setup.server): setup.stdio() } }))
}
