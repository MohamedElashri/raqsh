#!/usr/bin/env python3
"""Exercise and measure the board bridge with the pinned official Python MCP client."""

import argparse
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import runpy
import select
import signal
import socket
import statistics
import struct
import subprocess
import time
from uuid import uuid4

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from webkit_driver import isolated_library, process_birth, wait_until, webdriver

button = runpy.run_path(str(Path(__file__).with_name("linux-fixture-proof.py")))["button"]
process_tools = runpy.run_path(str(Path(__file__).with_name("linux-process-family.py")))
family, sample = (process_tools[key] for key in ("process_family", "sample"))


def uuid():
    return str(uuid4())


def ready(session):
    try:
        wait_until(lambda: session.evaluate('return document.querySelector(".lean-editor")?.dataset.editorReady;'), "persisted editor")
    except RuntimeError as failure:
        raise RuntimeError(session.evaluate("return document.body.innerText;")) from failure


def add_pairing(session, label, project=False):
    session.evaluate('''
        const provider = document.querySelector('.agent-panel select[name="provider"]');
        provider.value = 'generic';
        provider.dispatchEvent(new Event('change', {bubbles: true}));
        const name = document.querySelector('.agent-panel input[name="label"]');
        name.value = arguments[0];
        document.querySelector('.agent-panel input[name="project"]').checked = arguments[1];
    ''', label, project)
    button(session, "Approve pairing")
    return wait_until(lambda: session.evaluate('''
        const select = document.querySelector('.agent-panel select[name="binding"]');
        return select?.selectedOptions[0]?.textContent.startsWith(arguments[0] + " ·") ? select.value : null;
    ''', label), f"approved {label} pairing")


def command(helper, combined, action, binding):
    args = ["mcp"] if combined else []
    return [str(helper.resolve()), *args, action, "--pairing", binding]


@asynccontextmanager
async def client(helper, combined, binding):
    args = command(helper, combined, "serve", binding)
    config = StdioServerParameters(command=args[0], args=args[1:], env=dict(os.environ))
    async with stdio_client(config) as (read, write), ClientSession(read, write) as session:
        info = await session.initialize()
        assert info.protocolVersion == "2025-11-25", info.protocolVersion
        yield session


async def call(session, name, arguments=None, error=None):
    reply = await session.call_tool(name, arguments or {})
    value = reply.structuredContent
    assert value is not None, reply
    if error is None:
        assert not reply.isError, value
    else:
        assert reply.isError and value["code"] == error, value
    return value


async def retry_transport(session, name, arguments=None):
    """Permit a bounded retry of a read or an idempotent write."""
    for attempt in range(3):
        try:
            return await call(session, name, arguments), attempt
        except AssertionError as failure:
            value = failure.args[0]
            if attempt == 2 or not isinstance(value, dict) or value.get("code") != "transport":
                raise
            await asyncio.sleep(0.25)


def card(task):
    return {"id": task, "kind": "task", "title": "Verify the local bridge", "description": "",
            "status": "todo", "priority": "normal", "dropped": False,
            "x": 80, "y": 100, "width": 215, "height": 80, "parent": None, "order": 0, "revision": 0}


def socket_call(path, data):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(6)
        connection.connect(str(path))
        connection.sendall(data)
        with connection.makefile("rb") as stream:
            header = stream.read(4)
            if not header:
                return None
            length = struct.unpack(">I", header)[0]
            return json.loads(stream.read(length))


def frame(value):
    data = json.dumps(value).encode()
    return struct.pack(">I", len(data)) + data


def request(auth, version=1):
    return {"version": version, "requestId": uuid(), "credential": auth,
            "call": {"tool": "board_session_state", "arguments": {}}}


def exercise_wire(root, binding):
    path = root / "runtime/bridge.sock"
    credentials = root / f"data/dev.local.visualboard/library/pairings/{binding}.json"
    assert (path.stat().st_mode & 0o777) == 0o600
    assert (path.parent.stat().st_mode & 0o777) == 0o700
    assert (credentials.stat().st_mode & 0o777) == 0o600
    auth = json.loads(credentials.read_text())
    assert socket_call(path, frame(request(auth, 2)))["result"]["Err"]["code"] == "version"
    bad = {**auth, "secret": [0] * 32}
    assert socket_call(path, frame(request(bad)))["result"]["Err"]["code"] == "forbidden"
    for message in (b"\x00\x40\x00\x01", b"\x00\x00\x00\x01{"):
        try:
            assert socket_call(path, message) is None
        except ConnectionResetError:
            pass
    started = time.monotonic()
    assert socket_call(path, b"\x00") is None
    assert 4.5 <= time.monotonic() - started < 6, "absolute frame timeout"
    return {"socket_mode": "0600", "runtime_mode": "0700", "credential_mode": "0600",
            "version_and_secret_denied": True, "malformed_oversize_timeout": True}


def verify_malformed_stdio(helper, binding):
    with subprocess.Popen(command(helper, False, "serve", binding), stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE) as proc:
        proc.stdin.write(b"}\n")
        proc.stdin.flush()
        assert json.loads(proc.stdout.readline())["error"]["code"] == -32700
        proc.stdin.write(b"x" * (4 * 1024 * 1024 + 1))
        proc.stdin.flush()
        assert "4 MiB" in json.loads(proc.stdout.readline())["error"]["message"]
        assert proc.wait(timeout=5) == 0


def verify_stdio_cancellation(helper, binding, root):
    # Hold one framed reply so cancellation is deterministic at the MCP transport boundary.
    directory = root / "cancel-runtime"
    directory.mkdir(mode=0o700)
    path = directory / "bridge.sock"
    env = {**os.environ, "VISUAL_BOARD_RUNTIME_DIR": str(directory)}
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(path))
        path.chmod(0o600)
        listener.listen()
        listener.settimeout(5)
        with subprocess.Popen(command(helper, False, "serve", binding), env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, bufsize=0) as proc:
            def send(method, params=None, identifier=None):
                value = {"jsonrpc": "2.0", "method": method, "params": params or {}}
                if identifier is not None:
                    value["id"] = identifier
                proc.stdin.write(json.dumps(value).encode() + b"\n")

            def receive():
                assert select.select([proc.stdout], [], [], 5)[0], "MCP cancellation reply deadline"
                return json.loads(proc.stdout.readline())

            send("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                "clientInfo": {"name": "cancellation-proof", "version": "1"}}, 1)
            assert receive()["id"] == 1
            send("notifications/initialized")
            send("tools/call", {"name": "board_session_state"}, 2)
            connection, _ = listener.accept()
            with connection, connection.makefile("rb") as wire:
                connection.settimeout(5)
                length = struct.unpack(">I", wire.read(4))[0]
                accepted = json.loads(wire.read(length))
                send("tools/list", identifier=3)
                send("notifications/cancelled", {"requestId": 2})
                send("notifications/cancelled", {"requestId": 3})
                send("ping", identifier=4)
                time.sleep(0.1)
                connection.sendall(frame({"requestId": accepted["requestId"], "version": 1, "result": {"Ok": {}}}))
                assert receive()["id"] == 4
            proc.stdin.close()
            assert proc.wait(timeout=5) == 0


def verify_socket_saturation(root):
    path = root / "runtime/bridge.sock"
    sockets = []
    try:
        for _ in range(16):
            connection = socket.socket(socket.AF_UNIX)
            connection.settimeout(2)
            connection.connect(str(path))
            connection.sendall(b"\x00")
            sockets.append(connection)
        time.sleep(0.1)
        try:
            assert socket_call(path, b"\x00") is None
        except ConnectionResetError:
            pass
    finally:
        for connection in sockets:
            connection.close()
    time.sleep(0.1)


def feedback_ui(web, text):
    web.evaluate('document.querySelector(".agent-panel textarea").value = arguments[0];', text)
    button(web, "Queue feedback")
    wait_until(lambda: web.evaluate('return document.querySelector(".agent-panel ol")?.textContent.includes(arguments[0]);', text),
               "persisted feedback shown")


async def proof(launch, parent, desktop, helper, root):
    with launch(desktop, ("--fixture=empty",)) as web:
        ready(web)
        button(web, "Agents")
        a = add_pairing(web, "Client A")
        b = add_pairing(web, "Client B")
        project = add_pairing(web, "Project client", True)
        assert len({a, b, project}) == 3
        pid, _ = wait_until(lambda: process_birth(parent, desktop), "owned GUI")
        setup = subprocess.check_output(command(helper, False, "setup", a), text=True)
        registration = json.loads(setup)["mcpServers"]["visual-board"]
        assert registration["command"] == str(helper.resolve()) and registration["args"][-1] == a
        # Deliberately leave the old socket entry to verify restart after a hard kill.
        os.kill(pid, signal.SIGKILL)
        web.terminated = True

    async with client(helper, False, a) as one, client(helper, False, b) as two, client(helper, False, project) as wide:
        tools = await one.list_tools()
        assert len(tools.tools) == 9
        await call(one, "board_list", error="desktop_offline")
        with launch(desktop, ("--fixture=empty",)) as web:
            ready(web)
            competing = subprocess.run([str(desktop.resolve())], capture_output=True, timeout=5)
            assert competing.returncode != 0, "second desktop unexpectedly took socket ownership"
            permitted = await call(one, "board_list")
            board = permitted["items"][0]["id"]
            assert len(permitted["items"]) == 1
            scope = {"boardId": board}
            assert (await call(one, "board_open", scope))["id"] == board
            await call(one, "board_list", {"projectId": uuid()}, "forbidden")
            state = await call(one, "board_session_state")
            assert state["binding"]["boardId"] == board and state["liveSteering"] == "unsupported"
            doctor = json.loads(subprocess.check_output(command(helper, False, "doctor", a), text=True))
            assert doctor == state
            await call(one, "board_open", {"title": "Outside grant", "operationId": uuid()}, "forbidden")
            create = {"title": "Other board", "operationId": uuid()}
            other = (await call(wide, "board_open", create))["id"]
            assert (await call(wide, "board_open", create))["id"] == other
            await call(one, "board_get", {"boardId": other}, "forbidden")
            await call(wide, "board_get", {"boardId": uuid()}, "forbidden")
            offscreen = {"boardId": other, "operation": {"id": uuid(), "expectedRevision": 0,
                         "changes": [{"type": "setNode", "node": card(uuid())}]}}
            assert (await call(wide, "board_apply", offscreen))["revision"] == 1
            assert (await call(wide, "board_get", {"boardId": other}))["page"]["items"]
            assert not web.evaluate('return !!document.querySelector("[data-card-id]");')

            task = uuid()
            op = {**scope, "operation": {"id": uuid(), "expectedRevision": 0, "changes": [{"type": "setNode", "node": card(task)}]}}
            first = await call(one, "board_apply", op)
            wait_until(lambda: web.evaluate('return !!document.querySelector("[data-card-id]");'), "remote card projected")
            assert first["revision"] == 1 and first["actor"] == a
            status = {**scope, "taskId": task, "status": "inProgress", "operationId": uuid(), "expectedRevision": 1}
            assert (await call(two, "board_set_task_status", status))["revision"] == 2
            wait_until(lambda: web.evaluate('return document.querySelector("[data-card-id]")?.dataset.status === "inProgress";'), "remote status projected")
            assert await call(one, "board_apply", op) == first
            assert (await call(two, "board_set_task_status", status))["revision"] == 2
            await call(two, "board_apply", op, "invalid_request")
            await call(one, "board_apply", {**scope, "operation": {**op["operation"], "expectedRevision": 2}}, "invalid_request")
            stale = await call(one, "board_set_task_status", {**status, "operationId": uuid()}, "revision_conflict")
            assert stale["currentRevision"] == 2
            assert (await call(one, "board_get", scope))["page"]["items"][0]["statusSource"] == b
            deltas = await call(one, "board_get", {**scope, "sinceRevision": 0})
            assert [delta["revision"] for delta in deltas["deltas"]] == [1, 2]
            await call(one, "board_get", {**scope, "offset": 12, "revision": 1}, "revision_conflict")

            button(web, "Agents")
            wait_until(lambda: web.evaluate('return document.querySelector(".agent-panel select[name=binding]")?.options.length === 3;'), "paired clients shown")
            web.evaluate('''
                const select = document.querySelector('.agent-panel select[name="binding"]');
                select.value = arguments[0];
                select.dispatchEvent(new Event("change", {bubbles: true}));
            ''', a)
            feedback_ui(web, "Cancelled message")
            button(web, "Cancel feedback")
            wait_until(lambda: web.evaluate('return Array.from(document.querySelectorAll(".agent-panel ol small")).some(item => item.textContent.endsWith(" · Cancelled"));'), "cancelled feedback")
            feedback_ui(web, "Check the implementation plan")
            assert (await call(two, "board_get_feedback", scope))["items"] == []
            items = await call(one, "board_get_feedback", scope)
            assert len(items["items"]) == 1 and items["items"][0]["state"] == "offered"
            assert await call(one, "board_get_feedback", scope) == items
            item = items["items"][0]
            ack = {**scope, "feedbackId": item["id"], "operationId": uuid()}
            await call(two, "board_ack_feedback", ack, "forbidden")
            await call(wide, "board_ack_feedback", {**ack, "boardId": other}, "forbidden")
            acknowledged = await call(one, "board_ack_feedback", ack)
            assert acknowledged["state"] == "acknowledged"
            assert await call(one, "board_ack_feedback", ack) == acknowledged
            response = {**scope, "feedbackId": item["id"], "operationId": uuid(), "ackId": ack["operationId"], "text": "Reviewed the plan."}
            await call(one, "board_post_response", {**response, "ackId": uuid()}, "invalid_request")
            posted = await call(one, "board_post_response", response)
            assert posted["response"] == response["text"]
            assert await call(one, "board_post_response", response) == posted
            assert (await call(one, "board_get_feedback", {**scope, "after": items["nextCursor"]}))["items"] == []
            wait_until(lambda: web.evaluate('return document.querySelector(".agent-panel ol")?.textContent.includes("Reviewed the plan.");'), "response shown")
            wire = await asyncio.to_thread(exercise_wire, root, a)
            await asyncio.to_thread(verify_socket_saturation, root)
            for _ in range(100):
                assert (await call(one, "board_list"))["items"][0]["id"] == board
            verify_malformed_stdio(helper, a)
            verify_stdio_cancellation(helper, a, root)

            removed = json.loads(subprocess.check_output(command(helper, False, "remove", project), text=True))
            assert removed["revoked"]
            await call(wide, "board_list", error="forbidden")
            # Shutdown through the normal close coordinator while the helpers remain connected to stdio.
            web.evaluate('setTimeout(() => window.__TAURI_INTERNALS__.invoke("finish_close"), 100); return true;')
            wait_until(lambda: process_birth(parent, desktop) is None, "desktop shutdown")
            web.terminated = True
            assert not (root / "runtime/bridge.sock").exists()
        await call(one, "board_get", scope, "desktop_offline")
        with launch(desktop, ("--fixture=empty",)) as web:
            ready(web)
            assert (await call(one, "board_get", scope))["board"]["semanticRevision"] == 2
            assert (await call(one, "board_get_feedback", scope))["items"][0]["response"] == "Reviewed the plan."
    symlink_runtime = root / "symlink-runtime"
    symlink_runtime.mkdir(mode=0o700)
    marker = root / "untouched"
    marker.write_text("marker")
    path = symlink_runtime / "bridge.sock"
    path.symlink_to(marker)
    rejected = subprocess.run([str(desktop.resolve())],
                              env={**os.environ, "VISUAL_BOARD_RUNTIME_DIR": str(symlink_runtime)},
                              capture_output=True, timeout=5)
    assert rejected.returncode != 0 and path.is_symlink() and marker.read_text() == "marker"
    return {**wire, "official_tools": 9, "desktop_offline_start_and_restart": True,
            "idempotent_mutation_creation_and_status": True, "cross_project_board_client_denied": True,
            "feedback_cursor_cancel_ack_response": True, "cli_setup_doctor_remove": True,
            "malformed_stdio": True, "stdio_cancellation": True, "helper_eof": True,
            "socket_saturation_and_recovery": True, "reconnect_calls": 100,
            "desktop_socket_cleanup": True, "single_desktop_owner": True, "symlink_rejected": True}


def helper_inventory(executable):
    expected = Path(executable).resolve()
    inventory = []
    for process in family(os.getpid()):
        pid = process["pid"]
        folder = Path("/proc") / str(pid)
        try:
            command = (folder / "cmdline").read_bytes().split(b"\x00")
            if (folder / "exe").readlink() != expected or b"serve" not in command:
                continue
            metrics = (folder / "smaps_rollup").read_text()
            pss = int(next(line.split()[1] for line in metrics.splitlines() if line.startswith("Pss:")))
            inventory.append({"pid": pid, "pss_kib": pss, "cpu_ticks": process["cpu_ticks"], "webview_children": [
                item["name"] for item in family(pid) if "WebKit" in item["name"]]})
        except (OSError, StopIteration):
            continue
    return inventory


async def measure(launch, parent, desktop, helper, combined, idle_seconds, fixture):
    with launch(desktop, (f"--fixture={fixture}",)) as web:
        ready(web)
        button(web, "Agents")
        bindings = [add_pairing(web, f"Benchmark {n}") for n in range(1, 5)]
        button(web, "Close")
        pid, _ = process_birth(parent, desktop)
        results = []
        async with AsyncExitStack() as stack:
            clients = []
            for count in (0, 1, 2, 4):
                while len(clients) < count:
                    session = await stack.enter_async_context(client(helper, combined, bindings[len(clients)]))
                    assert (await call(session, "board_list"))["items"]
                    clients.append(session)
                await asyncio.sleep(5)
                traces = []
                for _ in range(3):
                    traces.append((sample(pid), helper_inventory(helper)))
                    await asyncio.sleep(0.5)
                assert all(len(helpers) == count and not any(each["webview_children"] for each in helpers)
                           for _, helpers in traces)
                app_pss = statistics.median(sum(p["pss_kib"] for p in app) for app, _ in traces)
                helpers_pss = statistics.median(sum(p["pss_kib"] for p in helpers) for _, helpers in traces)
                result = {"clients": count, "app_pss_kib": app_pss, "helpers_pss_kib": helpers_pss,
                          "aggregate_pss_kib": app_pss + helpers_pss, "desktop_processes": traces[-1][0],
                          "helpers": traces[-1][1]}
                if count in (0, 4):
                    start = time.monotonic()
                    app, helpers = sample(pid), helper_inventory(helper)
                    await asyncio.sleep(idle_seconds)
                    end_app, end_helpers = sample(pid), helper_inventory(helper)
                    assert {p["pid"] for p in helpers} == {p["pid"] for p in end_helpers}
                    seconds = time.monotonic() - start
                    cpu = lambda processes: sum(p["cpu_ticks"] for p in processes)
                    hz = os.sysconf("SC_CLK_TCK")
                    result["idle_seconds"] = seconds
                    result["desktop_idle_cpu_percent"] = 100 * (cpu(end_app) - cpu(app)) / hz / seconds
                    result["helpers_idle_cpu_percent"] = 100 * (cpu(end_helpers) - cpu(helpers)) / hz / seconds
                results.append(result)
                print(f'{"D1" if combined else "D2"} {count}: {result["aggregate_pss_kib"] / 1024:.1f} MiB PSS', flush=True)
        wait_until(lambda: not helper_inventory(helper), "MCP helpers exit on SDK close")
    return results


def executable(path):
    with path.open("rb") as file:
        return {"bytes": path.stat().st_size, "sha256": hashlib.file_digest(file, "sha256").hexdigest(),
                "dynamic_libraries": subprocess.check_output(["ldd", str(path.resolve())], text=True).splitlines()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop", type=Path)
    parser.add_argument("helper", type=Path)
    parser.add_argument("--combined", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--variant", choices=("D1", "D2"))
    parser.add_argument("--fixture", choices=("empty", "normal"), default="normal")
    parser.add_argument("--idle-seconds", type=int, default=60)
    args = parser.parse_args()
    if args.variant == "D1" and args.combined is None:
        parser.error("Supply --combined to measure D1.")
    sdk = importlib.metadata.version("mcp")
    assert sdk == "1.26.0", sdk
    result = {"mcp_sdk": sdk, "protocol": "2025-11-25", "interfaces": [name for _, name in socket.if_nameindex()],
              "desktop": executable(args.desktop), "helper": executable(args.helper)}
    if args.combined or args.variant:
        result["fixture"] = args.fixture
        variants = [("D2", args.desktop, args.helper, False)]
        if args.combined:
            result["combined"] = executable(args.combined)
            variants.insert(0, ("D1", args.combined, args.combined, True))
        for key, desktop, helper, combined in variants:
            if args.variant is not None and args.variant != key:
                continue
            with isolated_library(), webdriver() as (launch, parent):
                result[key] = asyncio.run(measure(launch, parent, desktop, helper, combined, args.idle_seconds, args.fixture))
            args.output.write_text(json.dumps(result, indent=2) + "\n")
    else:
        with isolated_library() as root, webdriver() as (launch, parent):
            result["proof"] = asyncio.run(proof(launch, parent, args.desktop, args.helper, root))
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Evidence in {args.output}")


if __name__ == "__main__":
    main()
