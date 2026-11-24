#!/usr/bin/env python3
"""Exercise GitHub issue import in the native Linux application."""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from unittest.mock import patch

from webkit_driver import close_board, isolated_library, open_disclosure, wait_until, webdriver


DIALOG = ".task-board-dialog[open]"
IMPORT = f"{DIALOG} [data-github-issue-import]"
URL = f"{IMPORT} input[name=github-issue-url]"
TITLE = f"{DIALOG} input[name=title]"
BRIEF = f"{DIALOG} textarea[name=brief]"
CREATE = f"{DIALOG} button[type=submit]"
USE = f"{IMPORT} .github-issue-result button"
ACTION = ".task-board-action"
EDITOR = ".lean-editor[data-editor-ready]"
ISSUE = "https://github.com/example/project/issues/9"
BODY = "Requested work\n- [ ] Add the issue chooser\n- [x] Confirm manual entry"


def shown(web, selector):
    return web.evaluate("return !!document.querySelector(arguments[0]);", selector)


def set_text(web, selector, value):
    web.evaluate("""
        const el = document.querySelector(arguments[0]);
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, arguments[1]);
        el.dispatchEvent(new Event('input', {bubbles: true}));
    """, selector, value)


def text_value(web, selector):
    return web.evaluate("return document.querySelector(arguments[0]).value;", selector)


def fake_cli(root):
    executable = root / "gh"
    executable.write_text(f"""#!{sys.executable}
import json
import os
import sys

number = sys.argv[3].rsplit("/", 1)[-1]
url = "https://github.com/example/project/issues/" + number
if sys.argv[1:] != ["issue", "view", url, "--json", "title,body,url"]:
    raise SystemExit("Unexpected CLI arguments")
if os.environ.get("GH_PROMPT_DISABLED") != "1":
    raise SystemExit("CLI prompt was not disabled")
if number == "1":
    raise SystemExit("simulated access failure")
body = {BODY!r} if number == "9" else "z" * 4200
print(json.dumps({{"title": "Issue " + number, "body": body, "url": url}}))
""", encoding="utf-8")
    executable.chmod(0o700)


def load(web, url):
    set_text(web, URL, url)
    web.click(f"{IMPORT} .github-issue-input button")


def alert(web):
    return web.evaluate("return document.querySelector(arguments[0])?.textContent;", f"{IMPORT} [role=alert]")


def open_task_dialog(web):
    wait_until(lambda: shown(web, f"{ACTION}:not(:disabled)"), "project library")
    web.click(ACTION)
    open_disclosure(web, IMPORT)


def stored_cards(root, title):
    with sqlite3.connect(root / "data/dev.local.raqsh/library/boards.sqlite3") as db:
        board = db.execute("SELECT id FROM boards WHERE title = ?", (title,)).fetchone()[0]
        cards = [json.loads(body) for (body,) in db.execute("SELECT body FROM nodes WHERE board_id = ?", (board,))]
    return board, {card["title"]: card for card in cards}


def run(binary):
    with isolated_library() as root:
        fake_cli(root)
        with patch.dict(os.environ, {"PATH": f"{root}{os.pathsep}{os.environ['PATH']}"}):
            with webdriver() as (session, _), session(binary, ["--fixture=empty"]) as web:
                wait_until(lambda: shown(web, EDITOR), "fixture board")
                close_board(web)
                open_task_dialog(web)
                set_text(web, TITLE, "Manual board")
                set_text(web, BRIEF, "Manual brief")

                set_text(web, URL, "https://example.com/project/issues/9")
                web.evaluate("document.querySelector(arguments[0]).focus();", URL)
                web.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": [
                    {"type": "keyDown", "value": "\ue007"}, {"type": "keyUp", "value": "\ue007"},
                ]}]})
                wait_until(lambda: alert(web), "invalid URL message")
                assert "Enter a GitHub issue URL" in alert(web), alert(web)
                load(web, "https://github.com/example/project/issues/1")
                wait_until(lambda: alert(web), "GitHub failure message")
                assert "Could not load the issue" in alert(web), alert(web)
                assert text_value(web, TITLE) == "Manual board"
                assert text_value(web, BRIEF) == "Manual brief"
                assert text_value(web, URL).endswith("/issues/1")

                load(web, f"{ISSUE}?ref=copy#issuecomment-21")
                wait_until(lambda: shown(web, USE), "loaded issue confirmation")
                assert text_value(web, BRIEF) == "Manual brief"
                web.click(USE)
                assert text_value(web, TITLE) == "Issue 9"
                assert text_value(web, BRIEF) == BODY
                web.click(f"{DIALOG} input[value=checklist]")
                assert web.evaluate(f"return document.querySelectorAll('{DIALOG} .task-board-preview summary').length;") == 2
                web.click(CREATE)
                wait_until(lambda: shown(web, EDITOR), "imported issue board")
                close_board(web)
                open_task_dialog(web)
                board, cards = stored_cards(root, "Issue 9")
                assert cards["Task brief"]["description"] == f"Source: <{ISSUE}>\n\n{BODY}"
                assert cards["Add the issue chooser"]["status"] == "todo"
                assert cards["Confirm manual entry"]["status"] == "done"

                load(web, "https://github.com/example/project/issues/10")
                wait_until(lambda: shown(web, USE), "loaded long issue")
                web.click(USE)
                assert len(text_value(web, BRIEF)) == 4200
                assert shown(web, f"{CREATE}:disabled")
                set_text(web, BRIEF, "Chosen excerpt")
                web.click(CREATE)
                wait_until(lambda: shown(web, EDITOR), "board created from the selected excerpt")
                close_board(web)
                wait_until(lambda: shown(web, f"{ACTION}:not(:disabled)"), "project library")
                _, cards = stored_cards(root, "Issue 10")
                assert cards["Task brief"]["description"] == (
                    "Source: <https://github.com/example/project/issues/10>\n\nChosen excerpt"
                )

                web.click(f'.board-link[data-board-id="{board}"]')
                wait_until(lambda: shown(web, EDITOR), "reopened issue board")
                assert web.evaluate("return document.querySelectorAll('.lean-card[data-status=done]').length;") == 1
    print("GitHub issue import passed URL validation, recovery, checklist creation, excerpt and reopen.")


def run_live(binary, url):
    result = subprocess.run(
        ["gh", "issue", "view", url, "--json", "title,body,url"],
        text=True,
        capture_output=True,
        timeout=15,
        check=True,
    )
    expected = json.loads(result.stdout)
    config = os.environ.get("GH_CONFIG_DIR") or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "gh"
    with isolated_library() as root, patch.dict(os.environ, {"GH_CONFIG_DIR": str(config)}):
        with webdriver() as (session, _), session(binary, ["--fixture=empty"]) as web:
            wait_until(lambda: shown(web, EDITOR), "fixture board")
            close_board(web)
            open_task_dialog(web)
            load(web, url)
            wait_until(lambda: shown(web, USE) or alert(web), "GitHub CLI result", timeout=20)
            assert shown(web, USE), alert(web)
            web.click(USE)
            title = text_value(web, TITLE)
            assert title == expected["title"]
            body = text_value(web, BRIEF)
            assert body == (expected["body"] or "").replace("\r\n", "\n").replace("\r", "\n")
            if shown(web, f"{CREATE}:disabled"):
                body = body[:3000]
                set_text(web, BRIEF, body)
            web.click(CREATE)
            wait_until(lambda: shown(web, EDITOR), "board imported from GitHub")
            close_board(web)
            wait_until(lambda: shown(web, f"{ACTION}:not(:disabled)"), "project library")
            _, cards = stored_cards(root, title)
            source = f"Source: <{expected['url']}>"
            assert cards["Task brief"]["description"] == (f"{source}\n\n{body}" if body else source)
    print("GitHub issue import passed against the installed gh CLI and a live issue.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--live-url", help="Exercise a public issue through the installed GitHub CLI")
    args = parser.parse_args()
    if args.live_url:
        run_live(args.binary, args.live_url)
    else:
        run(args.binary)
