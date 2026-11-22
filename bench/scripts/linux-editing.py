#!/usr/bin/env python3
"""Verify Excalidraw editing and Raqsh persistence in the native Linux webview."""

import argparse
import json
from pathlib import Path
import runpy
import sqlite3
import time

from webkit_driver import isolated_library, open_disclosure, wait_until, webdriver

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
        scene = drawing.get("excalidraw")
        return scene if scene and predicate(scene) else None

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
    frame = checkpoint(root, lambda scene: any(item["type"] == "rectangle" for item in scene["elements"]))
    rectangle, = frame["elements"]
    assert [rectangle["x"], rectangle["y"], rectangle["width"], rectangle["height"]] == [320, 365, 120, 70]

    key(web, "p")
    drag(web, (210, 350), (270, 395))
    checkpoint(root, lambda scene: any(item["type"] == "freedraw" for item in scene["elements"]))

    key(web, "a")
    drag(web, (530, 350), (610, 405))
    arrow = next(item for item in checkpoint(root, lambda scene: any(item["type"] == "arrow" for item in scene["elements"]))
                 ["elements"] if item["type"] == "arrow")
    assert [arrow["x"], arrow["y"]] == [530, 350]
    assert arrow["points"][-1] == [80, 55]

    key(web, "t")
    click_canvas(web, 275, 320)
    wait_until(lambda: web.evaluate('return !!document.querySelector("textarea.excalidraw-wysiwyg");'), "native text editor")
    for letter in "Review":
        key(web, letter)
    key(web, ESCAPE)
    checkpoint(root, lambda scene: any(item.get("text") == "Review" for item in scene["elements"]))

    # One history entry covers a mixed card-and-text move.
    key(web, "v")
    click_canvas(web, 285, 280)
    drag(web, (75, 110), (348, 344))
    wait_until(lambda: web.evaluate('return document.querySelector(".lean-selection strong")?.textContent;') == "2 objects selected",
               "mixed selection")
    drag(web, (150, 175), (170, 195))
    revision(web, 7)
    checkpoint(root, lambda scene: any(item.get("text") == "Review" and item["x"] == 295 for item in scene["elements"]))
    key(web, "z", CONTROL)
    revision(web, 8)
    assert [card["x"] for card in cards(web)] == [120, 430]
    checkpoint(root, lambda scene: any(item.get("text") == "Review" and item["x"] == 275 for item in scene["elements"]))

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
    rich = rich_editing(web, root)
    close_editor(web)
    return rich


def rich_editing(web, root):
    def control(name):
        selector = f'.selected-shape-actions [data-testid="{name}"]'
        wait_until(lambda: web.evaluate("return !!document.querySelector(arguments[0])?.getClientRects().length;", selector),
                   f"native {name} control")
        web.evaluate("document.querySelector(arguments[0]).click();", selector)

    def element(scene, kind):
        return next((item for item in scene["elements"] if item["type"] == kind), {})

    key(web, "v")
    click_canvas(web, 380, 365)
    control("strokeWidth-extraBold")
    checkpoint(root, lambda scene: element(scene, "rectangle").get("strokeWidth") == 4)

    click_canvas(web, 569, 377)
    control("elbow-arrow")
    checkpoint(root, lambda scene: element(scene, "arrow").get("elbowed"))

    click_canvas(web, 760, 320)
    drag(web, (195, 345), (460, 443))
    key(web, "g", CONTROL)
    checkpoint(root, lambda scene: element(scene, "rectangle").get("groupIds")
               and element(scene, "rectangle")["groupIds"] == element(scene, "freedraw").get("groupIds"))

    web.click('.more-tools > summary')
    web.click('[data-tool="frame"]')
    drag(web, (680, 450), (875, 620))
    checkpoint(root, lambda scene: element(scene, "frame"))
    web.evaluate("""
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([
          '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="36"><rect width="48" height="36" fill="red"/></svg>'
        ], "local-shape.svg", {type: "image/svg+xml"}));
        document.querySelector("canvas.interactive").dispatchEvent(new DragEvent("drop", {
          dataTransfer, bubbles: true, clientX: 730, clientY: 510, cancelable: true
        }));
    """)
    rich = checkpoint(root, lambda scene: element(scene, "image").get("fileId") in scene["files"])
    assert element(rich, "image")["frameId"] == element(rich, "frame")["id"]
    assert rich["files"][element(rich, "image")["fileId"]]["dataURL"].startswith("data:image/svg+xml;base64,")
    key(web, "v")
    click_canvas(web, 295, 328)
    key(web, "c", CONTROL)
    pointer(web, at(web, 550, 490))
    key(web, "v", CONTROL)
    return checkpoint(root, lambda scene: sum(item.get("text") == "Review" for item in scene["elements"]) == 2)


def preview_exports(web):
    web.evaluate("""
        window.encodedPreviews = {};
        const original = window.fetch;
        window.fetch = function (url, options) {
            if (!String(url).endsWith("/export_preview")) return original.apply(this, arguments);
            const format = new Headers(options.headers).get("x-board-image");
            const response = new Response(options.body);
            const data = format === "svg" ? response.text() : response.arrayBuffer();
            return data.then(value => {
                window.encodedPreviews[format] = format === "svg" ? value : Array.from(new Uint8Array(value).slice(0, 8));
                return new Response("false", { headers: { "Tauri-Response": "ok" } });
            });
        };
    """)
    for index, kind in [(2, "png"), (3, "svg")]:
        open_disclosure(web, ".board-header")
        open_disclosure(web, ".export-menu")
        web.click(f".export-menu button:nth-child({index})")
        wait_until(lambda: web.evaluate("return window.encodedPreviews[arguments[0]];", kind), f"{kind} export IPC")
        wait_until(lambda: web.evaluate('return !document.querySelector(".board-header button").disabled;'), f"{kind} export completion")
    assert web.evaluate("return window.encodedPreviews.png;") == [137, 80, 78, 71, 13, 10, 26, 10]
    assert web.evaluate("return window.encodedPreviews.svg.includes('<image') && window.encodedPreviews.svg.includes('First task');")


def native_panels(web, root):
    web.click(".more-tools > summary")
    web.click("[data-drawing-library]")
    wait_until(lambda: web.evaluate('return !!document.querySelector(".default-sidebar")?.getClientRects().length;'),
               "native drawing library")
    web.click(".more-tools > summary")
    web.click("[data-drawing-library]")
    web.click(".more-tools > summary")
    web.click("[data-mermaid]")
    wait_until(lambda: web.evaluate('return !!document.querySelector(".excalidraw [role=dialog] textarea");'),
               "local Mermaid editor")
    web.evaluate("""
        const input = document.querySelector(".ttd-dialog textarea");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, arguments[0]);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    """, "flowchart TD\n  A[Implementation] --> B[Review result]")
    wait_until(lambda: web.evaluate("""
        const error = document.querySelector("[data-testid=ttd-dialog-output-error]");
        if (error) throw new Error(error.textContent);
        const canvas = document.querySelector(".ttd-dialog canvas");
        if (!canvas?.width || !canvas.height) return false;
        return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
          .some((value, index) => index % 4 === 3 && value > 0);
    """), "rendered Mermaid preview")
    web.evaluate('document.querySelector(".ttd-dialog textarea").focus();')
    key(web, ENTER, CONTROL)
    checkpoint(root, lambda scene: any(item.get("text") == "Review result" for item in scene["elements"]))


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
            preview_exports(web)
            native_panels(web, root)
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
