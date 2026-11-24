#!/usr/bin/env python3
"""Exercise the persisted editor through native WebKit, including a hard kill."""

import argparse
from base64 import b64decode
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import struct
import time
from xml.etree import ElementTree

from webkit_driver import open_disclosure, close_board, isolated_library, process_birth, wait_until, webdriver

# Reuse the gesture and native X11 helpers from the Phase 0 proof.
import runpy

helpers = runpy.run_path(str(Path(__file__).with_name("linux-fixture-proof.py")))
button, pointer, move, XKeyboard, native_text_input = (
    helpers[key] for key in ("button", "pointer", "move", "XKeyboard", "x11_composition_and_clipboard")
)
percentiles = runpy.run_path(str(Path(__file__).with_name("linux-input-timing.py")))["percentiles"]

TRACE = '''
window.boardCalls = [];
const originalFetch = window.fetch;
window.fetch = function(url, options) {
    const command = String(url).split('/').at(-1);
    const tracked = ["apply_operation", "save_drawing", "open_board", "board_deltas"].includes(command);
    const started = performance.now();
    const entry = tracked ? { command, input: JSON.parse(options.body) } : null;
    if (entry) window.boardCalls.push(entry);
    return originalFetch.apply(this, arguments).then(response => {
        if (entry) void response.clone().json().then(result => {
            Object.assign(entry, { result, elapsed: performance.now() - started,
                accepted: response.headers.get("Tauri-Response") === "ok" });
        });
        if (command === "save_drawing" && window.holdCheckpoint) {
            window.holdCheckpoint = false;
            return new Promise(resolve => { window.releaseCheckpoint = () => resolve(response); });
        }
        return response;
    });
};
'''


def exists(session, selector):
    return session.evaluate("return !!document.querySelector(arguments[0]);", selector)


def ready(session):
    wait_until(lambda: exists(session, '[data-editor-ready="true"]'), "mounted editor")


def revision(session, expected):
    wait_until(lambda: exists(session, f'[data-semantic-revision="{expected}"]'), f"semantic revision {expected}")


def text(session, selector, value):
    wait_until(lambda: exists(session, selector), selector)
    session.evaluate("""
        const input = document.querySelector(arguments[0]);
        input.value = arguments[1];
        input.dispatchEvent(new Event('change', { bubbles: true }));
    """, selector, value)


def element_click(session, selector):
    session.evaluate("document.querySelector(arguments[0]).click();", selector)


def add(session, title, *, kind="task", status="todo", priority="normal"):
    open_disclosure(session, ".board-header")
    button(session, "Add card")
    text(session, '.lean-edit [name="title"]', title)
    for name, value in [("kind", kind), ("status", status), ("priority", priority)]:
        text(session, f'.lean-edit [name="{name}"]', value)
    button(session, "Create card")


def card_id(session, title):
    return session.evaluate("""
        return Array.from(document.querySelectorAll("[data-card-id]"))
            .find(card => card.textContent === arguments[0])?.dataset.cardId;
    """, title)


def edit(session, title):
    element_click(session, f'[data-card-id="{card_id(session, title)}"]')


def choose_card(session, title):
    session.evaluate("""
        Array.from(document.querySelectorAll(".lean-inspector button"))
            .find(card => card.textContent === arguments[0]).click();
    """, title)


def at(session, x, y):
    top = session.evaluate('return Math.round(document.querySelector("canvas").getBoundingClientRect().top);')
    return move(x, y + top)


def annotation(session, title, *, x=640, y=272):
    session.click('[data-tool="text"]')
    pointer(session, at(session, x, y), {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0})
    text(session, '.lean-edit textarea', title)
    button(session, "Place text")


def close_editor(session):
    close_board(session)
    wait_until(lambda: exists(session, ".board-link:not(:disabled)"), "ready board library")


def tracked(session, command):
    return session.evaluate("return window.boardCalls.filter(call => call.command === arguments[0]);", command)


def native_invoke(session, command, arguments):
    return session.evaluate("""
        const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
            .then(result => done({ result }), error => done({ error }));
    """, command, arguments, asynchronous=True)


def native_path(title, path):
    keyboard = wait_until(lambda: focus_if_present(title), title)
    try:
        keyboard.chord("Control_L", "l")
        time.sleep(0.25)
        keyboard.chord("Control_L", "a")
        for character in str(path):
            name = {"/": "slash", "-": "minus", ".": "period", "_": "underscore"}.get(character, character)
            if name == "underscore":
                keyboard.chord("Shift_L", "minus")
            elif name.isupper():
                keyboard.chord("Shift_L", name.lower())
            else:
                keyboard.chord(name)
        keyboard.chord("Return")
    finally:
        keyboard.close()


def focus_if_present(title):
    try:
        return XKeyboard(title)
    except StopIteration:
        return None


def request_window_close(session):
    title = session.evaluate("return document.title;")
    keyboard = XKeyboard(title)
    try:
        window = keyboard.window

        class ClientMessage(ctypes.Structure):
            _fields_ = [
                ("kind", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                ("display", ctypes.c_void_p), ("window", ctypes.c_ulong),
                ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("data", ctypes.c_long * 5),
            ]

        class Event(ctypes.Union):
            _fields_ = [("client", ClientMessage), ("pad", ctypes.c_long * 24)]

        x11 = keyboard.x11
        x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        x11.XInternAtom.restype = ctypes.c_ulong
        x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
        event = Event()
        event.client.kind = 33  # X11 ClientMessage
        event.client.display = keyboard.display
        event.client.window = window
        event.client.message_type = x11.XInternAtom(keyboard.display, b"WM_PROTOCOLS", 0)
        event.client.format = 32
        event.client.data[0] = x11.XInternAtom(keyboard.display, b"WM_DELETE_WINDOW", 0)
        assert x11.XSendEvent(keyboard.display, window, 0, 0, ctypes.byref(event))
        x11.XFlush(keyboard.display)
    finally:
        keyboard.close()


def read_export(session, label, path):
    open_disclosure(session, ".board-header")
    open_disclosure(session, ".export-menu")
    button(session, label)
    native_path("Export board", path)
    return wait_until(lambda: path.read_bytes() if path.exists() and path.stat().st_size else None, f"{label} file")


def native_exports(session, root):
    board_path = root / "board.raqsh"
    board = json.loads(read_export(session, "Board file…", board_path))
    assert board["format"] == "dev.local.raqsh.board" and board["schemaVersion"] == 1
    assert str(root) not in json.dumps(board)
    svg_bytes = read_export(session, "SVG…", root / "board.svg")
    svg = ElementTree.fromstring(svg_bytes)
    namespace = {"s": "http://www.w3.org/2000/svg"}
    assert not svg.findall(".//s:script", namespace)
    assert any(node.text == "خطة & <review>" for node in svg.findall(".//s:text", namespace))
    assert b"&amp; &lt;review&gt;" in svg_bytes
    note = next(node for node in svg.findall(".//s:text", namespace) if node.text == "Committed annotation")
    assert note.attrib["font-family"].startswith("Excalifont,")
    embedded_font = re.search(rb"data:font/woff2;base64,([A-Za-z0-9+/=]+)", svg_bytes)
    assert embedded_font is not None
    font = Path(__file__).resolve().parents[2] / "apps/desktop/src/lean/fonts/Excalifont-Regular.woff2"
    assert b64decode(embedded_font[1], validate=True) == font.read_bytes()
    x, y, width, height = (float(value) for value in svg.attrib["viewBox"].split())
    for node in board["nodes"]:
        assert x <= node["x"] <= node["x"] + node["width"] <= x + width
        assert y <= node["y"] <= node["y"] + node["height"] <= y + height
    png = read_export(session, "PNG…", root / "board.png")
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    dimensions = struct.unpack(">II", png[16:24])
    assert all(0 < size <= 4096 for size in dimensions)
    close_editor(session)
    upload = session.element('input[type="file"]')
    session.call("POST", f"/element/{upload}/value", {"text": str(board_path), "value": list(str(board_path))})
    ready(session)
    assert set(node["id"] for node in board["nodes"]).isdisjoint(session.evaluate(
        'return Array.from(document.querySelectorAll("[data-card-id]"), card => card.dataset.cardId);'))
    assert exists(session, '.lean-label')
    close_editor(session)
    return {"roundtrip": True, "svg_viewbox": [x, y, width, height], "svg_bytes": len(svg_bytes),
            "svg_embedded_font": "Excalifont", "png_dimensions": dimensions, "png_bytes": len(png)}


def exercise(launch, parent, binary, root, native):
    result = {}
    with launch(binary, () if native else ("--fixture=empty",)) as session:
        if native:
            wait_until(lambda: exists(session, ".onboarding-dialog[open]"), "first-run tour")
            button(session, "Skip tour")
            button(session, "Open project folder…")
            native_path("Choose a project or worktree", root / "worktree")
            wait_until(lambda: exists(session, ".library-start-copy"), "first board guidance")
        else:
            ready(session)
            close_editor(session)
        session.evaluate(TRACE)
        text(session, 'input[aria-label="New board title"]', "Planning")
        button(session, "Create board")
        ready(session)
        wait_until(lambda: any(call.get("accepted") for call in tracked(session, "board_deltas")),
                   "initial semantic catch-up")
        add(session, "Group", kind="group")
        revision(session, 1)
        add(session, "خطة & <review>", status="blocked", priority="high")
        revision(session, 2)
        add(session, "Next")
        revision(session, 3)
        group, task = (card_id(session, title) for title in ("Group", "خطة & <review>"))
        task_selector = f'[data-card-id="{task}"]'
        assert exists(session, task_selector + '[data-status="blocked"][data-priority="high"]')
        edit(session, "خطة & <review>")
        assert session.evaluate('return getComputedStyle(document.querySelector(".lean-edit textarea")).direction;') == "rtl"
        if native:
            result["native_text_input"] = native_text_input(session)
            text(session, '.lean-edit [name="title"]', "خطة & <review>")
        text(session, '.lean-edit [name="parent"]', group)
        text(session, '.lean-edit [name="description"]', "Local plan")
        button(session, "Save card")
        revision(session, 4)
        assert "Group" in session.evaluate('return document.querySelector(".lean-selection small").textContent;')
        edit(session, "خطة & <review>")
        text(session, '.lean-edit [name="parent"]', "")
        button(session, "Save card")
        revision(session, 5)
        button(session, "Drop")
        revision(session, 6)
        assert exists(session, task_selector + '[data-dropped="true"]')
        button(session, "Restore")
        revision(session, 7)
        assert exists(session, task_selector + '[data-dropped="false"]')
        button(session, "Move earlier")
        revision(session, 8)
        open_disclosure(session, ".board-header")
        session.click('.board-menu button[data-menu-history="undo"]')
        revision(session, 9)
        button(session, "Library")
        open_disclosure(session, ".more-tools")
        session.click('[data-tool="connect"]')
        choose_card(session, "خطة & <review>")
        choose_card(session, "Next")
        try:
            revision(session, 10)
        except RuntimeError as failure:
            raise RuntimeError(session.evaluate("return document.body.innerText;")) from failure
        choose_card(session, "Next")
        choose_card(session, "خطة & <review>")
        wait_until(lambda: exists(session, '[data-card-save]') and "cycle" in session.evaluate(
            'return document.querySelector("[data-card-save]").textContent;'), "dependency cycle reported")
        button(session, "Dismiss card change")
        button(session, "Library")
        session.click('[data-tool="select"]')
        before = len(tracked(session, "apply_operation"))
        pointer(session, at(session, 144, 146), {"type": "pointerDown", "button": 0},
                *(at(session, 144 + 4 * step, 146) for step in range(1, 11)))
        assert len(tracked(session, "apply_operation")) == before
        pointer(session, {"type": "pointerUp", "button": 0})
        revision(session, 11)
        assert len(tracked(session, "apply_operation")) == before + 1
        open_disclosure(session, ".board-header")
        session.click('.board-menu button[data-menu-history="undo"]')
        revision(session, 12)

        session.click('[data-tool="pen"]')
        pointer(session, at(session, 620, 200), {"type": "pointerDown", "button": 0}, at(session, 665, 212))
        assert len(tracked(session, "save_drawing")) == 0
        pointer(session, {"type": "pointerUp", "button": 0})
        annotation(session, "Committed annotation")
        saved = wait_until(lambda: next((call for call in tracked(session, "save_drawing") if call.get("accepted")), None), "drawing commit")
        assert saved["input"]["generation"] == 2 and saved["result"] == 1
        before = len(tracked(session, "save_drawing"))
        session.click(".zoom-in-button")
        session.click('[data-tool="pan"]')
        pointer(session, at(session, 620, 200), {"type": "pointerDown", "button": 0}, at(session, 660, 210), {"type": "pointerUp", "button": 0})
        time.sleep(0.6)
        assert len(tracked(session, "save_drawing")) == before

        db = root / "data/dev.local.raqsh/library/boards.sqlite3"
        with sqlite3.connect(db, timeout=1) as blocker:
            blocker.execute("BEGIN EXCLUSIVE")
            annotation(session, "Flush retry", y=320)
            close_board(session)
            wait_until(lambda: exists(session, '.lean-close[role="alertdialog"]'), "close-time save error")
            blocker.rollback()
        button(session, "Retry close")
        wait_until(lambda: exists(session, ".library"), "retried close")
        row = f'[data-board-id="{saved["input"]["scope"]["boardId"]}"]'
        session.click(row)
        ready(session)
        assert exists(session, task_selector)
        assert "checkpoint 2" in session.evaluate('return document.querySelector("[data-drawing-save]").textContent;')
        stale = native_invoke(session, "save_drawing", saved["input"])
        assert "no longer owns" in stale["error"]
        drawing = tracked(session, "open_board")[-1]["result"]["drawing"]
        assert [label["text"] for label in drawing["labels"]] == ["Committed annotation", "Flush retry"]
        assert len(drawing["strokes"]) == 1

        if native:
            result["exports"] = native_exports(session, root)
            session.click(row)
            ready(session)
        calls = [call for call in tracked(session, "apply_operation") if call.get("accepted")]
        result.update(typed_commits=len(calls), held_drag_moves=10, drag_ipc_during_gesture=0,
                      pen_ipc_during_gesture=0, coalesced_generations=2, viewport_checkpoints=0,
                      stale_editor_rejected=True, close_failure_retry=True,
                      semantic_ack=percentiles([call["elapsed"] for call in calls]),
                      reducer=percentiles([call["result"]["reducerMicros"] / 1000 for call in calls]))
        with sqlite3.connect(db, timeout=1) as blocker:
            blocker.execute("BEGIN IMMEDIATE")
            annotation(session, "Uncommitted annotation", y=375)
            pid, _ = wait_until(lambda: process_birth(parent, binary), "desktop process")
            os.kill(pid, signal.SIGKILL)
            blocker.rollback()
            # WebDriver's native inspector may disconnect immediately with the process.
            session.terminated = True

    with launch(binary) as session:
        project = '[aria-label="Projects"] .project-link:not(:disabled)'
        wait_until(lambda: exists(session, project), "durable project library")
        session.click(project)
        wait_until(lambda: exists(session, row), "durable board row")
        session.click(row)
        ready(session)
        revision(session, 12)
        assert exists(session, task_selector)
        labels = session.evaluate('return Array.from(document.querySelectorAll(".lean-label"), label => label.textContent);')
        assert labels == ["Committed annotation", "Flush retry"], labels
        close_editor(session)
        session.click(row + " + button")
        text(session, 'input[aria-label="Rename board title"]', "Recovered plan")
        button(session, "Save name")
        wait_until(lambda: session.evaluate('return document.querySelector(arguments[0])?.textContent === "Recovered plan";', row), "board rename")
        session.evaluate('document.querySelector(arguments[0]).parentElement.lastElementChild.click();', row)
        button(session, "Delete board")
        wait_until(lambda: not exists(session, row), "board deletion")
        if native:
            request_window_close(session)
            wait_until(lambda: process_birth(parent, binary) is None, "native library close")
            session.terminated = True
    result.update(hard_kill_semantic_revision=12, hard_kill_drawing_checkpoint=2, metadata_rename_delete=True)
    return result


def checkpoint_queue(launch, parent, binary, root, native):
    with launch(binary, ("--fixture=tiny",)) as session:
        ready(session)
        session.evaluate(TRACE + "window.holdCheckpoint = true;")
        annotation(session, "First in flight")
        wait_until(lambda: session.evaluate("return !!window.releaseCheckpoint;"), "held drawing reply")
        annotation(session, "Newer generation", y=320)
        time.sleep(0.65)
        assert len(tracked(session, "save_drawing")) == 1
        session.evaluate("window.releaseCheckpoint();")
        coalesced = wait_until(lambda: [call for call in tracked(session, "save_drawing")
                                       if call.get("accepted") and call["result"] == 2], "second checkpoint")
        assert coalesced[0]["input"]["generation"] == 2

        def saved(revision):
            return next((call["input"]["drawing"] for call in tracked(session, "save_drawing")
                         if call.get("accepted") and call["result"] == revision), None)

        session.click('[data-tool="arrow"]')
        pointer(session, at(session, 620, 200), {"type": "pointerDown", "button": 0}, at(session, 665, 212),
                {"type": "pointerUp", "button": 0})
        assert len(wait_until(lambda: saved(3), "freeform arrow checkpoint")["arrows"]) == 1
        session.click('[data-history="undo"]')
        assert wait_until(lambda: saved(4), "freeform undo checkpoint")["arrows"] == []
        result = {"one_snapshot_in_flight": True, "freeform_arrow_and_undo": True}
        if not native:
            close_editor(session)
            return result
        annotation(session, "Native window flush", y=375)
        request_window_close(session)
        wait_until(lambda: process_birth(parent, binary) is None, "requested native close")
        session.terminated = True
        db = root / "data/dev.local.raqsh/library/boards.sqlite3"
        with sqlite3.connect(db) as connection:
            revision, drawing = connection.execute("SELECT drawing_revision, drawing FROM boards WHERE title='tiny'").fetchone()
        assert revision == 5
        assert json.loads(drawing)["labels"][-1]["text"] == "Native window flush"
        return {**result, "native_window_flush_revision": revision}


def normal_commits(launch, binary, count=30):
    with launch(binary, ("--fixture=normal",)) as session:
        ready(session)
        session.evaluate(TRACE)
        def select_first_card():
            if exists(session, ".lean-edit"):
                return True
            element_click(session, "[data-card-id]")

        wait_until(select_first_card, "card editor after initial semantic catch-up")
        button(session, "Cancel")
        for index in range(count):
            button(session, "Restore" if index % 2 else "Drop")
            revision(session, index + 1)
        calls = wait_until(lambda: [call for call in tracked(session, "apply_operation") if call.get("accepted")]
                           if len([call for call in tracked(session, "apply_operation") if call.get("accepted")]) == count
                           else None, "normal fixture commit receipts")
        result = {
            "samples": count,
            "ipc_and_disk": percentiles([call["elapsed"] for call in calls]),
            "reducer_without_disk": percentiles([call["result"]["reducerMicros"] / 1000 for call in calls]),
        }
        if "sqliteCommitMicros" in calls[0]["result"]:
            breakdown = {"queue": "queueMicros", "storage": "storageMicros", "sqlite_commit": "sqliteCommitMicros"}
            samples = [
                {"ipc": call["elapsed"], **{name: call["result"][field] / 1000 for name, field in breakdown.items()}}
                for call in calls
            ]
            for name in breakdown:
                result[name] = percentiles([sample[name] for sample in samples])
            result["ack_minus_sqlite_commit"] = percentiles([sample["ipc"] - sample["sqlite_commit"] for sample in samples])
            result["samples_ms"] = samples
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--native-dialogs", action="store_true")
    settings = parser.parse_args()
    interfaces = [name for _, name in socket.if_nameindex()]
    if settings.offline:
        assert interfaces == ["lo"], interfaces
    with isolated_library() as root, webdriver() as (launch, parent):
        result = exercise(launch, parent, settings.binary, root, settings.native_dialogs)
        result.update(checkpoint_queue(launch, parent, settings.binary, root, settings.native_dialogs))
        if not settings.native_dialogs:
            result["normal_board_commits"] = normal_commits(launch, settings.binary)
    result.update(binary_sha256=hashlib.file_digest(settings.binary.open("rb"), "sha256").hexdigest(), interfaces=interfaces)
    settings.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
