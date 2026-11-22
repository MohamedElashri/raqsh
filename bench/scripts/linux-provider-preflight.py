#!/usr/bin/env python3
"""Verify portable MCP with the installed provider CLIs on a synthetic board."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import runpy
import select
import shutil
import socket
import subprocess
import tempfile
import time

from webkit_driver import isolated_library, wait_until, webdriver

phase2 = runpy.run_path(str(Path(__file__).with_name("linux-p2-bridge.py")))
button = phase2["button"]
ready = phase2["ready"]
add_pairing = phase2["add_pairing"]
feedback_ui = phase2["feedback_ui"]
uuid = phase2["uuid"]

SERVER = "raqsh"
FEEDBACK = "Synthetic portable compatibility feedback."
RESPONSE = "Portable MCP round trip verified."
FEEDBACK_TOOLS = ("board_get_feedback", "board_ack_feedback", "board_post_response")


def provider_environment(root):
    env = {key: value for key, value in os.environ.items() if key in (
        "PATH", "LANG", "LC_ALL", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
        "RAQSH_RUNTIME_DIR",
    )}
    for variable, directory in (
        ("HOME", "provider-home"), ("CODEX_HOME", "codex-config"), ("CLAUDE_CONFIG_DIR", "claude-config"),
    ):
        path = root / directory
        path.mkdir(mode=0o700)
        env[variable] = str(path)
    env.update({"DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DISABLE_AUTOUPDATER": "1"})
    return env


def run(program, *args, cwd, env, timeout=20):
    completed = subprocess.run(
        [str(program), *args], cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout,
    )
    if completed.returncode:
        raise RuntimeError(f"{Path(program).name} exited with {completed.returncode}: {completed.stderr[-2000:]}")
    return completed.stdout.strip()


class AppServer:
    def __init__(self, process):
        self.process = process
        self.id = 0
        self.pending = bytearray()
        self.notifications = []

    def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b"\n")

    def receive(self, deadline):
        while b"\n" not in self.pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise RuntimeError("App Server response timed out.")
            chunk = os.read(self.process.stdout.fileno(), 8192)
            if not chunk:
                raise RuntimeError("App Server closed stdout.")
            self.pending.extend(chunk)
            if len(self.pending) > 2 * 1024 * 1024:
                raise RuntimeError("App Server response exceeded the preflight limit.")
        line, _, remainder = self.pending.partition(b"\n")
        self.pending = remainder
        return json.loads(line)

    def call(self, method, params):
        self.id += 1
        current = self.id
        self.send({"id": current, "method": method, "params": params})
        deadline = time.monotonic() + 25
        while True:
            message = self.receive(deadline)
            if "method" in message and "id" in message:
                raise RuntimeError(f"Unexpected App Server request during portable preflight: {message['method']}")
            if message.get("id") != current:
                if message.get("method") in ("item/completed", "turn/completed"):
                    self.notifications.append(message)
                continue
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error']}")
            return message["result"]

    def completed_turn(self, thread, turn):
        deadline = time.monotonic() + 120
        items = []
        while True:
            message = self.notifications.pop(0) if self.notifications else self.receive(deadline)
            if "id" in message and "method" in message:
                raise RuntimeError(f"Unexpected approval or server request: {message['method']}")
            params = message.get("params", {})
            if params.get("threadId") != thread:
                continue
            if message.get("method") == "item/completed" and params.get("turnId") == turn:
                items.append(params["item"])
            if message.get("method") == "turn/completed" and params["turn"]["id"] == turn:
                return params["turn"], items

    def tool(self, thread, name, arguments=None):
        result = self.call("mcpServer/tool/call", {
            "threadId": thread, "server": SERVER, "tool": name, "arguments": arguments or {},
        })
        return result.get("isError", False), result["structuredContent"]


@contextmanager
def app_server(codex, cwd, env, *, live=False):
    with tempfile.TemporaryFile() as stderr:
        with subprocess.Popen([str(codex), "app-server", "--stdio"], cwd=cwd, env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=stderr, bufsize=0) as process:
            try:
                yield AppServer(process)
            except (AssertionError, RuntimeError) as failure:
                if live:
                    raise
                stderr.seek(0)
                raise RuntimeError(f"{failure}\n{stderr.read().decode(errors='replace')[-2000:]}") from failure
            finally:
                process.stdin.close()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


def codex_workflow(codex, helper, cwd, env, binding, web, *, live=False):
    probe = json.loads(run(helper, "probe", "--pairing", binding, "--format", "codex", cwd=cwd, env=env))
    assert probe["provider"] == "codex" and probe["transport"] == "stdio"
    assert probe["session"]["binding"]["id"] == binding and probe["session"]["liveSteering"] == "unsupported"
    setup = run(helper, "setup", "--pairing", binding, "--format", "codex", cwd=cwd, env=env)
    if live:
        for tool in FEEDBACK_TOOLS:
            setup += f'\n[mcp_servers.{SERVER}.tools.{tool}]\napproval_mode = "approve"\n'
    Path(env["CODEX_HOME"], "config.toml").write_text(
        'cli_auth_credentials_store = "file"\n' + setup + "\n"
    )
    version = run(codex, "--version", cwd=cwd, env=env)

    with app_server(codex, cwd, env, live=live) as server:
        server.call("initialize", {"clientInfo": {"name": "raqsh_preflight", "version": "0.1.0"}})
        server.send({"method": "initialized"})
        thread = server.call("thread/start", {
            "cwd": str(cwd), "ephemeral": True, "sandbox": "read-only", "approvalPolicy": "on-request",
        })["thread"]["id"]
        statuses = server.call("mcpServerStatus/list", {
            "threadId": thread, "serverName": SERVER, "detail": "toolsAndAuthOnly",
        })["data"]
        status = next(item for item in statuses if item["name"] == SERVER)
        assert len(status["tools"]) == 9, status.get("toolsError")
        error, session = server.tool(thread, "board_session_state")
        assert not error and session["binding"]["id"] == binding and session["liveSteering"] == "unsupported"
        board = session["binding"]["boardId"]
        scope = {"boardId": board}
        error, boards = server.tool(thread, "board_list")
        assert not error and [item["id"] for item in boards["items"]] == [board]
        error, denial = server.tool(thread, "board_get", {"boardId": uuid()})
        assert error and denial["code"] == "forbidden"
        if live:
            verified = codex_model_turn(server, thread, board, cwd, web)
            return {"version": version, "tools_discovered": 9, "cross_board_access_denied": True,
                    "model_turn_started": True, **verified}
        error, page = server.tool(thread, "board_get_feedback", scope)
        assert not error and len(page["items"]) == 1
        item = page["items"][0]
        assert item["text"] == FEEDBACK and item["state"] == "offered"
        operation = uuid()
        error, ack = server.tool(thread, "board_ack_feedback", {
            **scope, "feedbackId": item["id"], "operationId": operation,
        })
        assert not error and ack["state"] == "acknowledged" and ack["ackId"] == operation
        error, response = server.tool(thread, "board_post_response", {
            **scope, "feedbackId": item["id"], "ackId": operation, "operationId": uuid(), "text": RESPONSE,
        })
        assert not error and response["response"] == RESPONSE

    wait_until(lambda: web.evaluate("""
        return document.querySelector(".agent-panel ol")?.textContent.includes(arguments[0]);
    """, RESPONSE), "portable response displayed")
    return {"version": version, "tools_discovered": 9, "cross_board_access_denied": True,
            "feedback_offered_acknowledged_and_answered": True, "model_turn_started": False}


def codex_model_turn(server, thread, board, cwd, web):
    ack_id = uuid()
    prompt = (
        "This is a synthetic integration test. Use only the raqsh MCP server. "
        "Do not run commands or read or edit files. "
        f"Call board_get_feedback with boardId {board}. Read the sole queued item. "
        f"Call board_ack_feedback with its feedbackId, the same boardId and operationId {ack_id}. "
        f"Then call board_post_response with the same boardId and feedbackId, ackId {ack_id}, "
        f"operationId {uuid()}, and text exactly {RESPONSE!r}. End the turn after posting."
    )
    turn_id = server.call("turn/start", {
        "threadId": thread, "cwd": str(cwd), "approvalPolicy": "never",
        "input": [{"type": "text", "text": prompt, "text_elements": []}],
    })["turn"]["id"]
    turn, items = server.completed_turn(thread, turn_id)
    if turn["status"] != "completed":
        raise RuntimeError(f"The Codex model turn ended with status {turn['status']}.")
    calls = [(item["server"], item["tool"], item["status"]) for item in items if item["type"] == "mcpToolCall"]
    assert calls == [(SERVER, name, "completed") for name in FEEDBACK_TOOLS], calls
    wait_until(lambda: web.evaluate("""
        const history = document.querySelector(".agent-panel ol");
        return history?.textContent.includes(arguments[0]) && history.textContent.includes("Acknowledged");
    """, RESPONSE), "model response displayed with acknowledged delivery")
    return {"turn_status": turn["status"], "model_tool_calls": FEEDBACK_TOOLS,
            "feedback_offered_acknowledged_and_answered": True, "response_displayed": True}


def claude_health(claude, helper, cwd, env, binding):
    probe = json.loads(run(helper, "probe", "--pairing", binding, "--format", "claude", cwd=cwd, env=env))
    assert probe["provider"] == "claude_code" and probe["transport"] == "stdio"
    assert probe["session"]["binding"]["id"] == binding and probe["session"]["feedback"] == "portable_tools"
    setup = run(helper, "setup", "--pairing", binding, "--format", "claude", cwd=cwd, env=env)
    entry = json.loads(setup)["mcpServers"][SERVER]
    version = run(claude, "--version", cwd=cwd, env=env)
    unapproved = "unapproved-board-probe"
    (cwd / ".mcp.json").write_text(json.dumps({"mcpServers": {unapproved: entry}}))
    pending = run(claude, "mcp", "list", cwd=cwd, env=env)
    assert any(line.startswith(f"{unapproved}:") and "Pending approval" in line
               for line in pending.splitlines()), pending
    run(claude, "mcp", "add-json", SERVER, json.dumps(entry), "--scope", "local", cwd=cwd, env=env)
    try:
        listing = run(claude, "mcp", "list", cwd=cwd, env=env)
        matching = [line for line in listing.splitlines() if line.startswith(f"{SERVER}:")]
        if not any("Connected" in line for line in matching):
            raise RuntimeError(f"Claude Code MCP health check did not connect: {listing}")
    finally:
        run(claude, "mcp", "remove", SERVER, "--scope", "local", cwd=cwd, env=env)
    remaining = run(claude, "mcp", "list", cwd=cwd, env=env)
    assert not any(line.startswith(f"{SERVER}:") for line in remaining.splitlines()), remaining
    return {"version": version, "unapproved_project_server_pending": True,
            "stdio_health_connected": True, "local_registration_removed": True,
            "model_turn_started": False}


def sha256(path):
    with path.open("rb") as binary:
        return hashlib.file_digest(binary, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop", type=Path)
    parser.add_argument("helper", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--codex-auth-file", type=Path,
                        help="Use an existing Codex credential in a disposable profile for one synthetic model turn.")
    args = parser.parse_args()
    interfaces = [name for _, name in socket.if_nameindex()]
    if interfaces != ["lo"] and args.codex_auth_file is None:
        parser.error("Run this proof in a network namespace with only loopback.")
    codex = shutil.which("codex")
    claude = shutil.which("claude")
    if not codex or (not claude and args.codex_auth_file is None):
        parser.error("Install the Codex and Claude Code CLIs for this proof.")

    helper = args.helper.resolve(strict=True)
    result = {
        "interfaces": interfaces, "desktop_sha256": sha256(args.desktop), "helper_sha256": sha256(helper),
    }
    with isolated_library() as root, webdriver() as (launch, _), launch(args.desktop, ("--fixture=empty",)) as web:
        env = provider_environment(root)
        if args.codex_auth_file is not None:
            destination = Path(env["CODEX_HOME"], "auth.json")
            destination.touch(mode=0o600, exist_ok=False)
            shutil.copyfile(args.codex_auth_file, destination)
        ready(web)
        button(web, "Agents")
        codex_pairing = add_pairing(web, "Codex preflight")
        feedback_ui(web, FEEDBACK)
        live = args.codex_auth_file is not None
        result["codex"] = codex_workflow(codex, helper, root / "worktree", env, codex_pairing, web, live=live)
        if not live:
            claude_pairing = add_pairing(web, "Claude Code preflight")
            result["claude_code"] = claude_health(claude, helper, root / "worktree", env, claude_pairing)

    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
