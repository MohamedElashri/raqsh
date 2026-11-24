#!/usr/bin/env python3
"""Verify agent brief scope, copying, and keyboard behavior in native WebKit."""

import argparse
from pathlib import Path
import shutil
import subprocess

from webkit_driver import close_board, isolated_library, open_disclosure, wait_until, webdriver


BRIEF = ".agent-brief-dialog[open]"


def shown(web, selector):
    return web.evaluate("return !!document.querySelector(arguments[0]);", selector)


def button(web, container, label):
    selector = f"{container}//button[normalize-space()='{label}']"
    match = web.call("POST", "/element", {"using": "xpath", "value": selector})
    element = match["element-6066-11e4-a52e-4f735466cecf"]
    web.call("POST", f"/element/{element}/click", {})


def key(web, value):
    web.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": [
        {"type": "keyDown", "value": value}, {"type": "keyUp", "value": value},
    ]}]})


def run(binary, native_clipboard):
    with isolated_library(), webdriver() as (session, _), session(binary, ["--fixture=empty"]) as web:
        try:
            wait_until(lambda: shown(web, ".lean-editor[data-editor-ready]"), "empty board", timeout=30)
        except RuntimeError as error:
            state = web.evaluate("return document.body.innerText;")
            raise RuntimeError(f"{error} Webview: {state[:500]}") from error
        open_disclosure(web, ".board-header")
        assert web.evaluate("""
            return [...document.querySelectorAll('.board-header button')]
                .some(button => button.textContent === 'Copy agent brief' && button.disabled);
        """)
        close_board(web)
        wait_until(lambda: shown(web, ".task-board-action:not(:disabled)"), "project library")
        web.click(".task-board-action")
        web.evaluate("""
            const field = document.querySelector('.task-board-dialog textarea[name=brief]');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, arguments[0]);
            field.dispatchEvent(new Event('input', {bubbles: true}));
        """, "# Verify a saved board\n\nCover Linux and macOS.")
        web.click(".task-board-dialog button[type=submit]")
        wait_until(lambda: shown(web, ".lean-editor[data-editor-ready]"), "feature board")
        x, y = web.evaluate("""
            const card = [...document.querySelectorAll('.lean-card')].find(el => el.textContent === 'Check acceptance');
            const rect = card.getBoundingClientRect();
            return [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
        """)
        web.call("POST", "/actions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
            "actions": [{"type": "pointerMove", "x": x, "y": y, "origin": "viewport", "duration": 30},
                        {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]})
        wait_until(lambda: shown(web, '.lean-card[data-selected="true"]'), "selected canvas card")

        open_disclosure(web, ".board-header")
        wait_until(lambda: web.evaluate("""
            return [...document.querySelectorAll('.board-header button')]
                .some(button => button.textContent === 'Copy agent brief' && !button.disabled);
        """), "available copy action")
        button(web, '//details[contains(@class, "board-header")]', "Copy agent brief")
        wait_until(lambda: shown(web, BRIEF), "brief preview")
        assert web.evaluate("return document.activeElement.matches('.agent-brief-preview textarea');")
        markdown = web.evaluate("return document.querySelector('.agent-brief-preview textarea').value;")
        assert "### Check acceptance" in markdown
        assert "Requires: Build the change (To do)" in markdown
        assert "Exercise the user flow" in markdown
        assert "### Build the change" not in markdown
        assert "Cover Linux and macOS." not in markdown

        web.click(f"{BRIEF} input")
        markdown = web.evaluate("return document.querySelector('.agent-brief-preview textarea').value;")
        assert "## Task brief\n\n> # Verify a saved board\n>\n> Cover Linux and macOS." in markdown
        if not native_clipboard:
            web.evaluate("""
                Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
                    writeText(text) { window.verifiedBriefClipboard = text; return Promise.resolve(); }
                }});
            """)
        web.click(f"{BRIEF} button.primary")
        wait_until(lambda: web.evaluate("return document.querySelector('.agent-brief-status').textContent === 'Copied agent brief.';"),
                   "successful copy status")
        if not native_clipboard:
            assert web.evaluate("return window.verifiedBriefClipboard;") == markdown
        elif shutil.which("xclip"):
            clipboard = subprocess.check_output(["xclip", "-selection", "clipboard", "-o"], text=True, timeout=5)
            assert clipboard == markdown

        web.evaluate("""
            Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
                writeText() { return Promise.reject(new Error('Test clipboard denied')); }
            }});
        """)
        web.click(f"{BRIEF} button.primary")
        wait_until(lambda: web.evaluate("return document.querySelector('.agent-brief-status').textContent.includes('preview is selected');"),
                   "copy fallback")
        assert web.evaluate("""
            const field = document.activeElement;
            return field.matches('.agent-brief-preview textarea') && field.selectionStart === 0
                && field.selectionEnd === field.value.length;
        """)

        web.call("POST", "/window/rect", {"width": 480, "height": 360})
        wait_until(lambda: web.evaluate("return innerWidth === 480 && innerHeight === 360;"), "compact viewport")
        assert web.evaluate("""
            const dialog = document.querySelector('.agent-brief-dialog');
            return dialog.scrollWidth === dialog.clientWidth && dialog.getBoundingClientRect().right <= innerWidth;
        """)
        key(web, "\ue00c")  # Escape
        wait_until(lambda: web.evaluate("return document.activeElement.matches('.board-header > summary');"), "board menu focus")
        assert not shown(web, BRIEF)
        assert shown(web, '.lean-card[data-selected="true"]')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--native-clipboard", action="store_true", help="Write test Markdown to the active desktop clipboard")
    args = parser.parse_args()
    run(args.binary, args.native_clipboard)
    print("PASS agent brief selection, prerequisite, context, copy, fallback, and keyboard flow")
