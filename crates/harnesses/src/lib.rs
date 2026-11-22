use board_domain::Id;
use serde_json::{Value, json};
use std::{collections::BTreeMap, env, io, path::Path};

mod amp;
mod antigravity;
mod claude;
mod cline;
mod codex;
mod copilot;
mod cursor;
mod goose;
mod kiro;
mod opencode;
mod pi;
mod qwen;

const RUNTIME_ENV: &[&str] = &[
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "RAQSH_RUNTIME_DIR",
    #[cfg(feature = "live-test")]
    "RAQSH_TEST_LIBRARY",
];

// Set an entry's flag to false to disable named setup while retaining cleanup.
static REGISTRY: &[(Harness, bool)] = &[
    (codex::HARNESS, true),
    (claude::HARNESS, true),
    (opencode::HARNESS, true),
    (pi::HARNESS, true),
    (copilot::HARNESS, true),
    (cursor::HARNESS, true),
    (antigravity::HARNESS, true),
    (cline::HARNESS, true),
    (qwen::HARNESS, true),
    (kiro::HARNESS, true),
    (goose::HARNESS, true),
    (amp::HARNESS, true),
];

pub struct Harness {
    pub id: &'static str,
    pub name: &'static str,
    pub executables: &'static [&'static str],
    pub instructions: &'static str,
    pub render: fn(&Setup) -> io::Result<String>,
    pub automatic: Option<Commands>,
}

pub struct Commands {
    pub add: fn(&Setup) -> Vec<String>,
    pub remove: fn(&str) -> Vec<String>,
    pub check_version: Option<fn(&[u8]) -> bool>,
}

pub fn registered_harnesses() -> impl Iterator<Item = &'static Harness> {
    REGISTRY.iter().map(|(harness, _)| harness)
}

pub fn enabled_harnesses() -> impl Iterator<Item = &'static Harness> {
    REGISTRY
        .iter()
        .filter_map(|(harness, enabled)| enabled.then_some(harness))
}

pub fn enabled_harness(id: &str) -> Option<&'static Harness> {
    enabled_harnesses().find(|harness| harness.id == id)
}

pub fn server_name(binding: Id, harness: Option<&Harness>) -> String {
    match harness.map(|harness| harness.id) {
        None | Some("codex" | "claude") => format!("raqsh-{binding}"),
        // A shorter prefix leaves room for the tool name in clients that
        // qualify it as mcp__<server>__<tool> and have a 64-character limit.
        Some(_) => format!("rq-{}", binding.simple()),
    }
}

pub struct Setup {
    pub server: String,
    pub program: String,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
}

impl Setup {
    pub fn new(executable: &Path, binding: Id, combined: bool, server: String) -> io::Result<Self> {
        let program = executable
            .to_str()
            .ok_or_else(|| io::Error::other("Executable path must be UTF-8."))?
            .to_owned();
        let mut args = vec!["serve".into(), "--pairing".into(), binding.to_string()];
        if combined {
            args.insert(0, "mcp".into());
        }
        let environment = RUNTIME_ENV
            .iter()
            .filter_map(|key| env::var(key).ok().map(|value| (key.to_string(), value)))
            .collect();
        Ok(Self {
            server,
            program,
            args,
            environment,
        })
    }

    fn stdio(&self) -> Value {
        let mut entry = json!({ "command": self.program, "args": self.args });
        if !self.environment.is_empty() {
            entry["env"] = json!(self.environment);
        }
        entry
    }

    fn env_flags(&self) -> impl Iterator<Item = String> {
        self.environment
            .iter()
            .flat_map(|(key, value)| ["--env".to_owned(), format!("{key}={value}")])
    }

    fn command(&self) -> impl Iterator<Item = String> {
        std::iter::once(self.program.clone()).chain(self.args.iter().cloned())
    }
}

pub fn generic(setup: &Setup) -> io::Result<String> {
    mcp_servers(setup, setup.stdio())
}

fn mcp_servers(setup: &Setup, entry: Value) -> io::Result<String> {
    pretty(json!({ "mcpServers": { (&setup.server): entry } }))
}

fn pretty(value: Value) -> io::Result<String> {
    Ok(serde_json::to_string_pretty(&value).map_err(io::Error::other)? + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn setup() -> Setup {
        let binding = Id::from_u128(1);
        let mut setup = Setup::new(
            Path::new("/tmp/Board \"Test\"/raqsh-mcp"),
            binding,
            true,
            server_name(binding, None),
        )
        .unwrap();
        setup.environment = BTreeMap::from([("RAQSH_RUNTIME_DIR".into(), "/tmp/a b".into())]);
        setup
    }

    #[test]
    fn registry_ids_are_unique_and_only_enabled_entries_are_selectable() {
        let registered: BTreeSet<_> = registered_harnesses().map(|harness| harness.id).collect();
        assert_eq!(registered.len(), REGISTRY.len());
        assert!(enabled_harness("unknown").is_none());
        for (harness, enabled) in REGISTRY {
            assert_eq!(enabled_harness(harness.id).is_some(), *enabled);
        }
    }

    #[test]
    fn all_formats_preserve_the_helper_argv_and_pairing_name() {
        let setup = setup();
        for harness in registered_harnesses() {
            let rendered = (harness.render)(&setup).unwrap();
            if harness.id == "codex" {
                assert!(rendered.starts_with(&format!("[mcp_servers.{}]", setup.server)));
                assert!(rendered.contains(&serde_json::to_string(&setup.program).unwrap()));
                assert!(rendered.contains(&serde_json::to_string(&setup.args).unwrap()));
                continue;
            }
            let value: Value = serde_json::from_str(&rendered).unwrap();
            let server = setup.server.as_str();
            if harness.id == "opencode" {
                let entry = &value["mcp"]["servers"][server];
                assert_eq!(entry["command"], json!(setup.command().collect::<Vec<_>>()));
                assert_eq!(entry["environment"], json!(setup.environment));
                assert_eq!(entry["type"], "local");
                assert_eq!(entry["codemode"], false);
                continue;
            }
            let (group, program, env) = match harness.id {
                "goose" => ("extensions", "cmd", "envs"),
                "amp" => ("amp.mcpServers", "command", "env"),
                _ => ("mcpServers", "command", "env"),
            };
            let entry = &value[group][server];
            assert_eq!(entry[program], setup.program, "{}", harness.id);
            assert_eq!(entry["args"], json!(setup.args), "{}", harness.id);
            assert_eq!(entry[env], json!(setup.environment), "{}", harness.id);
            match harness.id {
                "pi" => assert_eq!(entry["exposure"], "direct"),
                "copilot" => assert_eq!(entry["tools"], json!(["*"])),
                _ => {}
            }
        }
    }

    #[test]
    fn automatic_adapters_use_the_same_owned_name_for_add_and_remove() {
        let setup = setup();
        for harness in registered_harnesses() {
            let Some(auto) = &harness.automatic else {
                continue;
            };
            let added = (auto.add)(&setup);
            let removed = (auto.remove)(&setup.server);
            assert!(added.contains(&setup.server));
            assert!(removed.contains(&setup.server));
            if harness.id == "claude" {
                let entry: Value = serde_json::from_str(added.last().unwrap()).unwrap();
                assert_eq!(entry["command"], setup.program);
                assert_eq!(entry["args"], json!(setup.args));
            } else {
                assert!(added.ends_with(&setup.command().collect::<Vec<_>>()));
                assert!(added.contains(&"RAQSH_RUNTIME_DIR=/tmp/a b".into()));
            }
        }
        let pi = pi::HARNESS.automatic.unwrap();
        let version = pi.check_version.unwrap();
        assert!(version(b"1.6.0\n"));
        assert!(!version(b"1.5.2\n"));
        assert!(!version(b"1.6.0-beta.2\n"));
    }
}
