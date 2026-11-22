use super::{Harness, Setup, pretty};
use serde_json::json;
use std::io;

pub const HARNESS: Harness = Harness {
    id: "goose",
    name: "Goose CLI",
    executables: &["goose"],
    instructions: "Merge this extension into the extensions section of your Goose config.yaml. The snippet uses JSON, a YAML-compatible syntax. Review it with goose configure and open a new session.",
    render,
    automatic: None,
};

fn render(setup: &Setup) -> io::Result<String> {
    pretty(json!({ "extensions": { (&setup.server): {
        "type": "stdio", "name": setup.server, "cmd": setup.program, "args": setup.args,
        "envs": setup.environment, "enabled": true
    } } }))
}
