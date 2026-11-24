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
add = native_helpers["add"]
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


def select_named(web, selector, label):
    web.evaluate("""
        const select = document.querySelector(arguments[0]);
        const option = [...select.options].find(item => item.textContent === arguments[1]);
        if (!option) throw Error('Missing option: ' + arguments[1]);
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    """, selector, label)


def select_template(web, name):
    web.evaluate("""
        const button = [...document.querySelectorAll('.template-list button')]
            .find(item => item.querySelector('strong')?.textContent === arguments[0]);
        if (!button || button.disabled) throw Error('Template unavailable: ' + arguments[0]);
        button.click();
    """, name)
    wait_until(lambda: shown(web, f"{DIALOG} input[name=boardTitle]:not(:disabled)"), "saved template selection")


def create_from_selection(web, title):
    text(web, f"{DIALOG} input[name=boardTitle]", title)
    web.click(f"{DIALOG} .template-creation button[type=submit]")
    ready(web)


def edit_example(web, database):
    close_board(web)
    open_library(web)
    open_disclosure(web, f"{DIALOG} .template-examples")
    assert web.evaluate("return [...document.querySelectorAll('.template-examples button')].map(button => button.textContent);") == [
        "Bug triage", "Feature delivery", "Release verification",
    ]
    button(web, "Release verification")
    wait_until(lambda: shown(web, f"{DIALOG} input[name=templateName]:not(:disabled)"), "example preview")
    text(web, f"{DIALOG} input[name=templateName]", "Release starter")
    button(web, "Save template")
    wait_until(lambda: shown(web, f"{DIALOG} input[name=boardTitle]:not(:disabled)"), "example saved")
    create_from_selection(web, "Original example board")
    close_board(web)
    open_library(web)
    wait_until(lambda: shown(web, f"{DIALOG} .template-list button:not(:disabled)"), "template list ready")
    select_template(web, "Release starter")
    button(web, "Edit template…")
    wait_until(lambda: shown(web, f"{DIALOG} input[name=cardTitle]"), "quick edit")
    text(web, f"{DIALOG} input[name=templateName]", "Discard this draft")
    text(web, f"{DIALOG} input[name=cardTitle]", " ")
    assert shown(web, f"{DIALOG} button[type=submit]:disabled")
    button(web, "Cancel")
    wait_until(lambda: shown(web, f"{DIALOG} input[name=boardTitle]"), "returned to saved template")
    assert web.evaluate("return document.querySelector('.template-creation input').value;") == "Release starter"

    button(web, "Edit template…")
    wait_until(lambda: shown(web, f"{DIALOG} select[name=card]"), "edit again")
    web.call("POST", "/window/rect", {"width": 480, "height": 360})
    wait_until(lambda: web.evaluate("return innerWidth === 480 && innerHeight === 360;"), "compact window")
    assert web.evaluate("""
        const dialog = document.querySelector('.template-dialog');
        return dialog.scrollWidth === dialog.clientWidth && dialog.getBoundingClientRect().right <= innerWidth;
    """)
    text(web, f"{DIALOG} input[name=templateName]", "Release starter edited")
    select_named(web, f"{DIALOG} select[name=card]", "Verify package checksums")
    text(web, f"{DIALOG} input[name=cardTitle]", "Check published checksums")
    text(web, f"{DIALOG} textarea[name=cardDetails]", "Review the candidate manifest.")
    select_named(web, f"{DIALOG} select[name=priority]", "Low")
    button(web, "Save changes")
    wait_until(lambda: shown(web, f"{DIALOG} input[name=boardTitle]:not(:disabled)"), "saved edits")
    assert web.evaluate("return document.querySelector('.template-creation input').value;") == "Release starter edited"

    web.call("POST", "/window/rect", {"width": 1024, "height": 720})
    wait_until(lambda: web.evaluate("return innerWidth === 1024 && innerHeight === 720;"), "full window")
    create_from_selection(web, "Edited example board")
    with sqlite3.connect(database) as db:
        original, _, _, _ = board_records(db, "Original example board")
        edited, links, _, _ = board_records(db, "Edited example board")
        assert "Verify package checksums" in {card["title"] for card in original}
        changed = next(card for card in edited if card["title"] == "Check published checksums")
        assert changed["description"] == "Review the candidate manifest." and changed["priority"] == "low"
        assert len(links) == 4

    add(web, "Check release notes")
    wait_until(lambda: web.evaluate("return document.querySelectorAll('.lean-card').length;") == 6, "added card")
    open_disclosure(web, ".board-header")
    button(web, "Save as template…")
    wait_until(lambda: shown(web, f"{DIALOG} input[name=templateName]:not([readonly])"), "updated board preview")
    button(web, "Update a saved template…")
    wait_until(lambda: shown(web, f"{DIALOG} select[name=replacementTemplate]:not(:disabled)"), "replacement choices")
    select_named(web, f"{DIALOG} select[name=replacementTemplate]", "Release starter edited")
    wait_until(lambda: shown(web, f"{DIALOG} button[type=submit]:not(:disabled)"), "replacement selected")
    button(web, "Update template")
    wait_until(lambda: not shown(web, DIALOG), "update from board saved")

    close_board(web)
    open_library(web)
    wait_until(lambda: shown(web, f"{DIALOG} .template-list button:not(:disabled)"), "updated template listed")
    select_template(web, "Release starter edited")
    create_from_selection(web, "Template updated from board")
    with sqlite3.connect(database) as db:
        fresh, dependencies, _, _ = board_records(db, "Template updated from board")
        assert len(fresh) == 6 and len(dependencies) == 4
        assert {card["title"] for card in fresh}.issuperset({"Check published checksums", "Check release notes"})
        assert db.execute("SELECT count(*) FROM board_templates WHERE title = ?", ("Release starter edited",)).fetchone() == (1,)


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
            edit_example(web, database)
            request_window_close(web)
            wait_until(lambda: process_birth(driver, binary) is None, "destination desktop closed")
            web.terminated = True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary")
    run(parser.parse_args().binary)
    print("Native template capture, file round-trip, examples, quick edits, and update from board passed.")
