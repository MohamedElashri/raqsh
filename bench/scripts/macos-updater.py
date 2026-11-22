#!/usr/bin/env python3
"""Verify user-initiated check, signature validation, install, and relaunch on macOS."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import plistlib
import shutil
import ssl
import subprocess
import sys
import tempfile
from threading import Thread
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed: {result.stderr[-1000:]}")


def bundle(path, desktop, helper, version, replacement=False):
    contents = path / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir()
    shutil.copy2(desktop, contents / "MacOS/visual-board")
    shutil.copy2(helper, contents / "MacOS/visual-board-mcp")
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleName": "Raqsh Update Fixture", "CFBundleIdentifier": "dev.local.visualboard.updatefixture",
        "CFBundleExecutable": "visual-board", "CFBundlePackageType": "APPL",
        "CFBundleVersion": version, "CFBundleShortVersionString": version,
    }))
    if replacement:
        (contents / "Resources/update-fixture").write_text("replacement")
    run("codesign", "--force", "--sign", "-", path)


def main(desktop, helper):
    with tempfile.TemporaryDirectory(prefix="raqsh-updater-", dir="/tmp") as directory:
        root = Path(directory).resolve()
        (root / "runtime").mkdir(mode=0o700)
        initial = root / "Raqsh Fixture.app"
        replacement = root / "build" / initial.name
        bundle(initial, desktop, helper, "0.0.0")
        bundle(replacement, desktop, helper, "999.0.0", replacement=True)
        asset = "raqsh-macos-universal.app.tar.gz"
        payload = root / asset
        run("env", "COPYFILE_DISABLE=1", "tar", "-czf", payload, "-C", replacement.parent, replacement.name)
        key = root / "fixture.key"
        run("pnpm", "exec", "tauri", "signer", "generate", "--ci", "--write-keys", key)
        run("pnpm", "exec", "tauri", "signer", "sign", "--private-key-path", key, "--app-version", "999.0.0", payload)
        signature = (root / f"{asset}.sig").read_text().strip()
        cert, cert_key = root / "cert.pem", root / "cert.key"
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
            "-keyout", cert_key, "-out", cert)

        requests = []
        asset_path = f"/download/v999.0.0/{asset}"
        archive = payload.read_bytes()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                if self.path == "/latest.json":
                    entry = {"url": f"https://127.0.0.1:{server.server_port}{asset_path}", "signature": signature}
                    body = json.dumps({"version": "999.0.0", "platforms": {
                        "darwin-aarch64": entry, "darwin-x86_64": entry,
                    }}).encode()
                elif self.path == asset_path:
                    body = b"corrupted package" if requests.count(asset_path) == 1 else archive
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, cert_key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            Thread(target=server.serve_forever, daemon=True).start()
            result = root / "restarted"
            log_path = root / "app.log"
            env = dict(os.environ, VISUAL_BOARD_RUNTIME_DIR=str(root / "runtime"),
                       VISUAL_BOARD_TEST_LIBRARY=str(root / "library"),
                       VISUAL_BOARD_TEST_UPDATE_PORT=str(server.server_port),
                       VISUAL_BOARD_TEST_UPDATE_KEY=(root / "fixture.key.pub").read_text().strip())
            try:
                with log_path.open("wb") as log, subprocess.Popen(
                    [initial / "Contents/MacOS/visual-board", "--macos-live=updater", f"--update-fixture-result={result}"],
                    env=env, stdout=log, stderr=subprocess.STDOUT,
                ) as app:
                    try:
                        deadline = time.monotonic() + 30
                        observed_idle = False
                        while time.monotonic() < deadline:
                            output = log_path.read_text()
                            if not observed_idle and '"event":"updater-ready"' in output:
                                require(not requests, "Opening About contacted the update server")
                                observed_idle = True
                            require('"event":"fail"' not in output, output)
                            if result.is_file():
                                break
                            time.sleep(0.04)
                        require(result.is_file(), f"Raqsh did not relaunch after installing the update.\n{log_path.read_text()}")
                        require(app.wait(timeout=5) == 0, "The previous Raqsh process failed to exit")
                        require(observed_idle and requests == ["/latest.json", asset_path, asset_path], requests)
                        require('"event":"updater-installed"' in log_path.read_text(), "The install action did not finish")
                        require((initial / "Contents/Resources/update-fixture").is_file(), "The bundle was not replaced")
                        run("codesign", "--verify", "--deep", "--strict", initial)
                    finally:
                        if app.poll() is None:
                            app.kill()
                            app.wait(timeout=5)
            finally:
                server.shutdown()
    print(json.dumps({"event": "pass", "mode": "updater", "manual_check": True,
                      "corrupted_package_rejected": True, "signed_bundle_installed_and_restarted": True}))


if __name__ == "__main__":
    main(*(Path(arg).resolve(strict=True) for arg in sys.argv[1:]))
