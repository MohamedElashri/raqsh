#!/usr/bin/env python3
"""Check named setup and cleanup with installed clients in disposable profiles."""

import argparse
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import shutil
import subprocess

from webkit_driver import isolated_library, ports, wait_until, webdriver

button = runpy.run_path(str(Path(__file__).with_name("linux-fixture-proof.py")))["button"]


def run(program, *args, cwd, env, check=True):
    result = subprocess.run(
        [program, *args], cwd=cwd, env=env, text=True, capture_output=True, timeout=25, check=False,
    )
    if check and result.returncode:
        raise RuntimeError(f"{Path(program).name} exited with {result.returncode}: {result.stderr[-2000:]}")
    return result


def pair(web, profile):
    wait_until(lambda: web.evaluate("""
        return !!document.querySelector(`.agent-panel select[name=provider] option[value=${arguments[0]}]:enabled`);
    """, profile), f"{profile} in the Agents picker")
    web.evaluate("""
        const picker = document.querySelector('.agent-panel select[name=provider]');
        picker.value = arguments[0];
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('.agent-panel input[name=label]').value = arguments[0];
    """, profile)
    button(web, "Approve pairing")
    return wait_until(lambda: web.evaluate("""
        const picker = document.querySelector('.agent-panel select[name=binding]');
        return picker?.selectedOptions[0]?.textContent.startsWith(arguments[0] + ' ·') ? picker.value : null;
    """, profile), f"{profile} pairing")


def configuration(web):
    return json.loads(wait_until(lambda: web.evaluate("""
        return document.querySelector('.agent-panel textarea[aria-label="MCP configuration"]')?.value;
    """), "generated harness configuration"))


def revoke(web):
    button(web, "Revoke access")
    button(web, "Revoke pairing")
    wait_until(lambda: web.evaluate("""
        return !document.querySelector('.agent-panel select[name=binding]');
    """), "pairing revoked")


def check_opencode(server, cwd, env):
    env = dict(env, OPENCODE_PASSWORD=secrets.token_urlsafe(24))
    port, _ = ports()
    endpoint = f"http://127.0.0.1:{port}"
    command = ["opencode", "serve", "--hostname", "127.0.0.1", "--port", str(port)]
    with subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as service:
        try:
            last = None

            def connected():
                nonlocal last
                if service.poll() is not None:
                    raise RuntimeError(f"Disposable OpenCode service exited with {service.returncode}.")
                last = run("opencode", "mcp", "list", "--server", endpoint, cwd=cwd, env=env, check=False)
                return last.returncode == 0 and any(
                    server in line and re.search(r"\bconnected\b", line, re.IGNORECASE)
                    for line in last.stdout.splitlines()
                )

            try:
                wait_until(connected, "OpenCode to discover its local MCP server", timeout=15)
            except RuntimeError as failure:
                if last is None:
                    raise
                raise RuntimeError(f"{failure}\n{last.stdout}\n{last.stderr[-2000:]}") from failure
        finally:
            if service.poll() is None:
                service.terminate()
                try:
                    service.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    service.kill()
                    service.wait(timeout=5)


def check_profile(web, helper, profile, cwd, env):
    binding = pair(web, profile)
    version = run(profile if profile != "antigravity" else "agy", "--version", cwd=cwd, env=env).stdout.strip()
    setup = run(helper, "setup", "--pairing", binding, "--format", profile, cwd=cwd, env=env)
    expected = json.loads(setup.stdout)
    entries = expected["mcp"]["servers"] if profile == "opencode" else expected["mcpServers"]
    server, = entries
    probe = run(helper, "probe", "--pairing", binding, "--format", profile, cwd=cwd, env=env)
    state = json.loads(probe.stdout)
    assert state["provider"] == profile, state
    assert state["session"]["binding"]["id"] == binding, state
    assert state["session"]["feedback"] == "portable_tools", state

    if profile == "pi":
        wait_until(lambda: web.evaluate("""
            return document.querySelector('.agent-panel output[role=status]')?.textContent.includes('registered');
        """), "Pi registration to finish")
        path = Path(env["PI_CODING_AGENT_DIR"], "mcp.json")
        entries = json.loads(path.read_text())["mcpServers"]
        assert entries["other"]["enabled"] is False, entries
        assert entries.get(server) == expected["mcpServers"][server], entries
        listed = json.loads(run("pi", "mcp", "list", "--json", cwd=cwd, env=env).stdout)
        found = next(entry for entry in listed["servers"] if entry["name"] == server)
        assert found["state"] == "connected" and len(found["tools"]) == 9, found
        outcome = "connected and discovered all nine MCP tools"
    else:
        assert configuration(web) == expected
        if profile == "opencode":
            path = cwd / "opencode.json"
            path.write_text(json.dumps(expected))
            check_opencode(server, cwd, env)
            outcome = "connected to Raqsh over stdio"
        else:
            path = Path(env["HOME"], ".gemini", "config", "mcp_config.json")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(expected))
            output = run("agy", "mcp", "list", cwd=cwd, env=env).stdout
            assert any(server in line and "stdio" in line and "enabled" in line for line in output.splitlines()), output
            outcome = "listed the local config entry"

    revoke(web)
    assert run(helper, "doctor", "--pairing", binding, cwd=cwd, env=env, check=False).returncode != 0
    if profile == "pi":
        assert list(json.loads(path.read_text())["mcpServers"]) == ["other"]
    else:
        path.unlink()
    return {"version": version, "setup": outcome, "revocation": "passed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop", type=Path)
    parser.add_argument("helper", type=Path)
    parser.add_argument("profiles", nargs="+", choices=("opencode", "pi", "antigravity"))
    args = parser.parse_args()
    for profile in args.profiles:
        if not shutil.which("agy" if profile == "antigravity" else profile):
            parser.error(f"Install {profile} before running this check.")

    helper = args.helper.resolve(strict=True)
    with isolated_library() as root:
        pi_profile = root / "pi"
        pi_profile.mkdir()
        (pi_profile / "mcp.json").write_text(json.dumps({
            "mcpServers": {"other": {"enabled": False, "command": "/usr/bin/false"}}
        }))
        home = root / "home"
        home.mkdir()
        os.environ["PI_CODING_AGENT_DIR"] = str(pi_profile)
        env = dict(os.environ, HOME=str(home), XDG_STATE_HOME=str(root / "state"),
                   OPENCODE_DISABLE_AUTOUPDATE="1", NO_COLOR="1")
        with webdriver() as (launch, _), launch(args.desktop, ("--fixture=empty",)) as web:
            wait_until(lambda: web.evaluate('return document.querySelector(".lean-editor")?.dataset.editorReady;'),
                       "persisted editor")
            button(web, "Agents")
            report = {
                profile: check_profile(web, helper, profile, root / "worktree", env)
                for profile in args.profiles
            }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
