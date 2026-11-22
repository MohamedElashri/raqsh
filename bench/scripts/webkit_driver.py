"""Local WebKitGTK WebDriver transport for the Linux benchmark and checks."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib import error, request


def wait_until(check, description, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if value := check():
                return value
        except (ConnectionError, error.URLError):
            pass
        time.sleep(0.01)
    raise RuntimeError(f"Timed out waiting for {description}.")


def ports():
    with socket.socket() as driver, socket.socket() as native:
        driver.bind(("127.0.0.1", 0))
        native.bind(("127.0.0.1", 0))
        return driver.getsockname()[1], native.getsockname()[1]


class Session:
    def __init__(self, send, session_id):
        self.send = send
        self.path = f"/session/{session_id}"

    def call(self, method, path, data=None):
        return self.send(method, self.path + path, data)

    def evaluate(self, script, *args, asynchronous=False):
        mode = "async" if asynchronous else "sync"
        return self.call("POST", f"/execute/{mode}", {"script": script, "args": args})

    def element(self, selector):
        element = self.call("POST", "/element", {"using": "css selector", "value": selector})
        return element["element-6066-11e4-a52e-4f735466cecf"]

    def click(self, selector):
        self.call("POST", f"/element/{self.element(selector)}/click", {})


def open_disclosure(session, selector):
    if not session.evaluate("return document.querySelector(arguments[0]).open;", selector):
        session.click(f"{selector} > summary")


def close_board(session):
    if session.evaluate('return !!document.querySelector(".board-header > summary");'):
        open_disclosure(session, ".board-header")
        session.click(".board-header > .board-menu > button:last-child")
    else:
        session.click(".board-header button")


@contextmanager
def webdriver():
    port, native_port = ports()
    endpoint = f"http://127.0.0.1:{port}"

    def send(method, path, data=None):
        body = None if data is None else json.dumps(data).encode()
        message = request.Request(endpoint + path, data=body, method=method, headers={"Content-Type": "application/json"})
        try:
            with request.urlopen(message, timeout=30) as response:
                return json.load(response)["value"]
        except error.HTTPError as failure:
            raise RuntimeError(f"WebDriver {method} {path} returned {failure.code}: {failure.read().decode()}") from failure

    @contextmanager
    def session(binary, args=()):
        options = {"application": str(Path(binary).resolve(strict=True)), "args": list(args)}
        capabilities = {"browserName": "wry", "tauri:options": options}
        created = send("POST", "/session", {"capabilities": {"alwaysMatch": capabilities}})
        active = Session(send, created["sessionId"])
        try:
            yield active
        finally:
            try:
                active.call("DELETE", "")
            except (RuntimeError, OSError):
                if not getattr(active, "terminated", False):
                    raise

    driver = subprocess.Popen(["tauri-driver", "--port", str(port), "--native-port", str(native_port)])
    try:
        wait_until(lambda: send("GET", "/status"), "local WebDriver")
        yield session, driver.pid
    finally:
        driver.terminate()
        driver.wait(timeout=5)


@contextmanager
def isolated_library():
    """Keep fixture databases, preferences and caches outside a regular library."""
    with tempfile.TemporaryDirectory(prefix="visual-board-bench-", ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        project = root / "worktree"
        project.mkdir()
        runtime = root / "runtime"
        runtime.mkdir(mode=0o700)
        sandbox = {
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "VISUAL_BOARD_BENCH_PROJECT": str(project),
            "VISUAL_BOARD_RUNTIME_DIR": str(runtime),
        }
        previous = {key: os.environ.get(key) for key in sandbox}
        os.environ.update(sandbox)
        try:
            yield root
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key)
                else:
                    os.environ[key] = value


def process_birth(parent, binary):
    pending = [parent]
    expected = Path(binary).resolve()
    while pending:
        pid = pending.pop()
        directory = Path("/proc") / str(pid)
        try:
            if (directory / "exe").readlink() == expected:
                fields = (directory / "stat").read_text().rsplit(") ", 1)[1].split()
                return pid, int(fields[19]) / os.sysconf("SC_CLK_TCK")
            for children in (directory / "task").glob("*/children"):
                pending.extend(int(pid) for pid in children.read_text().split())
        except (FileNotFoundError, ProcessLookupError):
            continue
