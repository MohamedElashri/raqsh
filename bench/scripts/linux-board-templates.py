#!/usr/bin/env python3
"""Verify saving, exporting, importing and applying templates in native Raqsh."""

import argparse
import json
from pathlib import Path
from runpy import run_path
import sqlite3

from webkit_driver import close_board, isolated_library, open_disclosure, process_birth, wait_until, webdriver


helpers = run_path(str(Path(__file__).with_name("linux-task-board.py")))
native_helpers = run_path(str(Path(__file__).with_name("linux-p1-proof.py")))
shown, text, board_records = (helpers[k] for k in ("shown", "text", "board_records"))
native_path, button, ready, request_window_close = (
    native_helpers[k] for k in ("native_path", "button", "ready", "request_window_close")
)
DIALOG = ".template-dialog[open]"
SOURCE = "Prepare release packages"
TEMPLATE = "Portable release checks"
NEW_BOARD = "Run the next release"
IMPORTED_TEMPLATE = "Imported release checks"


def open_library(web):
    wait_until(lambda: shown(web, ".task-board-action:not(:disabled)"), "project library")
    button(web, "Templates…")
    wait_until(lambda: shown(web, DIALOG), "template library")


def upload(web, name, payload):
    web.evaluate("""
        const file = new File([arguments[1]], arguments[0], { type: "application/json" });
        const files = new DataTransfer();
        files.items.add(file);
        const input = document.querySelector('.template-dialog input[type="file"]');
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    """, name, payload)


def run(binary):
    with isolated_library() as root, webdriver() as (session, driver):
        database = root / "data/dev.local.raqsh/library/boards.sqlite3"
        with session(binary, ["--fixture=empty"]) as web:
            ready(web)
            close_board(web)
            wait_until(lambda: shown(web, ".task-board-action:not(:disabled)"), "project library")
            web.click(".task-board-action")
            text(web, ".task-board-dialog textarea[name=brief]", "# " + SOURCE + "\n\nDescribe how to verify packages.")
            web.click(".task-board-dialog button[type=submit]")
            ready(web)

            open_disclosure(web, ".board-header")
            button(web, "Save as template…")
            wait_until(lambda: shown(web, f"{DIALOG} input[name=templateName]:not([readonly])"), "capture preview")
            open_disclosure(web, f"{DIALOG} .template-contents details")
            assert "Define the outcome" in web.evaluate("return document.querySelector('.template-contents').textContent;")
            assert "Describe how to verify packages." in web.evaluate("return document.querySelector('.template-contents').textContent;")
            text(web, f"{DIALOG} input[name=templateName]", TEMPLATE)
            button(web, "Save template")
            wait_until(lambda: not shown(web, DIALOG), "saved template")
            with sqlite3.connect(database) as db:
                source_nodes, source_links, _, _ = board_records(db, SOURCE)
            request_window_close(web)
            wait_until(lambda: process_birth(driver, binary) is None, "source desktop closed")
            web.terminated = True

        with session(binary, ["--fixture=empty"]) as web:
            ready(web)
            close_board(web)
            open_library(web)
            wait_until(lambda: shown(web, f"{DIALOG} .template-list button:not(:disabled)"), "persisted template")
            web.click(f"{DIALOG} .template-list button")
            wait_until(lambda: shown(web, f"{DIALOG} input[name=boardTitle]:not(:disabled)"), "saved preview")
            assert web.evaluate("return document.querySelector('.template-creation input').value;") == TEMPLATE

            button(web, "Export template…")
            path = root / "release.raqsh-template"
            native_path("Export template", path)
            payload = wait_until(lambda: path.read_text() if path.exists() and path.stat().st_size else "", "exported template file")
            document = json.loads(payload)
            assert document["format"] == "dev.local.raqsh.template"
            assert document["title"] == TEMPLATE
            assert len(document["cards"]) == 4 and len(document["dependencies"]) == 2
            assert all("status" not in card and "statusSource" not in card for card in document["cards"])

            wait_until(lambda: shown(web, f"{DIALOG} input[name=boardTitle]:not(:disabled)"), "finished export")
            upload(web, path.name, '{"format":"invalid"}')
            wait_until(lambda: shown(web, f"{DIALOG} [role=alert]"), "invalid template message")
            assert web.evaluate("return document.querySelector('.template-creation input').value;") == TEMPLATE
            upload(web, path.name, payload)
            wait_until(lambda: shown(web, f"{DIALOG} input[name=templateName]:not(:disabled)"), "imported preview")
            text(web, f"{DIALOG} input[name=templateName]", IMPORTED_TEMPLATE)
            button(web, "Save template")
            wait_until(lambda: shown(web, f"{DIALOG} input[name=boardTitle]:not(:disabled)"), "imported template saved")
            text(web, f"{DIALOG} input[name=boardTitle]", NEW_BOARD)
            web.click(f"{DIALOG} .template-creation button[type=submit]")
            ready(web)

            with sqlite3.connect(database) as db:
                new_nodes, new_links, semantic, drawing = board_records(db, NEW_BOARD)
                assert db.execute("SELECT count(*) FROM board_templates").fetchone()[0] == 2
            assert (semantic, drawing) == (0, 0)
            assert [card["title"] for card in new_nodes] == [card["title"] for card in source_nodes]
            assert all(card["status"] == "todo" and not card["dropped"] for card in new_nodes)
            assert {card["id"] for card in new_nodes}.isdisjoint(card["id"] for card in source_nodes)
            assert {edge["id"] for edge in new_links}.isdisjoint(edge["id"] for edge in source_links)
            assert len(new_links) == len(source_links) == 2
            request_window_close(web)
            wait_until(lambda: process_birth(driver, binary) is None, "destination desktop closed")
            web.terminated = True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary")
    run(parser.parse_args().binary)
    print("Native template capture, persistence, file round-trip, and reuse passed.")
