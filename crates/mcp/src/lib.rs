use board_domain::Id;
use board_ipc::{Call, Credential, MAX_FRAME, Request, Session, VERSION};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::OsString,
    io::{self, BufRead, Read, Write},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

const PROTOCOL: &str = "2025-11-25";
const REQUEST_QUEUE: usize = 8;
const SERVER_ID: &str = "raqsh";
type Pending = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

struct Job {
    request: Value,
    key: Option<String>,
    cancelled: Arc<AtomicBool>,
}

#[derive(PartialEq, Eq)]
enum Stage {
    New,
    Initialized,
    Ready,
}

fn error(id: &Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn tool_result(value: Value, failed: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": value.to_string() }],
        "structuredContent": value, "isError": failed })
}

fn tools() -> Value {
    serde_json::from_str(include_str!("tools.json")).expect("valid MCP tool definitions")
}

fn handle(
    request: &Value,
    stage: &mut Stage,
    credential: &Credential,
    cancelled: &AtomicBool,
) -> Option<Value> {
    let has_id = request.get("id").is_some();
    let id = &request["id"];
    let Some(method) = request
        .get("method")
        .and_then(Value::as_str)
        .filter(|_| request["jsonrpc"] == "2.0" && (!has_id || valid_id(id)))
    else {
        return Some(error(&Value::Null, -32600, "Invalid Request"));
    };
    let params = &request["params"];
    if !has_id {
        if method == "notifications/initialized" && *stage == Stage::Initialized {
            *stage = Stage::Ready;
        }
        return None;
    }
    if params != &Value::Null && !params.is_object() {
        return Some(error(id, -32602, "Expected object parameters."));
    }
    let reply = match method {
        "initialize" if *stage == Stage::New => {
            let version = params["protocolVersion"].as_str();
            if version.is_none()
                || !params["capabilities"].is_object()
                || params["clientInfo"]["name"].as_str().is_none()
                || params["clientInfo"]["version"].as_str().is_none()
            {
                return Some(error(
                    id,
                    -32602,
                    "Expected protocolVersion, capabilities, and clientInfo.",
                ));
            }
            *stage = Stage::Initialized;
            let protocol = match version {
                Some("2025-06-18") => "2025-06-18",
                _ => PROTOCOL,
            };
            result(
                id,
                json!({
                    "protocolVersion": protocol,
                    "serverInfo": { "name": SERVER_ID, "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "tools": { "listChanged": false } },
                    "instructions": "Work only with the paired board or project. Use board_list to discover board IDs. Retry a lost write using its original operation ID and payload. Feedback is read explicitly with board_get_feedback."
                }),
            )
        }
        "initialize" => error(id, -32600, "Already initialized."),
        "ping" => result(id, json!({})),
        _ if *stage != Stage::Ready => {
            error(id, -32002, "Complete the MCP initialization lifecycle.")
        }
        "tools/list" => {
            if params.get("cursor").is_some() {
                return Some(error(id, -32602, "The tool list has one page."));
            }
            result(id, json!({ "tools": tools() }))
        }
        "tools/call" => {
            let Some(name) = params["name"].as_str() else {
                return Some(error(id, -32602, "Missing tool name."));
            };
            if !tools()
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == name))
            {
                return Some(error(id, -32602, "Unknown tool."));
            }
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let call =
                serde_json::from_value::<Call>(json!({ "tool": name, "arguments": arguments }));
            match call {
                Ok(call) if !cancelled.load(Ordering::Acquire) => {
                    let request = Request {
                        version: VERSION,
                        request_id: Id::new_v4(),
                        credential: credential.clone(),
                        call,
                    };
                    match board_ipc::invoke(&request) {
                        Ok(value) => result(id, tool_result(value, false)),
                        Err(failure) => result(id, tool_result(json!(failure), true)),
                    }
                }
                Ok(_) => return None,
                Err(_) => error(id, -32602, "Tool arguments do not match its input schema."),
            }
        }
        _ => error(id, -32601, "Method not found"),
    };
    (!cancelled.load(Ordering::Acquire)).then_some(reply)
}

fn valid_id(id: &Value) -> bool {
    id.as_str().is_some_and(|id| id.len() <= 256) || id.is_i64() || id.is_u64()
}

fn write_message(output: &Mutex<io::Stdout>, message: &Value) -> io::Result<()> {
    let mut output = output
        .lock()
        .map_err(|_| io::Error::other("MCP synchronization failed"))?;
    serde_json::to_writer(&mut *output, message).map_err(io::Error::other)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn serve(credential: Credential) -> io::Result<()> {
    let output = Arc::new(Mutex::new(io::stdout()));
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let stopping = Arc::new(AtomicBool::new(false));
    let (send, receive) = mpsc::sync_channel::<Job>(REQUEST_QUEUE);
    let worker = {
        let (output, pending, stopping) = (output.clone(), pending.clone(), stopping.clone());
        std::thread::Builder::new()
            .name("stdio-tools".into())
            .spawn(move || -> io::Result<()> {
                let mut stage = Stage::New;
                for job in receive {
                    if stopping.load(Ordering::Acquire) {
                        break;
                    }
                    if let Some(reply) =
                        handle(&job.request, &mut stage, &credential, &job.cancelled)
                    {
                        write_message(&output, &reply)?;
                    }
                    if let Some(key) = job.key {
                        pending
                            .lock()
                            .map_err(|_| io::Error::other("MCP synchronization failed"))?
                            .remove(&key);
                    }
                }
                Ok(())
            })?
    };
    let input = io::stdin();
    let mut input = input.lock();
    let reader = (|| -> io::Result<()> {
        let mut line = Vec::new();
        loop {
            line.clear();
            if (&mut input)
                .take((MAX_FRAME + 1) as u64)
                .read_until(b'\n', &mut line)?
                == 0
            {
                break;
            }
            if line.len() > MAX_FRAME {
                write_message(
                    &output,
                    &error(&Value::Null, -32700, "MCP message exceeds 4 MiB."),
                )?;
                break;
            }
            let request: Value = match serde_json::from_slice(&line) {
                Ok(request) => request,
                Err(_) => {
                    write_message(&output, &error(&Value::Null, -32700, "Parse error"))?;
                    continue;
                }
            };
            if request["jsonrpc"] == "2.0"
                && request["method"] == "notifications/cancelled"
                && request.get("id").is_none()
            {
                let target = &request["params"]["requestId"];
                if valid_id(target)
                    && let Some(flag) = pending
                        .lock()
                        .map_err(|_| io::Error::other("MCP synchronization failed"))?
                        .get(&target.to_string())
                {
                    flag.store(true, Ordering::Release);
                }
                continue;
            }
            let key = request
                .get("id")
                .filter(|id| valid_id(id))
                .map(Value::to_string);
            let cancelled = Arc::new(AtomicBool::new(false));
            if let Some(key) = &key {
                let mut entries = pending
                    .lock()
                    .map_err(|_| io::Error::other("MCP synchronization failed"))?;
                if entries.contains_key(key) {
                    drop(entries);
                    write_message(
                        &output,
                        &error(&request["id"], -32600, "Duplicate pending request ID."),
                    )?;
                    continue;
                }
                entries.insert(key.clone(), cancelled.clone());
            }
            match send.try_send(Job {
                request,
                key,
                cancelled,
            }) {
                Ok(()) => (),
                Err(mpsc::TrySendError::Full(job)) => {
                    if let Some(key) = &job.key {
                        pending
                            .lock()
                            .map_err(|_| io::Error::other("MCP synchronization failed"))?
                            .remove(key);
                    }
                    if let Some(id) = job.request.get("id") {
                        write_message(
                            &output,
                            &error(id, -32001, "Request queue is full. Retry."),
                        )?;
                    }
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "MCP worker closed",
                    ));
                }
            }
        }
        Ok(())
    })();
    stopping.store(true, Ordering::Release);
    drop(send);
    worker
        .join()
        .map_err(|_| io::Error::other("MCP request worker stopped"))??;
    reader
}

fn pairing_arg(arguments: &mut impl Iterator<Item = OsString>) -> io::Result<Id> {
    if arguments.next().is_some_and(|arg| arg == "--pairing")
        && let Some(id) = arguments.next().and_then(|arg| arg.into_string().ok())
        && let Ok(id) = id.parse::<Id>()
        && !id.is_nil()
    {
        Ok(id)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected --pairing <UUID>",
        ))
    }
}

fn print_value(value: Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &value).map_err(io::Error::other)?;
    out.write_all(b"\n")
}

pub fn main_entry(mut arguments: impl Iterator<Item = OsString>, combined: bool) -> io::Result<()> {
    let command = arguments.next().and_then(|arg| arg.into_string().ok());
    if matches!(command.as_deref(), None | Some("--help" | "help")) {
        println!("Usage: raqsh-mcp <serve|doctor|probe|setup|remove> --pairing <UUID>");
        println!("Setup and probe also accept --format <json|codex|claude>.");
        return Ok(());
    }
    let command = command.as_deref().unwrap_or_default();
    let binding = pairing_arg(&mut arguments)?;
    let format = match arguments.next() {
        None => RegistrationFormat::Json,
        Some(option) if matches!(command, "setup" | "probe") && option == "--format" => {
            let format = arguments.next();
            match format.as_deref().and_then(std::ffi::OsStr::to_str) {
                Some("json") => RegistrationFormat::Json,
                Some("codex") => RegistrationFormat::Codex,
                Some("claude") => RegistrationFormat::Claude,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Expected json, codex or claude.",
                    ));
                }
            }
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Unexpected argument.",
            ));
        }
    };
    if arguments.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unexpected argument.",
        ));
    }
    let library = board_ipc::default_library()?;
    let credential = board_ipc::read_credential(&library, binding)?;
    match command {
        "serve" => serve(credential),
        "setup" => io::stdout().write_all(
            registration(&std::env::current_exe()?, binding, combined, format)?.as_bytes(),
        ),
        "doctor" | "probe" | "remove" => {
            let call = if command == "remove" {
                Call::Revoke(Session {})
            } else {
                Call::BoardSessionState(Session {})
            };
            let request = Request {
                version: VERSION,
                request_id: Id::new_v4(),
                credential,
                call,
            };
            match board_ipc::invoke(&request) {
                Ok(value) => {
                    if command == "remove" {
                        board_ipc::remove_credential(&library, binding)?;
                    }
                    if command == "probe" {
                        print_value(provider_capabilities(format, value))
                    } else {
                        print_value(value)
                    }
                }
                Err(failure) => Err(io::Error::other(format!(
                    "{}: {}",
                    failure.code, failure.message
                ))),
            }
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unknown command",
        )),
    }
}

enum RegistrationFormat {
    Json,
    Codex,
    Claude,
}

fn provider_capabilities(format: RegistrationFormat, session: Value) -> Value {
    let provider = match format {
        RegistrationFormat::Json => "generic_mcp",
        RegistrationFormat::Claude => "claude_code",
        RegistrationFormat::Codex => "codex",
    };
    json!({
        "provider": provider,
        "transport": "stdio",
        "session": session,
    })
}

fn registration(
    executable: &Path,
    binding: Id,
    combined: bool,
    format: RegistrationFormat,
) -> io::Result<String> {
    let path = executable
        .to_str()
        .ok_or_else(|| io::Error::other("Executable path must be UTF-8"))?;
    let binding = binding.to_string();
    let mut args = vec!["serve", "--pairing", &binding];
    if combined {
        args.insert(0, "mcp");
    }
    match format {
        RegistrationFormat::Json => Ok(format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({ "mcpServers": { SERVER_ID: { "command": path, "args": args } } }))
                .map_err(io::Error::other)?
        )),
        RegistrationFormat::Claude => Ok(format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({ "mcpServers": { SERVER_ID: { "type": "stdio", "command": path, "args": args } } }))
                .map_err(io::Error::other)?
        )),
        RegistrationFormat::Codex => {
            let command = serde_json::to_string(path)
                .map_err(io::Error::other)?
                .replace('\u{7f}', "\\u007f");
            let args = serde_json::to_string(&args).map_err(io::Error::other)?;
            Ok(format!(
                "[mcp_servers.{SERVER_ID}]\ncommand = {command}\nargs = {args}\n\
                 env_vars = [\"XDG_DATA_HOME\", \"XDG_RUNTIME_DIR\", \"RAQSH_RUNTIME_DIR\"]\n"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_capabilities_report_only_verified_session_evidence() {
        let evidence = json!({
            "connection": "connected",
            "feedback": "portable_tools",
            "liveSteering": "unsupported"
        });
        for (format, provider) in [
            (RegistrationFormat::Json, "generic_mcp"),
            (RegistrationFormat::Codex, "codex"),
            (RegistrationFormat::Claude, "claude_code"),
        ] {
            assert_eq!(
                provider_capabilities(format, evidence.clone()),
                json!({ "provider": provider, "transport": "stdio", "session": evidence })
            );
        }
    }

    #[test]
    fn formats_use_the_stable_server_id_and_preserve_quoted_paths() {
        let path = Path::new("/opt/Board \"Test\"/raqsh-mcp");
        let binding = Id::new_v4();
        let json: Value = serde_json::from_str(
            &registration(path, binding, false, RegistrationFormat::Json).unwrap(),
        )
        .unwrap();
        let claude: Value = serde_json::from_str(
            &registration(path, binding, false, RegistrationFormat::Claude).unwrap(),
        )
        .unwrap();
        let generic = &json["mcpServers"][SERVER_ID];
        let claude = &claude["mcpServers"][SERVER_ID];
        let args = json!(["serve", "--pairing", binding]);
        assert_eq!(generic, &json!({ "command": path, "args": args }));
        assert_eq!(
            claude,
            &json!({ "type": "stdio", "command": path, "args": args })
        );

        let codex = registration(path, binding, true, RegistrationFormat::Codex).unwrap();
        assert!(codex.starts_with("[mcp_servers.raqsh]\n"));
        assert!(codex.contains(r#"command = "/opt/Board \"Test\"/raqsh-mcp""#));
        assert!(codex.contains(&format!(
            r#"args = ["mcp","serve","--pairing","{binding}"]"#
        )));
    }
}
