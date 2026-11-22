#!/usr/bin/env python3
"""Check the release editor's keyboard, focus, accessibility and canvas scale."""
import argparse
from base64 import b64decode
from collections import deque
import hashlib
import json
from pathlib import Path
import runpy

from webkit_driver import open_disclosure, isolated_library, process_birth, wait_until, webdriver

p1 = runpy.run_path(str(Path(__file__).with_name("linux-p1-proof.py")))
annotation, button, ready, revision, close_editor, native_text_input = (
    p1[name] for name in ("annotation", "button", "ready", "revision", "close_editor", "native_text_input")
)
pointer, at = (p1[name] for name in ("pointer", "at"))
KEYS = {"Tab": "\ue004", "Enter": "\ue007", "Escape": "\ue00c",
        "End": "\ue010", "ArrowDown": "\ue015", "Insert": "\ue016"}


def key(web, name):
    value = KEYS[name]
    web.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": [
        {"type": "keyDown", "value": value}, {"type": "keyUp", "value": value}
    ]}]})


def focus(web, selector):
    web.evaluate("document.querySelector(arguments[0]).focus();", selector)
    check_focus(web, selector)


def check_focus(web, selector):
    wait_until(lambda: web.evaluate("return document.activeElement.matches(arguments[0]);", selector), f"focus on {selector}")


def accessible(pid, names, roles=None):
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib

    Atspi.init()
    desktop = Atspi.get_desktop(0)
    seen = {}

    def labels():
        try:
            roots = [desktop.get_child_at_index(index) for index in range(desktop.get_child_count())]
            pending = deque(root for root in roots if root.get_process_id() == pid)
            found = {}
            while pending:
                item = pending.popleft()
                name = item.get_name()
                role = item.get_role_name()
                if name:
                    seen[name] = role
                label = next((label for label in names if name == label or (
                    name and role == "entry" and name.startswith(label + " ")
                )), None)
                if label and (not roles or label not in roles or role == roles[label]):
                    found[label] = {"name": name, "role": role, "description": item.get_description(),
                                    "focused": item.get_state_set().contains(Atspi.StateType.FOCUSED)}
                if found.keys() >= names:
                    return found
                pending.extend(item.get_child_at_index(index) for index in range(item.get_child_count()))
        except GLib.Error:
            return None

    try:
        return wait_until(labels, "accessible names " + ", ".join(sorted(names)))
    except RuntimeError as failure:
        raise RuntimeError(f"Accessible roles and names in test window: {seen}") from failure


def exercise(web, pid, settings):
    ready(web)
    start_revision = web.evaluate('return Number(document.querySelector(".lean-editor").dataset.semanticRevision);')
    canvas = "[data-board-surface]"
    initial = web.evaluate("""
        const canvas = document.querySelector("[data-board-surface]");
        return { pixel_ratio: devicePixelRatio, css: [canvas.clientWidth, canvas.clientHeight],
                 backing: [canvas.width, canvas.height], cards: document.querySelectorAll("[data-card-id]").length,
                 background: getComputedStyle(canvas.parentElement).backgroundColor,
                 color_scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" };
    """)
    assert initial["pixel_ratio"] == settings.scale, initial
    assert initial["backing"] == [round(pixel * settings.scale) for pixel in initial["css"]], initial
    assert initial["cards"] == 10, initial
    if settings.dark:
        assert initial["color_scheme"] == "dark", initial
    check_focus(web, ".board-header > summary")
    key(web, "Tab")
    check_focus(web, canvas)
    a11y = {}
    if settings.atspi:
        a11y["board"] = accessible(pid, {"Drawing canvas", "Library", "Agents", "Shortcuts"})
        assert a11y["board"]["Drawing canvas"]["focused"], a11y

    key(web, "ArrowDown")
    key(web, "Enter")
    check_focus(web, 'dialog[open] [name="title"]')
    if settings.atspi:
        a11y["editor"] = accessible(pid, {"Edit card", "X position", "Width", "Save card"}, {"Edit card": "dialog"})
        assert a11y["editor"]["Edit card"]["role"] == "dialog", a11y
    key(web, "Escape")
    check_focus(web, canvas)
    key(web, "Insert")
    check_focus(web, 'dialog[open] [name="title"]')
    key(web, "Escape")
    check_focus(web, canvas)

    key(web, "Enter")
    check_focus(web, 'dialog[open] [name="title"]')
    web.evaluate("document.activeElement.select();")
    native_text = None
    if settings.native_text:
        native_text = native_text_input(web)
    else:
        item = web.element('dialog[open] [name="title"]')
        web.call("POST", f"/element/{item}/value", {"text": "Keyboard edited card"})
    title = web.evaluate('return document.querySelector("[name=title]").value;')
    for name, value in (("x", "91.125"), ("width", "242")):
        selector = f'dialog[open] [name="{name}"]'
        item = web.element(selector)
        web.call("POST", f"/element/{item}/clear", {})
        web.call("POST", f"/element/{item}/value", {"text": value})
    focus(web, 'dialog[open] [type="submit"]')
    key(web, "Enter")
    try:
        revision(web, start_revision + 1)
    except RuntimeError as failure:
        state = web.evaluate("""
            return {body: document.body.innerText, editor: document.querySelector(".lean-editor").dataset.semanticRevision,
                    inputs: Array.from(document.querySelectorAll(".lean-edit input, .lean-edit textarea"))
                        .map(input => [input.name, input.value, input.validationMessage])};
        """)
        raise RuntimeError(state) from failure
    check_focus(web, canvas)
    assert web.evaluate("""
        const card = document.querySelector('[data-card-id][data-selected="true"]');
        return card.textContent === arguments[0] && card.style.left === "91.125px" && card.style.width === "242px";
    """, title)

    open_disclosure(web, ".more-tools")
    web.click('[data-tool="connect"]')
    focus(web, canvas)
    key(web, "Enter")
    key(web, "ArrowDown")
    key(web, "ArrowDown")
    key(web, "Enter")
    revision(web, start_revision + 2)
    assert web.evaluate('return document.querySelector(".lean-selection").textContent.includes(arguments[0]);', title)

    button(web, "Library")
    check_focus(web, ".lean-inspector button")
    key(web, "End")
    check_focus(web, ".lean-inspector li:last-child button")
    assert web.evaluate('return document.querySelectorAll(".lean-inspector button[tabindex=\'0\']").length === 1;')
    button(web, "Shortcuts")
    check_focus(web, 'dialog[open] button')
    key(web, "Escape")
    check_focus(web, ".lean-help")
    assert web.evaluate('return !!document.querySelector(".lean-inspector");')
    key(web, "Escape")
    assert web.evaluate('return document.activeElement.textContent === "Library";')

    if settings.workspace:
        web.click(".zoom-in-button")
        selector = ".lean-zoom button:nth-child(2)"
        wait_until(lambda: web.evaluate('return document.querySelector(arguments[0]).textContent === "110%";', selector),
                   "zoom percentage")
        web.click(selector)
        wait_until(lambda: web.evaluate('return document.querySelector(arguments[0]).textContent === "100%";', selector),
                   "reset view")
        button(web, "Library")
        assert web.evaluate('return !!document.querySelector(".lean-inspector");')
        button(web, "Agents")
        check_focus(web, ".agent-panel header button")
        assert web.evaluate('return !document.querySelector(".lean-inspector");')
        key(web, "Escape")
        check_focus(web, ".lean-presence[aria-expanded=false]")
        button(web, "Edit card")
        check_focus(web, 'dialog[open] [name="title"]')
        key(web, "Escape")
        check_focus(web, ".lean-selection button:first-of-type")

        annotation(web, "Sketch the plan first.\nThen connect the pieces.", x=94, y=405)
        initial["board_typography"] = wait_until(lambda: web.evaluate("""
            const note = document.querySelector(".lean-label");
            const presence = document.querySelector(".lean-presence");
            const card = document.querySelector(".lean-card");
            const face = Array.from(document.fonts).find(face => face.family === "Excalifont");
            if (!note || face?.status !== "loaded") return null;
            return {note: getComputedStyle(note).fontFamily, presence: getComputedStyle(presence).fontFamily,
                    card: getComputedStyle(card).fontFamily, face_status: face.status};
        """), "handwritten board text")
        for element in ("note", "presence"):
            assert initial["board_typography"][element].startswith("Excalifont"), initial
        assert initial["board_typography"]["card"].startswith("Nunito"), initial
        focus(web, canvas)
        key(web, "Escape")
        web.click('[data-tool="select"]')
        initial["layout"] = web.evaluate("""
            const box = selector => {
                const {x, y, width, height} = document.querySelector(selector).getBoundingClientRect();
                return [x, y, width, height];
            };
            return {toolbar: box(".lean-toolbar"), menu: box(".board-header"),
                    library: box(".lean-board-actions"), zoom: box(".lean-zoom"),
                    presence: box(".lean-presence"), help: box(".lean-help")};
        """)
        assert initial["layout"]["toolbar"][1] == 16, initial

    if settings.screenshot:
        if settings.workspace:
            wait_until(lambda: web.evaluate('return !document.querySelector(".lean-status[data-visible=true]");'),
                       "saved annotation")
        settings.screenshot.write_bytes(b64decode(web.call("GET", "/screenshot")))
    if settings.workspace:
        def bitmap():
            return web.evaluate('return document.querySelector("canvas").toDataURL();')

        before = bitmap()
        web.click('[data-tool="rectangle"]')
        pointer(web, at(web, 90, 494), {"type": "pointerDown", "button": 0},
                at(web, 180, 540), {"type": "pointerUp", "button": 0})
        with_shape = wait_until(lambda: (image := bitmap()) != before and image, "rectangle on the canvas")
        web.click('[data-tool="eraser"]')
        pointer(web, at(web, 135, 494), {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0})
        wait_until(lambda: bitmap() == before, "erased rectangle")
        button(web, "Undo drawing")
        wait_until(lambda: bitmap() == with_shape, "undo erase")
        button(web, "Redo drawing")
        wait_until(lambda: bitmap() == before, "redo erase")
        initial["shape_history"] = True
        frame = web.call("GET", "/window/rect")
        web.call("POST", "/window/rect", {"width": 480, "height": 360})
        initial["compact_layout"] = wait_until(lambda: web.evaluate("""
            const canvas = document.querySelector("[data-board-surface]");
            const rail = document.querySelector(".lean-toolbar");
            const tools = rail.getBoundingClientRect();
            const panels = document.querySelector(".lean-board-actions").getBoundingClientRect();
            const zoom = document.querySelector(".lean-zoom").getBoundingClientRect();
            const presence = document.querySelector(".lean-presence").getBoundingClientRect();
            return canvas.clientWidth === 480 && panels.bottom < tools.top && tools.bottom < zoom.top &&
                presence.bottom < zoom.top &&
                tools.left >= 0 && tools.right <= 480 && rail.scrollWidth <= rail.clientWidth &&
                new Set(Array.from(rail.querySelectorAll(":scope > button, .more-tools > summary"),
                    button => button.getBoundingClientRect().top)).size === 1 &&
                [canvas.clientWidth, canvas.clientHeight];
        """), "usable dock at the minimum window size")
        web.call("POST", "/window/rect", {name: frame[name] for name in ("width", "height")})
    close_editor(web)
    check_focus(web, ".board-link")
    if settings.workspace:
        assert web.evaluate('return !!document.querySelector(".library-sidebar .project-link");')
    return {**initial, "keyboard_actions": ["select", "edit", "add and cancel", "numeric geometry",
                                           "link", "roving card list", "shortcuts", "return to board library"],
            "workspace_controls": settings.workspace, "native_arabic_ime_clipboard": native_text, "atspi": a11y}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--scale", type=float, default=1)
    parser.add_argument("--atspi", action="store_true")
    parser.add_argument("--native-text", action="store_true")
    parser.add_argument("--dark", action="store_true")
    parser.add_argument("--workspace", action="store_true", help="Check the redesigned zoom controls and panel focus.")
    settings = parser.parse_args()
    with isolated_library() as root, webdriver() as (launch, parent):
        if settings.dark:
            gtk = root / "config" / "gtk-3.0"
            gtk.mkdir(parents=True)
            (gtk / "settings.ini").write_text("[Settings]\ngtk-application-prefer-dark-theme=true\n")
        with launch(settings.binary, ("--fixture=tiny",)) as web:
            pid, _ = wait_until(lambda: process_birth(parent, settings.binary), "owned desktop")
            result = exercise(web, pid, settings)
    with settings.binary.open("rb") as file:
        result["binary_sha256"] = hashlib.file_digest(file, "sha256").hexdigest()
    settings.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
