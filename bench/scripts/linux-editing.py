#!/usr/bin/env python3
"""Verify Excalidraw editing and Raqsh persistence in the native Linux webview."""

import argparse
import json
from pathlib import Path
import runpy
import sqlite3
import time

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
    assert web.evaluate('return document.activeElement.closest("[data-board-surface]") !== null;')
    assert web.evaluate('return document.querySelector(".lean-editor").dataset.renderer;') == "excalidraw"
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

    # Excalidraw moves both cards in the live scene. Raqsh writes once on release.
    key(web, "v")
    drag(web, (55, 108), (640, 240))
    wait_until(lambda: all(card["selected"] for card in cards(web)), "native marquee")
    drag(web, (130, 160), (160, 180), lifted=False)
    wait_until(lambda: [card["x"] for card in cards(web)] == [120, 430], "live card drag")
    assert web.evaluate('return document.querySelector(".lean-editor").dataset.semanticRevision;') == "3"
    pointer(web, {"type": "pointerUp", "button": 0})
    revision(web, 4)
    key(web, RIGHT, SHIFT)
    revision(web, 5)
    assert [card["x"] for card in cards(web)] == [125, 435]
    key(web, "z", CONTROL)
    revision(web, 6)
    assert [card["x"] for card in cards(web)] == [120, 430]

    key(web, "r")
    drag(web, (320, 365), (440, 435))
    frame = checkpoint(root, lambda d: len(d["strokes"]) == 1)
    stroke, = frame["strokes"]
    assert [stroke["x"], stroke["y"]] == [320, 365]
    assert max(x for x, _ in stroke["points"]) == 120
    assert max(y for _, y in stroke["points"]) == 70

    key(web, "p")
    drag(web, (210, 350), (270, 395))
    checkpoint(root, lambda d: len(d["strokes"]) == 2)

    key(web, "a")
    drag(web, (530, 350), (610, 405))
    arrow, = checkpoint(root, lambda d: len(d["arrows"]) == 1)["arrows"]
    assert arrow["from"] == [530, 350] and arrow["to"] == [610, 405]

    key(web, "t")
    click_canvas(web, 275, 320)
    wait_until(lambda: web.evaluate('return !!document.querySelector("textarea.excalidraw-wysiwyg");'), "native text editor")
    for letter in "Review":
        key(web, letter)
    key(web, ESCAPE)
    checkpoint(root, lambda d: d["labels"] and d["labels"][0]["text"] == "Review")

    # One history entry covers a mixed card-and-text move.
    key(web, "v")
    drag(web, (75, 110), (348, 344))
    wait_until(lambda: web.evaluate('return document.querySelector(".lean-selection strong")?.textContent;') == "2 objects selected",
               "mixed selection")
    drag(web, (150, 175), (170, 195))
    revision(web, 7)
    checkpoint(root, lambda d: d["labels"][0]["x"] == 295)
    key(web, "z", CONTROL)
    revision(web, 8)
    assert [card["x"] for card in cards(web)] == [120, 430]
    expected = checkpoint(root, lambda d: d["labels"][0]["x"] == 275)

    key(web, "v")
    click_canvas(web, 160, 180)
    wait_until(lambda: cards(web)[0]["selected"], "card selection")
    key(web, ENTER)
    wait_until(lambda: web.evaluate('return document.querySelector("dialog[open] textarea")?.value;') == "First task",
               "keyboard card details")
    key(web, ESCAPE)
    click_canvas(web, 160, 180)
    wait_until(lambda: cards(web)[0]["selected"], "card selected before delete")
    key(web, DELETE)
    revision(web, 9)
    assert [card["title"] for card in cards(web)] == ["Second task"]
    key(web, "z", CONTROL)
    revision(web, 10)
    assert [card["title"] for card in cards(web)] == ["First task", "Second task"]
    close_editor(web)
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    with isolated_library() as root, webdriver() as (launch, _):
        with launch(args.binary, ("--fixture=empty",)) as web:
            drawing = edit_board(web, root)
        with launch(args.binary, ("--fixture=empty",)) as web:
            ready(web)
            revision(web, 10)
            assert [card["x"] for card in cards(web)] == [120, 430]
            assert checkpoint(root, lambda snapshot: snapshot == drawing)
            click_canvas(web, 175, 175)
            wait_until(lambda: web.evaluate('return document.querySelector(".lean-selection")?.innerText.includes("Required by Second task");'),
                       "saved dependency")
        with launch(args.binary, ("--fixture=normal",)) as web:
            ready(web)
            key(web, "+")
            key(web, "-")
            time.sleep(0.8)
            database = root / "data/dev.local.raqsh/library/boards.sqlite3"
            with sqlite3.connect(database) as connection:
                drawing_revision, payload = connection.execute(
                    "SELECT drawing_revision, drawing FROM boards WHERE title = 'normal'"
                ).fetchone()
            assert drawing_revision == 0, "Opening or zooming changed the fixture's drawing revision"
            assert len(json.loads(payload)["strokes"]) == 300
    print("Native editing and persistence passed.")


if __name__ == "__main__":
    main()
