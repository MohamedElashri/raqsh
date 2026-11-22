#!/usr/bin/env python3
"""Verify keyboard and pointer editing in the native Linux webview."""

import argparse
import json
from pathlib import Path
import runpy
import sqlite3

from webkit_driver import isolated_library, wait_until, webdriver

helpers = runpy.run_path(str(Path(__file__).with_name("linux-p1-proof.py")))
at, button, close_editor, pointer, ready, revision, text = (
    helpers[name] for name in ("at", "button", "close_editor", "pointer", "ready", "revision", "text")
)

CONTROL = "\ue009"
SHIFT = "\ue008"
ENTER = "\ue007"
ESCAPE = "\ue00c"
RIGHT = "\ue014"
DELETE = "\ue017"
F1 = "\ue031"


def key(web, value, *modifiers):
    actions = [{"type": "keyDown", "value": item} for item in (*modifiers, value)]
    actions.extend({"type": "keyUp", "value": item} for item in (value, *reversed(modifiers)))
    web.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": actions}]})


def drag(web, start, end, lifted=True):
    actions = [at(web, *start), {"type": "pointerDown", "button": 0}, at(web, *end)]
    if lifted:
        actions.append({"type": "pointerUp", "button": 0})
    pointer(web, *actions)


def click_canvas(web, x, y):
    pointer(web, at(web, x, y), {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0})


def cards(web):
    return web.evaluate("""
        return Array.from(document.querySelectorAll('[data-card-id]'), card => ({
            title: card.textContent, x: parseFloat(card.style.left), y: parseFloat(card.style.top),
            selected: card.dataset.selected === 'true'
        }));
    """)


def checkpoint(root, predicate):
    database = root / "data/dev.local.raqsh/library/boards.sqlite3"

    def snapshot():
        with sqlite3.connect(database) as connection:
            row = connection.execute("SELECT drawing FROM boards WHERE title = 'empty'").fetchone()
        drawing = json.loads(row[0])
        return drawing if predicate(drawing) else None

    return wait_until(snapshot, "drawing checkpoint")


def add_card(web, title, x):
    key(web, "n")
    text(web, 'dialog[open] [name="title"]', title)
    text(web, 'dialog[open] [name="x"]', str(x))
    text(web, 'dialog[open] [name="y"]', "130")
    key(web, ENTER, CONTROL)


def edit_board(web, root):
    ready(web)
    assert web.evaluate('return document.activeElement.matches("[data-board-surface]");')
    key(web, F1)
    wait_until(lambda: web.evaluate('return document.querySelector("dialog[open]")?.ariaLabel === "Board shortcuts";'),
               "board shortcuts")
    key(web, ESCAPE)
    add_card(web, "First task", 90)
    revision(web, 1)
    add_card(web, "Second task", 400)
    revision(web, 2)
    key(web, "c")
    click_canvas(web, 155, 175)
    click_canvas(web, 445, 175)
    revision(web, 3)

    # A marquee selects both cards. The drag previews both before committing one edit.
    key(web, "v")
    drag(web, (55, 108), (640, 240))
    assert all(card["selected"] for card in cards(web))
    drag(web, (130, 160), (160, 180), lifted=False)
    assert [card["x"] for card in cards(web)] == [120, 430]
    assert web.evaluate('return document.querySelector(".lean-editor").dataset.semanticRevision;') == "3"
    web.evaluate("""
        const fetch = window.fetch;
        window.fetch = function(url) {
            const response = fetch.apply(this, arguments);
            if (!String(url).endsWith('/apply_operation')) return response;
            window.fetch = fetch;
            return response.then(value => new Promise(resolve => {
                window.releaseMove = () => resolve(value);
            }));
        };
    """)
    pointer(web, {"type": "pointerUp", "button": 0})
    wait_until(lambda: web.evaluate("return !!window.releaseMove;"), "held drag receipt")
    assert [card["x"] for card in cards(web)] == [120, 430]
    assert web.evaluate('return document.querySelector(".lean-editor").dataset.semanticRevision;') == "3"
    web.evaluate("window.releaseMove();")
    revision(web, 4)
    key(web, RIGHT, SHIFT)
    revision(web, 5)
    assert [card["x"] for card in cards(web)] == [130, 440]
    key(web, "d", CONTROL)
    revision(web, 6)
    assert len(cards(web)) == 4
    key(web, DELETE)
    revision(web, 7)
    assert len(cards(web)) == 2
    key(web, "z", CONTROL)
    revision(web, 8)
    assert len(cards(web)) == 4
    key(web, "y", CONTROL)
    revision(web, 9)
    assert len(cards(web)) == 2

    # Select the interior of a rectangle, move it, resize it and change its ink.
    key(web, "r")
    drag(web, (320, 365), (440, 435))
    click_canvas(web, 380, 400)
    drag(web, (380, 400), (416, 420))
    drag(web, (476, 455), (496, 480))
    text(web, '.lean-selection label:first-of-type select', "blue")
    frame = checkpoint(root, lambda d: d["strokes"] and d["strokes"][0]["color"] == "blue")
    stroke, = frame["strokes"]
    assert [stroke["x"], stroke["y"]] == [356, 385]
    assert max(x for x, _ in stroke["points"]) == 140
    assert max(y for _, y in stroke["points"]) == 95

    key(web, "a")
    drag(web, (530, 350), (576, 390))
    drag(web, (576, 390), (602, 370))
    arrow = checkpoint(root, lambda d: d["arrows"] and d["arrows"][0]["to"] == [602, 370])["arrows"][0]
    assert arrow["from"] == [530, 350]

    key(web, "t")
    click_canvas(web, 270, 320)
    text(web, 'dialog[open] [name="title"]', "Draft")
    key(web, ENTER, CONTROL)
    wait_until(lambda: web.evaluate('return document.querySelector(".lean-label")?.textContent;'), "placed text")
    key(web, ENTER)
    text(web, 'dialog[open] [name="title"]', "مراجعة")
    key(web, ENTER, CONTROL)
    checkpoint(root, lambda d: d["labels"] and d["labels"][0]["text"] == "مراجعة")

    # Cards and drawing objects move together and undo as one action.
    drag(web, (91, 117), (355, 350))
    assert web.evaluate('return document.querySelector(".lean-selection strong")?.textContent;') == "2 objects selected"
    drag(web, (150, 176), (170, 196))
    revision(web, 10)
    assert cards(web)[0]["x"] == 150
    checkpoint(root, lambda d: d["labels"][0]["x"] == 290)
    key(web, "z", CONTROL)
    revision(web, 11)
    assert cards(web)[0]["x"] == 130
    checkpoint(root, lambda d: d["labels"][0]["x"] == 270)
    key(web, "z", CONTROL, SHIFT)
    revision(web, 12)
    assert cards(web)[0]["x"] == 150
    checkpoint(root, lambda d: d["labels"][0]["x"] == 290)
    click_canvas(web, 410, 200)
    assert "First task → Second task" in web.evaluate('return document.querySelector(".lean-selection")?.innerText;')
    key(web, DELETE)
    revision(web, 13)
    key(web, "z", CONTROL)
    revision(web, 14)
    close_editor(web)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    with isolated_library() as root, webdriver() as (launch, _):
        with launch(args.binary, ("--fixture=empty",)) as web:
            edit_board(web, root)
        with launch(args.binary, ("--fixture=empty",)) as web:
            ready(web)
            revision(web, 14)
            assert [card["x"] for card in cards(web)] == [150, 440]
            assert web.evaluate('return document.querySelector(".lean-label").textContent;') == "مراجعة"
            checkpoint(root, lambda d: d["labels"][0]["x"] == 290 and d["strokes"][0]["color"] == "blue")
    print("Native editing and persistence passed.")


if __name__ == "__main__":
    main()
