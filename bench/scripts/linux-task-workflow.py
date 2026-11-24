#!/usr/bin/env python3
"""Exercise issue import, brief, verification, and template reuse in one native app session."""

import argparse
import os
from pathlib import Path
import runpy
import sqlite3
from unittest.mock import patch

from webkit_driver import close_board, isolated_library, open_disclosure, wait_until, webdriver


SCRIPTS = Path(__file__).resolve().parent
issue = runpy.run_path(str(SCRIPTS / "linux-github-issue.py"))
verification = runpy.run_path(str(SCRIPTS / "linux-card-verification.py"))
templates = runpy.run_path(str(SCRIPTS / "linux-board-templates.py"))
fixture = runpy.run_path(str(SCRIPTS / "linux-fixture-proof.py"))
shown = issue["shown"]
set_text = issue["set_text"]
button = fixture["button"]
pointer = fixture["pointer"]
move = fixture["move"]

EDITOR = ".lean-editor[data-editor-ready]"
BRIEF = ".agent-brief-dialog[open]"
VERIFY = ".verification-dialog[open]"
TEMPLATE = ".template-dialog[open]"


def choose_card(web, title):
    x, y = web.evaluate("""
        const item = [...document.querySelectorAll('.lean-card')].find(card => card.textContent === arguments[0]);
        const rect = item.getBoundingClientRect();
        return [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
    """, title)
    pointer(web, move(x, y), {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0})
    wait_until(lambda: web.evaluate("""
        return document.querySelector('.lean-card[data-selected=true]')?.textContent === arguments[0];
    """, title), f"selected {title}")


def run(binary):
    with isolated_library() as root:
        issue["fake_cli"](root)
        database = root / "data/dev.local.raqsh/library/boards.sqlite3"
        with patch.dict(os.environ, {"PATH": f"{root}{os.pathsep}{os.environ['PATH']}"}):
            with webdriver() as (launch, _), launch(binary, ["--fixture=empty"]) as web:
                wait_until(lambda: shown(web, EDITOR), "initial board")
                close_board(web)
                issue["open_task_dialog"](web)
                issue["load"](web, issue["ISSUE"])
                wait_until(lambda: shown(web, issue["USE"]), "loaded issue")
                web.click(issue["USE"])
                web.click(".task-board-dialog input[value=checklist]")
                web.click(issue["CREATE"])
                wait_until(lambda: shown(web, EDITOR), "created issue board")
                choose_card(web, "Confirm manual entry")
                verification["button"](web, ".lean-selection", "Verification…")
                wait_until(lambda: shown(web, f"{VERIFY} form"), "verification form")
                verification["field"](web, "title", "Imported issue opens")
                web.evaluate("""
                    const result = document.querySelector('.verification-dialog select');
                    result.value = 'passed';
                    result.dispatchEvent(new Event('change', {bubbles: true}));
                """)
                verification["field"](web, "revision", "abc123")
                verification["field"](web, "reference", "https://github.com/example/project/pull/12")
                verification["button"](web, VERIFY, "Record check")
                wait_until(lambda: shown(web, f"{VERIFY} .verification-list li"), "recorded evidence")
                verification["button"](web, VERIFY, "Close")

                open_disclosure(web, ".board-header")
                verification["button"](web, ".board-header", "Review summary…")
                wait_until(lambda: shown(web, f"{VERIFY} textarea"), "summary")
                summary = web.evaluate("return document.querySelector('.verification-dialog textarea').value;")
                assert "Confirm manual entry" in summary and "**Passed**" in summary and "abc123" in summary
                verification["button"](web, VERIFY, "Close")

                choose_card(web, "Confirm manual entry")
                open_disclosure(web, ".board-header")
                button(web, "Copy agent brief")
                wait_until(lambda: shown(web, BRIEF), "agent brief")
                web.click(f"{BRIEF} input[type=checkbox]")
                brief = web.evaluate("return document.querySelector('.agent-brief-preview textarea').value;")
                assert issue["ISSUE"] in brief and "### Confirm manual entry" in brief and "Status: Done" in brief
                verification["button"](web, BRIEF, "Close")

                open_disclosure(web, ".board-header")
                button(web, "Save as template…")
                wait_until(lambda: shown(web, f"{TEMPLATE} input[name=templateName]:not([readonly])"), "template preview")
                set_text(web, f"{TEMPLATE} input[name=templateName]", "Issue checklist template")
                button(web, "Save template")
                wait_until(lambda: not shown(web, TEMPLATE), "saved template")
                close_board(web)
                templates["open_library"](web)
                wait_until(lambda: shown(web, f"{TEMPLATE} .template-list button:not(:disabled)"), "saved template listed")
                web.click(f"{TEMPLATE} .template-list button")
                target = f"{TEMPLATE} input[name=boardTitle]:not(:disabled)"
                wait_until(lambda: shown(web, target), "template apply form")
                set_text(web, target, "Repeat issue checklist")
                web.click(f"{TEMPLATE} .template-creation button[type=submit]")
                wait_until(lambda: shown(web, EDITOR), "board created from template")

                with sqlite3.connect(database) as db:
                    board, source = issue["stored_cards"](root, "Issue 9")
                    reused, cards = issue["stored_cards"](root, "Repeat issue checklist")
                    assert board != reused
                    assert cards.keys() == source.keys()
                    assert all(card["status"] == "todo" for card in cards.values())
                    assert {card["id"] for card in cards.values()}.isdisjoint(card["id"] for card in source.values())
                    assert db.execute("SELECT board_id FROM card_verifications").fetchall() == [(board,)]
                    assert db.execute("SELECT count(*) FROM edges WHERE board_id=?", (reused,)).fetchone() == (0,)

                web.call("POST", "/window/rect", {"width": 480, "height": 360})
                wait_until(lambda: web.evaluate("return innerWidth === 480 && innerHeight === 360;"), "compact board")
                open_disclosure(web, ".board-header")
                assert web.evaluate("""
                    const menu = document.querySelector('.board-header > .board-menu');
                    return menu.getBoundingClientRect().bottom <= innerHeight;
                """)
                close_board(web)
                wait_until(lambda: shown(web, ".task-board-action:not(:disabled)"), "close board at minimum size")
    print("PASS issue → checklist board → verification and copy → reusable starter board.")


def stress(binary):
    with isolated_library() as root, webdriver() as (launch, _), launch(binary, ["--fixture=stress"]) as web:
        database = root / "data/dev.local.raqsh/library/boards.sqlite3"
        wait_until(lambda: shown(web, EDITOR), "500-card fixture")
        assert web.evaluate("""
            return document.querySelectorAll('.lean-card').length === 500
                && Number(document.querySelector('.lean-editor').dataset.initialElements) === 3500;
        """)
        web.evaluate("document.querySelector('.excalidraw').focus({preventScroll:true});")
        web.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": [
            {"type": "keyDown", "value": "\ue009"}, {"type": "keyDown", "value": "a"},
            {"type": "keyUp", "value": "a"}, {"type": "keyUp", "value": "\ue009"},
        ]}]})
        wait_until(lambda: web.evaluate("return document.querySelectorAll('.lean-card[data-selected=true]').length === 500;"),
                   "all 500 cards selected")
        open_disclosure(web, ".board-header")
        button(web, "Copy agent brief")
        wait_until(lambda: shown(web, BRIEF), "large brief preview")
        text = web.evaluate("return document.querySelector('.agent-brief-preview textarea').value;")
        assert sum(line.startswith("### ") for line in text.splitlines()) == 500
        verification["button"](web, BRIEF, "Close")
        open_disclosure(web, ".board-header")
        button(web, "Save as template…")
        wait_until(lambda: shown(web, f"{TEMPLATE} input[name=templateName]:not([readonly])"), "large template preview")
        set_text(web, f"{TEMPLATE} input[name=templateName]", "Stress board template")
        button(web, "Save template")
        wait_until(lambda: not shown(web, TEMPLATE), "large template saved")
        close_board(web)
        templates["open_library"](web)
        wait_until(lambda: shown(web, f"{TEMPLATE} .template-list button:not(:disabled)"), "stress template listed")
        web.click(f"{TEMPLATE} .template-list button")
        target = f"{TEMPLATE} input[name=boardTitle]:not(:disabled)"
        wait_until(lambda: shown(web, target), "large template ready")
        set_text(web, target, "Stress reuse")
        web.click(f"{TEMPLATE} .template-creation button[type=submit]")
        wait_until(lambda: shown(web, EDITOR), "large template applied")
        assert web.evaluate("return document.querySelectorAll('.lean-card').length;") == 500
        with sqlite3.connect(database) as db:
            board, _ = issue["stored_cards"](root, "Stress reuse")
            assert db.execute("SELECT count(*) FROM edges WHERE board_id=?", (board,)).fetchone() == (500,)
    print("PASS 500-card native brief and template reuse on a 3,500-element source board.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--stress", action="store_true")
    args = parser.parse_args()
    (stress if args.stress else run)(args.binary)
