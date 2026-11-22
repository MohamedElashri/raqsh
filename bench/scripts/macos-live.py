#!/usr/bin/env python3
"""Run the macOS WebKit editor and MCP sidecar against a disposable library."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import statistics
import subprocess
import sys
import tempfile
import time
from uuid import uuid4


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
        result = send("tools/call", {"name": "board_set_task_status", "arguments": {
            "boardId": board, "taskId": pairing["task"], "status": "done",
            "expectedRevision": pairing["revision"], "operationId": str(uuid4()),
        }}, 3)
        require(not result.get("isError") and result["structuredContent"]["revision"] == pairing["revision"] + 1,
                result)
        process.stdin.close()
        require(process.wait(timeout=5) == 0, "MCP helper failed to exit cleanly")


def run_app(desktop, helper, root, env, mode):
    fixture = "stress" if mode == "stress" else "empty"
    command = [desktop, f"--fixture={fixture}", f"--macos-live={mode}"]
    log_path = root / f"{mode}.log"
    with log_path.open("wb") as output, log_path.open(encoding="utf8") as log:
        with child(command, env=env, stdout=output, stderr=subprocess.STDOUT) as process:
            deadline = time.monotonic() + 45
            try:
                while time.monotonic() < deadline:
                    line = log.readline()
                    if line.startswith("raqsh-live:"):
                        report = json.loads(line.removeprefix("raqsh-live:"))
                        if report["event"] == "fail":
                            raise RuntimeError(report["message"])
                        if report["event"] == "paired":
                            update_status(helper, report, env)
                        if report["event"] == "pass":
                            require(process.wait(timeout=10) == 0, "Desktop failed to exit cleanly")
                            require(not (root / "runtime/bridge.sock").exists(), "Desktop left its socket behind")
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
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("A logged-in macOS desktop session is required")
    with tempfile.TemporaryDirectory(prefix="raqsh-", dir="/tmp") as directory:
        root = Path(directory)
        (root / "project").mkdir()
        (root / "runtime").mkdir(mode=0o700)
        env = dict(os.environ, VISUAL_BOARD_BENCH_PROJECT=str(root / "project"),
                   VISUAL_BOARD_RUNTIME_DIR=str(root / "runtime"), VISUAL_BOARD_TEST_LIBRARY=str(root / "library"))
        modes = ("stress",) if args.stress_only else ("edit", "reopen", "stress")
        for mode in modes:
            report = run_app(args.desktop.resolve(), args.helper.resolve(), root, env, mode)
            if mode == "stress":
                report["eraserMedianMs"] = statistics.median(report["eraserBatchesMs"])
            print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
