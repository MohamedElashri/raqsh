#!/usr/bin/env python3
"""Seed and verify an installed board across package-manager changes."""

import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess

from webkit_driver import process_birth, wait_until, webdriver

p1 = runpy.run_path(str(Path(__file__).with_name("linux-p1-proof.py")))
add, annotation, button, close_editor, read_export, ready, revision, text = (
    p1[name] for name in ("add", "annotation", "button", "close_editor", "read_export", "ready", "revision", "text")
)
DESKTOP = Path("/usr/bin/raqsh")
HELPER = Path("/usr/bin/raqsh-mcp")
TITLE = "Package lifecycle task"
NOTE = "Package lifecycle drawing"


def command(args, *, success=True):
    reply = subprocess.run(args, text=True, capture_output=True, check=success, timeout=15)
    return reply.stdout if success else reply


def seed(web, root):
    ready(web)
    add(web, TITLE)
    revision(web, 1)
    annotation(web, NOTE)
    button(web, "Agents")
    web.evaluate('''
        const provider = document.querySelector('.agent-panel select[name="provider"]');
        provider.value = 'generic';
        provider.dispatchEvent(new Event('change', {bubbles: true}));
    ''')
    text(web, '.agent-panel input[name="label"]', "Lifecycle fixture")
    button(web, "Approve pairing")
    binding = wait_until(lambda: web.evaluate("""
        return document.querySelector('.agent-panel select[name="binding"]')?.value;
    """), "paired fixture")
    setup = command([HELPER, "setup", "--pairing", binding])
    registration = json.loads(setup)["mcpServers"]["raqsh"]
    assert registration["command"] == str(HELPER)
    session = json.loads(command([HELPER, "doctor", "--pairing", binding]))
    board = session["binding"]["boardId"]
    assert board
    button(web, "Close")
    exported = json.loads(read_export(web, "Board file…", root / "original.raqsh"))
    assert any(node["title"] == TITLE for node in exported["nodes"])
    assert any(label["text"] == NOTE for label in exported["drawing"]["labels"])
    (root / "agent.json").write_text(setup)
    (root / "fixture.json").write_text(json.dumps({"binding": binding, "board": board}))
    close_editor(web)


def verify(web, root, *, reimport):
    fixture = json.loads((root / "fixture.json").read_text())
    registration = json.loads((root / "agent.json").read_text())["mcpServers"]["raqsh"]
    helper, binding = registration["command"], registration["args"][-1]
    assert helper == str(HELPER) and binding == fixture["binding"]
    wait_until(lambda: web.evaluate('return !!document.querySelector(".project-link:not(:disabled)");'),
               "project survived package change")
    web.click(".project-link")
    row = f'[data-board-id="{fixture["board"]}"]'
    wait_until(lambda: web.evaluate("return !!document.querySelector(arguments[0]);", row), "existing board")
    web.click(row)
    ready(web)
    assert web.evaluate("""
        return [...document.querySelectorAll(".lean-card")].some(card => card.textContent === arguments[0])
            && [...document.querySelectorAll(".lean-label")].some(note => note.textContent === arguments[1]);
    """, TITLE, NOTE)
    session = json.loads(command([helper, "doctor", "--pairing", binding]))
    assert session["binding"]["boardId"] == fixture["board"]
    close_editor(web)
    if reimport:
        upload = web.element('input[type="file"]')
        original = str(root / "original.raqsh")
        web.call("POST", f"/element/{upload}/value", {"text": original, "value": list(original)})
        ready(web)
        assert web.evaluate("""
            return [...document.querySelectorAll(".lean-card")].some(card => card.textContent === arguments[0])
                && [...document.querySelectorAll(".lean-label")].some(note => note.textContent === arguments[1]);
        """, TITLE, NOTE)
        close_editor(web)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "verify", "import"))
    parser.add_argument("profile", type=Path)
    parser.add_argument("--display-name", default="")
    args = parser.parse_args()
    root = args.profile.resolve()
    root.mkdir(mode=0o700, exist_ok=True)
    for key, name in {
        "XDG_DATA_HOME": "data", "XDG_CONFIG_HOME": "config", "XDG_CACHE_HOME": "cache",
        "RAQSH_BENCH_PROJECT": "worktree", "RAQSH_RUNTIME_DIR": "runtime",
    }.items():
        folder = root / name
        folder.mkdir(mode=0o700, exist_ok=True)
        os.environ[key] = str(folder)
    with webdriver() as (launch, parent):
        fixture_args = ("--fixture=empty",) if args.action == "seed" else ()
        with launch(DESKTOP, fixture_args) as web:
            pid, _ = wait_until(lambda: process_birth(parent, DESKTOP), "owned installed desktop")
            if args.action == "seed":
                seed(web, root)
            else:
                if args.display_name:
                    title = wait_until(lambda: web.evaluate("""
                        return document.querySelector(".app-mark h1")?.textContent;
                    """), "installed display name")
                    assert title == args.display_name
                    assert web.evaluate("return document.title;") == args.display_name
                    assert args.display_name in command(["xwininfo", "-root", "-tree"])
                verify(web, root, reimport=args.action == "import")
        wait_until(lambda: not Path(f"/proc/{pid}").exists(), "installed desktop exited")
    binding = json.loads((root / "fixture.json").read_text())["binding"]
    offline = command([HELPER, "doctor", "--pairing", binding], success=False)
    assert offline.returncode != 0 and "desktop_offline" in offline.stderr
    print(json.dumps({"phase": args.action, "board_and_pairing": True,
                      "old_export_import": args.action == "import", "desktop_offline_after_exit": True}))


if __name__ == "__main__":
    main()
