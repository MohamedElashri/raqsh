#!/usr/bin/env python3
"""Verify native fixture edits, scoped IPC and offline exports on Linux."""

import argparse
import ctypes
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import time

from webkit_driver import close_board, wait_until, webdriver


def button(session, text):
    element = session.call("POST", "/element", {"using": "xpath", "value": f"//button[normalize-space()='{text}']"})
    session.call("POST", f"/element/{element['element-6066-11e4-a52e-4f735466cecf']}/click", {})


def pointer(session, *actions):
    session.call("POST", "/actions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": actions}]})


def move(x, y):
    return {"type": "pointerMove", "x": x, "y": y, "origin": "viewport", "duration": 35}


def edit_card(session, top, x=112):
    session.click('[data-tool="text"]')
    pointer(session, move(x, top + 130), {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0})
    wait_until(lambda: session.evaluate('return !!document.querySelector(".lean-edit textarea");'), "card text editor")


def exported(session, format):
    name = format.upper()
    session.evaluate("window.fixtureExport = null;")
    button(session, f"Export {name}")
    wait_until(lambda: session.evaluate('return window.fixtureExport?.size && document.querySelector("[data-export-bytes]")?.download.endsWith(arguments[0]);', format), f"{name} export")
    return session.evaluate('''
        const format = arguments[0];
        const done = arguments[arguments.length - 1];
        const blob = window.fixtureExport;
        if (format === "svg") {
            blob.text().then((text) => {
                const svg = new DOMParser().parseFromString(text, "image/svg+xml");
                done({ bytes: blob.size, type: blob.type, cards: svg.querySelectorAll("rect").length,
                    paths: svg.querySelectorAll("polyline").length, firstEdge: svg.querySelector("polyline")?.getAttribute("points"),
                    rtl: Array.from(svg.querySelectorAll("text[direction=rtl]"), (node) => node.textContent),
                    external: svg.querySelectorAll("script, foreignObject, image, [href]").length });
            });
        } else {
            blob.arrayBuffer().then((bytes) => {
                const view = new DataView(bytes);
                done({ bytes: blob.size, type: blob.type, magic: view.getUint32(0), width: view.getUint32(16), height: view.getUint32(20) });
            });
        }
    ''', format, asynchronous=True)


class XKeyboard:
    def __init__(self, title):
        self.x11 = ctypes.CDLL("libX11.so.6")
        self.test = ctypes.CDLL("libXtst.so.6")
        self.x11.XOpenDisplay.restype = ctypes.c_void_p
        self.display = self.x11.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError("Cannot open nested X11 display")
        self.x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        self.x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self.x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
        self.x11.XStringToKeysym.restype = ctypes.c_ulong
        self.x11.XFlush.argtypes = [ctypes.c_void_p]
        self.x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        self.test.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        windows = subprocess.check_output(["xwininfo", "-root", "-tree"], text=True)
        for line in windows.splitlines():
            if f'"{title}"' not in line:
                continue
            window = line.split()[0]
            details = subprocess.run(["xwininfo", "-id", window], text=True, capture_output=True)
            if "Map State: IsViewable" in details.stdout:
                self.window = int(window, 16)
                self.x11.XSetInputFocus(self.display, self.window, 2, 0)
                self.x11.XFlush(self.display)
                return
        self.close()
        raise StopIteration(f"No mapped X11 window named {title!r}")

    def chord(self, *keys):
        codes = [self.x11.XKeysymToKeycode(self.display, self.x11.XStringToKeysym(key.encode())) for key in keys]
        assert all(codes), keys
        for code in codes:
            self.test.XTestFakeKeyEvent(self.display, code, 1, 0)
        for code in reversed(codes):
            self.test.XTestFakeKeyEvent(self.display, code, 0, 0)
        self.x11.XFlush(self.display)
        time.sleep(0.035)

    def close(self):
        self.x11.XCloseDisplay(self.display)


def x11_composition_and_clipboard(session):
    session.click(".lean-edit textarea")
    session.evaluate('''
        window.fixtureComposition = [];
        document.querySelector("textarea").value = "";
        for (const name of ["compositionstart", "compositionupdate", "compositionend"]) {
            document.querySelector("textarea").addEventListener(name, event => window.fixtureComposition.push([name, event.data, event.isTrusted]));
        }
    ''')
    keyboard = XKeyboard(session.evaluate("return document.title;"))
    try:
        time.sleep(0.2)
        keyboard.chord("Control_L", "Shift_L", "u")
        for digit in "0645":
            keyboard.chord(digit)
        keyboard.chord("Return")
        wait_until(lambda: session.evaluate('return document.querySelector("textarea").value === "م";'), "GTK Unicode input method commit")
        events = session.evaluate("return window.fixtureComposition;")
        assert ["compositionend", "م", True] in events, events
        keyboard.chord("Control_L", "a")
        keyboard.chord("Control_L", "c")
        copied = wait_until(lambda: subprocess.run(["xclip", "-selection", "clipboard", "-o"], text=True, capture_output=True).stdout, "X11 clipboard owner")
        assert copied == "م", copied
        keyboard.chord("BackSpace")
        keyboard.chord("Control_L", "v")
        wait_until(lambda: session.evaluate('return document.querySelector("textarea").value === "م";'), "trusted clipboard paste")
        return {"composition_events": events, "native_clipboard_roundtrip": copied}
    finally:
        keyboard.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--x11-input", action="store_true")
    settings = parser.parse_args()
    interfaces = [name for _, name in socket.if_nameindex()]
    if settings.offline:
        assert interfaces == ["lo"], interfaces

    with webdriver() as (launch, _):
        with launch(settings.binary, ("--fixture=normal", "--phase-zero-probe")) as session:
            wait_until(lambda: session.evaluate('return document.querySelector(".lean-editor")?.dataset.editorReady;'), "Canvas2D fixture")
            session.evaluate('''
                const create = URL.createObjectURL;
                URL.createObjectURL = function(blob) { window.fixtureExport = blob; return create.call(this, blob); };
            ''')
            before = exported(session, "svg")
            top = session.evaluate('return Math.round(document.querySelector("canvas.interactive").getBoundingClientRect().top);')
            panel = 'document.querySelector(".lean-editor").dataset'
            position = 'document.querySelector(\'[data-card-id="task-1"]\').style.left'
            assert session.evaluate(f"return {position};") == "80px"
            pointer(session, move(110, top + 139), {"type": "pointerDown", "button": 0}, *(move(110 + 5 * i, top + 139) for i in range(1, 11)))
            assert session.evaluate(f"return [{position}, Number({panel}.nativeBatches ?? 0)];") == ["130px", 0]
            pointer(session, {"type": "pointerUp", "button": 0})
            wait_until(lambda: session.evaluate(f"return {panel}.nativeBatches === '1';"), "one acknowledged drag batch")
            after_drag = exported(session, "svg")
            assert before["firstEdge"] != after_drag["firstEdge"]
            button(session, "Undo card")
            wait_until(lambda: session.evaluate(f"return {panel}.nativeBatches === '2' && {position} === '80px';"), "acknowledged inverse move")
            button(session, "Apply backend sample")
            wait_until(lambda: session.evaluate('return document.querySelector(\'[data-card-id="task-2"]\').textContent === "Backend-confirmed label";'), "injected card delta")

            edit_card(session, top)
            native_input = x11_composition_and_clipboard(session) if settings.x11_input else None
            session.evaluate('document.querySelector("textarea").value = "خطة الإطلاق — Task 42";')
            assert session.evaluate('return getComputedStyle(document.querySelector("textarea")).direction;') == "rtl"
            button(session, "Apply text")
            wait_until(lambda: session.evaluate(f"return {panel}.nativeBatches === '3';"), "text commit")
            session.evaluate('document.querySelector(\'[data-card-id="task-1"]\').focus();')
            session.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": [
                {"type": "keyDown", "value": "\ue007"}, {"type": "keyUp", "value": "\ue007"},
            ]}]})
            wait_until(lambda: session.evaluate('return document.querySelector("textarea")?.value === "خطة الإطلاق — Task 42";'), "keyboard card editing")
            button(session, "Cancel")

            session.click('[data-tool="pen"]')
            pointer(session, move(649, top + 217), {"type": "pointerDown", "button": 0}, move(670, top + 214), move(692, top + 226), {"type": "pointerUp", "button": 0})
            wait_until(lambda: session.evaluate(f"return {panel}.drawingChanges === '1' && {panel}.nativeBatches === '3';"), "freehand scene edit without native update")

            session.click('[data-tool="text"]')
            pointer(session, move(651, top + 298), {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0})
            wait_until(lambda: session.evaluate('return !!document.querySelector("textarea");'), "free text annotation")
            session.evaluate('document.querySelector("textarea").value = "Release annotation";')
            button(session, "Apply text")
            wait_until(lambda: session.evaluate('return document.querySelector(".lean-label")?.textContent === "Release annotation";'), "text annotation paint")
            button(session, "Save fixture")
            wait_until(lambda: session.evaluate('return document.querySelector("output")?.textContent.includes("Fixture saved");'), "explicit fixture checkpoint")
            close_board(session)
            session.click(".board-picker button")
            wait_until(lambda: session.evaluate('return document.querySelector(".lean-editor")?.dataset.editorReady;'), "fixture reopen")
            assert session.evaluate('return document.querySelector(\'[data-card-id="task-1"]\').textContent;') == "خطة الإطلاق — Task 42"
            assert session.evaluate('return document.querySelector(\'[data-card-id="task-2"]\').textContent;') == "Backend-confirmed label"
            assert session.evaluate('return document.querySelector(".lean-label")?.textContent;') == "Release annotation"

            session.click(".zoom-in-button")
            session.click('[data-tool="pan"]')
            pointer(session, move(650, top + 218), {"type": "pointerDown", "button": 0}, move(685, top + 226), {"type": "pointerUp", "button": 0})
            assert session.evaluate(f"return [Number({panel}.nativeBatches ?? 0), Number({panel}.drawingChanges ?? 0)];") == [0, 0]
            svg, png = exported(session, "svg"), exported(session, "png")
            assert svg["type"] == "image/svg+xml" and svg["cards"] == 200 and svg["paths"] == 401 and svg["external"] == 0
            assert "خطة الإطلاق — Task 42" in svg["rtl"], svg["rtl"]
            assert png["type"] == "image/png" and png["magic"] == 0x89504E47 and max(png["width"], png["height"]) == 4096

    with settings.binary.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    result = {"binary_sha256": digest, "interfaces": interfaces, "held_drag_samples": 10, "native_batches_before_release": 0,
              "native_batches_after_release": 1, "undo_and_backend_delta": True, "viewport_native_batches_and_drawing_changes": [0, 0],
              "saved_fixture_reopened": True, "keyboard_card_edit": True, "freehand_and_text_annotation": True,
              "native_input": native_input, "svg": svg, "png": png}
    settings.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
