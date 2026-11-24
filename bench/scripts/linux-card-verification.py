#!/usr/bin/env python3
"""Exercise manual card verification and the review summary in the Linux app."""

import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

from webkit_driver import close_board, isolated_library, wait_until, webdriver


DIALOG = ".verification-dialog[open]"
EDITOR = ".lean-editor[data-editor-ready]"


def shown(web, selector):
    return web.evaluate("return !!document.querySelector(arguments[0]);", selector)


def button(web, scope, name):
    web.evaluate("""
        const container = document.querySelector(arguments[0]);
        const button = Array.from(container.querySelectorAll('button'))
            .find((item) => item.textContent.trim() === arguments[1]);
        if (!button || button.disabled) throw Error('Button unavailable: ' + arguments[1]);
        button.click();
    """, scope, name)


def field(web, name, value):
    web.evaluate("""
        const input = document.querySelector('.verification-dialog [name="' + arguments[0] + '"]');
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, arguments[1]);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    """, name, value)


def open_card_verification(web):
    if not shown(web, ".lean-inspector"):
        web.click(".lean-board-actions button:first-of-type")
    wait_until(lambda: shown(web, ".lean-inspector li:first-child button"), "card list")
    web.click(".lean-inspector li:first-child button")
    button(web, ".lean-selection", "Verification…")
    wait_until(lambda: shown(web, f"{DIALOG} form"), "verification form")


def run(binary):
    with isolated_library() as root, webdriver() as (session, _), session(binary, ["--fixture=tiny"]) as web:
        database = root / "data/dev.local.raqsh/library/boards.sqlite3"
        wait_until(lambda: shown(web, EDITOR), "initial board")
        open_card_verification(web)
        field(web, "title", "Fresh Linux install")
        web.evaluate("""
            const select = document.querySelector('.verification-dialog select');
            select.value = 'passed';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        """)
        field(web, "revision", "5e6f789")
        field(web, "reference", "ftp://example.test/build")
        button(web, DIALOG, "Record check")
        wait_until(lambda: shown(web, f"{DIALOG} [role=alert]"), "unsupported URL error")
        assert web.evaluate("return document.querySelector('.verification-dialog [name=title]').value;") == "Fresh Linux install"
        field(web, "reference", "https://example.test/ci/47")
        with sqlite3.connect(database) as pause:
            pause.execute("BEGIN IMMEDIATE")
            button(web, DIALOG, "Record check")
            wait_until(lambda: shown(web, f'{DIALOG} input[name="title"][readonly]'), "draft protected during save", timeout=1)
            assert shown(web, f"{DIALOG} select:disabled")
            pause.rollback()
        wait_until(lambda: shown(web, f"{DIALOG} .verification-list li"), "persisted check")
        assert "Passed · Manual" in web.evaluate("return document.querySelector('.verification-list').textContent;")
        with sqlite3.connect(database) as db:
            board_id, body = db.execute("SELECT board_id, body FROM card_verifications").fetchone()
            record = json.loads(body)
            assert record["check"]["revision"] == "5e6f789"
            assert record["check"]["reference"] == "https://example.test/ci/47"
            assert record["recordedAt"] > 0
            assert db.execute("SELECT semantic_revision FROM boards WHERE id=?", (board_id,)).fetchone() == (0,)
        button(web, DIALOG, "Close")
        web.click(".board-header summary")
        button(web, ".board-header", "Review summary…")
        wait_until(lambda: shown(web, f"{DIALOG} textarea"), "Markdown preview")
        summary = web.evaluate("return document.querySelector('.verification-dialog textarea').value;")
        assert "## Completed tasks" in summary and "## Pending review" in summary
        assert "**Passed**" in summary and "Fresh Linux install" in summary and "5e6f789" in summary
        web.click(f"{DIALOG} .dialog-actions:last-child button:last-child")
        wait_until(lambda: shown(web, f"{DIALOG} [role=status]"), "copy feedback")
        feedback = web.evaluate("return document.querySelector('.verification-dialog [role=status]').textContent;")
        assert "copied" in feedback or "Summary selected" in feedback
        if os.environ.get("GDK_BACKEND") == "x11" and shutil.which("xclip"):
            if "Summary selected" in feedback:
                web.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": [
                    {"type": "keyDown", "value": "\ue009"}, {"type": "keyDown", "value": "c"},
                    {"type": "keyUp", "value": "c"}, {"type": "keyUp", "value": "\ue009"},
                ]}]})
            clipboard = subprocess.check_output(["xclip", "-selection", "clipboard", "-o"],
                                                text=True, timeout=5)
            assert clipboard == summary
        button(web, DIALOG, "Close")
        close_board(web)
        wait_until(lambda: shown(web, f'.board-link[data-board-id="{board_id}"]'), "board library")
        web.click(f'.board-link[data-board-id="{board_id}"]')
        wait_until(lambda: shown(web, EDITOR), "reopened board")
        open_card_verification(web)
        wait_until(lambda: shown(web, f"{DIALOG} .verification-list li"), "reopened check")
        button(web, DIALOG, "Remove check")
        wait_until(lambda: not shown(web, f"{DIALOG} .verification-list li"), "removed check")
        with sqlite3.connect(database) as db:
            assert db.execute("SELECT COUNT(*) FROM card_verifications").fetchone() == (0,)
    print("Verification passed: validation, scoped save, Markdown copy feedback, reopen, and removal.")


if __name__ == "__main__":
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("binary", type=Path)
    run(arguments.parse_args().binary)
