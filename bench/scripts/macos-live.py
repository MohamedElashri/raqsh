#!/usr/bin/env python3
"""Run the macOS WebKit editor and MCP sidecar against a disposable library."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import tomllib
from uuid import uuid4

SERVER = "raqsh"
STATUS_TOOL = "board_set_task_status"
PROVIDER_TIMEOUT = 100


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


@contextmanager
def child(command, **options):
    with subprocess.Popen(command, **options) as process:
        try:
            yield process
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


def status_arguments(pairing, board):
    return {"boardId": board, "taskId": pairing["task"], "status": "done",
            "expectedRevision": pairing["revision"], "operationId": str(uuid4())}


def update_status(helper, pairing, env):
    command = [helper, "serve", "--pairing", pairing["binding"]]
    with child(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as process:
        def send(method, params=None, request_id=None):
            data = {"jsonrpc": "2.0", "method": method}
            if params is not None:
                data["params"] = params
            if request_id is not None:
                data["id"] = request_id
            process.stdin.write(json.dumps(data).encode() + b"\n")
            process.stdin.flush()
            if request_id is None:
                return None
            reply = b""
            deadline = time.monotonic() + 8
            while not reply.endswith(b"\n"):
                ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
                require(ready, f"MCP timed out during {method}")
                chunk = os.read(process.stdout.fileno(), 4096)
                require(chunk, f"MCP closed stdout during {method}")
                reply += chunk
            response = json.loads(reply)
            require(response.get("id") == request_id and "result" in response, response)
            return response["result"]

        protocol = "2025-11-25"
        info = send("initialize", {
            "protocolVersion": protocol, "capabilities": {},
            "clientInfo": {"name": "raqsh-macos-live", "version": "1"},
        }, 1)
        require(info["protocolVersion"] == protocol, info)
        send("notifications/initialized")
        state = send("tools/call", {"name": "board_session_state"}, 2)
        require(not state.get("isError") and state["structuredContent"]["connection"] == "connected", state)
        board = state["structuredContent"]["binding"]["boardId"]
        result = send("tools/call", {"name": STATUS_TOOL, "arguments": status_arguments(pairing, board)}, 3)
        require(not result.get("isError") and result["structuredContent"]["revision"] == pairing["revision"] + 1,
                result)
        process.stdin.close()
        require(process.wait(timeout=5) == 0, "MCP helper failed to exit cleanly")


def run_cli(command, root, env, timeout=10):
    result = subprocess.run(command, cwd=root / "project", env=env, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        diagnostic = result.stderr.strip() or result.stdout.strip()
        for key in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"):
            if env.get(key):
                diagnostic = diagnostic.replace(env[key], "[redacted]")
        raise RuntimeError(f"{Path(command[0]).name} exited with {result.returncode}: {diagnostic[-1500:]}")
    return result.stdout.strip()


def update_status_with_provider(helper, pairing, root, env, provider, registration_env):
    cli = "codex" if provider == "codex" else "claude"
    auth_env = dict(env, DISABLE_TELEMETRY="1", DISABLE_ERROR_REPORTING="1", DISABLE_AUTOUPDATER="1")
    probe = json.loads(run_cli([helper, "doctor", "--pairing", pairing["binding"]], root, env))
    require(probe["binding"]["id"] == pairing["binding"], "The helper reported a different pairing")
    alias = f"raqsh-{pairing['binding']}"
    inspect = [cli, "mcp", "get", alias]
    if provider == "codex":
        registration = json.loads(run_cli([*inspect, "--json"], root, registration_env))
        entry = registration["transport"]
        require(entry["command"] == str(helper) and entry["args"] == ["serve", "--pairing", pairing["binding"]],
                "Raqsh did not configure the bundled helper in Codex")
    else:
        profile = Path(registration_env["CLAUDE_CONFIG_DIR"], ".claude.json")
        entries = json.loads(profile.read_text()).get("mcpServers", {}) if profile.exists() else {}
        require(alias in entries, f"Claude profile is missing the pairing (recorded aliases: {list(entries)})")
        description = run_cli(inspect, root, registration_env)
        require(str(helper) in description and pairing["binding"] in description and "Connected" in description,
                "Raqsh did not configure a working bundled helper in Claude Code")
    arguments = status_arguments(pairing, probe["binding"]["boardId"])
    prompt = (f"This is an isolated synthetic integration test. Call {STATUS_TOOL} on the {SERVER} MCP server "
              f"exactly once with these arguments: {json.dumps(arguments)}. Do not use any other tools. "
              "Finish after the tool returns.")
    setup = run_cli([helper, "setup", "--pairing", pairing["binding"], "--format", cli], root, env)
    forward = {key: env[key] for key in ("RAQSH_RUNTIME_DIR", "RAQSH_TEST_LIBRARY")}
    if provider == "codex":
        config = tomllib.loads(setup)["mcp_servers"][SERVER]
        prefix = f"mcp_servers.{SERVER}"
        environment = ", ".join(f"{key} = {json.dumps(value)}" for key, value in forward.items())
        command = [cli, "--ask-for-approval", "never", "exec", "--json", "--ephemeral", "--ignore-user-config",
                   "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "shell_tool",
                   "-c", f"{prefix}.command={json.dumps(config['command'])}",
                   "-c", f"{prefix}.args={json.dumps(config['args'])}",
                   "-c", f"{prefix}.env_vars={json.dumps(config['env_vars'])}",
                   "-c", f"{prefix}.env={{{environment}}}",
                   "-c", f"{prefix}.enabled_tools={json.dumps([STATUS_TOOL])}",
                   "-c", f'{prefix}.tools.{STATUS_TOOL}.approval_mode="approve"',
                   "-c", f"{prefix}.required=true", prompt]
    else:
        config = json.loads(setup)
        config["mcpServers"][SERVER]["env"] = forward
        path = root / "claude-mcp.json"
        path.write_text(json.dumps(config), encoding="utf8")
        tool = f"mcp__{SERVER}__{STATUS_TOOL}"
        command = [cli, "--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
                   "--restricted", "--tools", "", "--permission-mode", "dontAsk", "--permission-prompts", "none",
                   "--strict-mcp-config", "--mcp-config", str(path), "--allowedTools", tool, "--", prompt]
    events = [json.loads(line) for line in run_cli(command, root, auth_env, timeout=PROVIDER_TIMEOUT).splitlines()]
    if provider == "codex":
        calls = [item for event in events if event.get("type") == "item.completed"
                 if (item := event["item"])["type"] == "mcp_tool_call"]
        require([(item["server"], item["tool"], item["status"]) for item in calls] == [(SERVER, STATUS_TOOL, "completed")],
                "Codex did not complete exactly one MCP status update")
        require(any(event.get("type") == "turn.completed" for event in events), "Codex did not finish the turn")
    else:
        calls = [block for event in events if event.get("type") == "assistant"
                 for block in event["message"]["content"] if block.get("type") == "tool_use"]
        require([block["name"] for block in calls] == [tool], "Claude Code did not call exactly one MCP status update")
        require(any(event.get("type") == "result" and not event.get("is_error") for event in events),
                "Claude Code did not finish the turn successfully")
    return run_cli([cli, "--version"], root, auth_env)


def run_app(desktop, helper, root, env, mode, provider):
    fixture = "stress" if mode == "stress" else "empty"
    command = [desktop, f"--macos-live={mode}"]
    if mode != "about":
        command.append(f"--fixture={fixture}")
    app_env = dict(env, RAQSH_TEST_PROVIDER="generic")
    if mode == "provider":
        codex_profile = root / "codex-profile"
        claude_profile = root / "claude-profile"
        codex_profile.mkdir(mode=0o700)
        claude_profile.mkdir(mode=0o700)
        app_env.update(CODEX_HOME=str(codex_profile), CLAUDE_CONFIG_DIR=str(claude_profile),
                       RAQSH_TEST_PROVIDER="codex" if provider == "codex" else "claude")
    log_path = root / f"{mode}.log"
    with log_path.open("wb") as output, log_path.open(encoding="utf8") as log:
        with child(command, env=app_env, stdout=output, stderr=subprocess.STDOUT) as process:
            deadline = time.monotonic() + (PROVIDER_TIMEOUT + 45 if mode == "provider" else 45)
            version = None
            try:
                while time.monotonic() < deadline:
                    line = log.readline()
                    if line.startswith("raqsh-live:"):
                        report = json.loads(line.removeprefix("raqsh-live:"))
                        if report["event"] == "fail":
                            raise RuntimeError(report["message"])
                        if report["event"] == "paired":
                            if mode == "provider":
                                version = update_status_with_provider(helper, report, root, env, provider, app_env)
                            else:
                                update_status(helper, report, env)
                        if report["event"] == "pass":
                            require(process.wait(timeout=10) == 0, "Desktop failed to exit cleanly")
                            require(not (root / "runtime/bridge.sock").exists(), "Desktop left its socket behind")
                            if mode == "provider":
                                require(version, "The provider never handled the pairing")
                                report.update(provider=provider, version=version, tool=STATUS_TOOL)
                            return report
                    if not line:
                        require(process.poll() is None, f"Desktop exited early with status {process.returncode}")
                        time.sleep(0.05)
                raise RuntimeError(f"Timed out running {mode}")
            except Exception as failure:
                raise RuntimeError(f"{mode}: {failure}\n{log_path.read_text()}") from failure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop", type=Path)
    parser.add_argument("helper", type=Path)
    parser.add_argument("--stress-only", action="store_true")
    parser.add_argument("--provider", choices=("codex", "claude-code"), help="Run a model turn using an authenticated CLI")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("A logged-in macOS desktop session is required")
    if args.provider:
        if args.stress_only:
            parser.error("Choose a provider or the stress fixture")
        if not shutil.which("codex" if args.provider == "codex" else "claude"):
            parser.error(f"Install and authenticate the {args.provider} CLI first")
    with tempfile.TemporaryDirectory(prefix="raqsh-", dir="/tmp") as directory:
        root = Path(directory)
        (root / "project").mkdir()
        (root / "runtime").mkdir(mode=0o700)
        env = dict(os.environ, RAQSH_BENCH_PROJECT=str(root / "project"),
                   RAQSH_RUNTIME_DIR=str(root / "runtime"), RAQSH_TEST_LIBRARY=str(root / "library"))
        modes = ("provider", "reopen") if args.provider else ("about", "edit", "reopen", "stress")
        if args.stress_only:
            modes = ("stress",)
        for mode in modes:
            report = run_app(args.desktop.resolve(), args.helper.resolve(), root, env, mode, args.provider)
            if mode == "stress":
                report["eraserMedianMs"] = statistics.median(report["eraserBatchesMs"])
            print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
