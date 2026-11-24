#!/usr/bin/env python3
"""Verify the tour and local preferences in the native Linux webview."""

import argparse
import base64
import json
from pathlib import Path
import sqlite3

from webkit_driver import close_board, isolated_library, open_disclosure, wait_until, webdriver


SETTINGS = "dialog.preferences-dialog[open]"
TOUR = "dialog.onboarding-dialog[open]"


def shown(web, selector):
    return web.evaluate("return !!document.querySelector(arguments[0]);", selector)


def press(web, key):
    web.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": [
        {"type": "keyDown", "value": key}, {"type": "keyUp", "value": key},
    ]}]})


def dialog_button(web, dialog, name):
    selector = web.evaluate("""
        const dialog = document.querySelector(arguments[0]);
        if (!dialog) return null;
        const buttons = Array.from(dialog.querySelectorAll('button'));
        const button = buttons.find(item => item.textContent.trim() === arguments[1]);
        if (!button) return null;
        return button;
    """, dialog, name)
    if not selector:
        raise AssertionError(f"No {name!r} button in {dialog!r}")
    element = selector["element-6066-11e4-a52e-4f735466cecf"]
    web.call("POST", f"/element/{element}/click", {})


def choose(web, field, value):
    web.evaluate("""
        const input = document.getElementById(arguments[0]);
        input.value = arguments[1];
        input.dispatchEvent(new Event('change', { bubbles: true }));
    """, field, value)


def launcher_settings(web):
    wait_until(lambda: shown(web, ".settings-link:not([disabled])"), "launcher ready")
    web.click(".settings-link")
    wait_until(lambda: shown(web, f"{SETTINGS} #interface-font:not([disabled])"), "preferences ready")


def saved(path, **expected):
    if not path.is_file():
        return False
    settings = json.loads(path.read_text())
    return all(settings.get(key) == value for key, value in expected.items())


def capture(web, directory, name):
    if directory:
        screenshot = web.call("GET", "/screenshot")
        (directory / f"{name}.png").write_bytes(base64.b64decode(screenshot))


def resize(web, width, height):
    web.call("POST", "/window/rect", {"width": width, "height": height})
    wait_until(lambda: web.evaluate("return [innerWidth, innerHeight];") == [width, height], "window resize")


def run(binary, directory):
    with isolated_library() as root, webdriver() as (session, _):
        path = root / "data/dev.local.raqsh/library/preferences.json"
        with session(binary) as web:
            wait_until(lambda: shown(web, TOUR), "first-run tour")
            assert web.evaluate('return document.activeElement.textContent;') == "Start with a project"
            assert not path.exists()
            capture(web, directory, "raqsh-first-run")
            dialog_button(web, TOUR, "Next")
            assert web.evaluate('return document.activeElement.textContent;') == "Build a plan with cards"
            press(web, "n")
            assert shown(web, f"{TOUR} .onboarding-card:nth-child(3)")
            press(web, "c")
            assert web.evaluate('return document.activeElement.querySelector("strong")?.textContent;') == "Build package"
            press(web, "\ue007")
            assert web.evaluate('return document.activeElement.querySelector("strong")?.textContent;') == "Verify download"
            press(web, "\ue007")
            assert shown(web, f'{TOUR} [data-linked="true"]')
            capture(web, directory, "raqsh-tour-plan")
            dialog_button(web, TOUR, "Next")
            assert web.evaluate('return document.activeElement.textContent;') == "Review progress on the board"
            choose(web, "onboarding-status", "inProgress")
            assert shown(web, f'{TOUR} .onboarding-card [data-status="inProgress"]')
            dialog_button(web, TOUR, "Next")
            choose(web, "onboarding-client", "Other MCP client")
            assert web.evaluate('return document.querySelector(".onboarding-activity [role=status]").textContent;').startswith("Use MCP configuration")
            dialog_button(web, TOUR, "Next")
            dialog_button(web, TOUR, "Queue sample feedback")
            assert web.evaluate('return document.querySelector(".onboarding-activity [role=status]").textContent;').startswith("Queued")
            dialog_button(web, TOUR, "Show sample acknowledgement")
            assert web.evaluate('return document.activeElement.textContent;').startswith("Acknowledged")
            assert web.evaluate("""
                const stage = document.querySelector('.onboarding-stage');
                const gap = stage.getBoundingClientRect().bottom - stage.lastElementChild.getBoundingClientRect().bottom;
                return gap >= 0 && gap <= 32;
            """)
            capture(web, directory, "raqsh-tour-feedback")
            resize(web, 480, 360)
            assert web.evaluate("""
                const dialog = document.querySelector(arguments[0]);
                const footer = dialog.querySelector('footer').getBoundingClientRect();
                const body = dialog.querySelector('.onboarding-stage');
                return body.scrollWidth <= body.clientWidth && footer.bottom < innerHeight;
            """, TOUR)
            capture(web, directory, "raqsh-tour-compact")
            dialog_button(web, TOUR, "Back")
            assert web.evaluate('return document.activeElement.textContent;') == "Pair a coding agent"
            dialog_button(web, TOUR, "Next")
            assert web.evaluate('return document.querySelector(".onboarding-activity [role=status]").textContent;').startswith("Acknowledged")
            assert not path.exists()
            with sqlite3.connect(path.with_name("boards.sqlite3")) as database:
                assert database.execute("select count(*) from projects").fetchone() == (0,)
            dialog_button(web, TOUR, "Get started")
            assert web.evaluate('return document.activeElement.textContent.trim();') == "Open project folder…"
            assert web.evaluate("""
                const panel = document.querySelector('.project-start');
                return panel.querySelector('h2').textContent === 'Open a project' &&
                    panel.querySelector('.primary') === document.activeElement &&
                    panel.getBoundingClientRect().bottom <= innerHeight &&
                    document.documentElement.scrollWidth <= innerWidth;
            """)
            capture(web, directory, "raqsh-project-start-compact")
            wait_until(lambda: saved(path, onboardingVersion=2), "tour completion saved")

            resize(web, 1024, 720)
            capture(web, directory, "raqsh-project-start")
            launcher_settings(web)
            assert web.evaluate("""
                const dark = matchMedia('(prefers-color-scheme: dark)').matches;
                return document.documentElement.dataset.theme === (dark ? 'dark' : 'light');
            """)
            capture(web, directory, "raqsh-settings-light")
            web.click(f'{SETTINGS} [value="dark"]')
            choose(web, "interface-font", "nunito")
            choose(web, "interface-size", "extraLarge")
            wait_until(lambda: saved(path, appearance="dark", interfaceFont="nunito", textSize="extraLarge"),
                       "appearance ready before clicking resized controls")
            web.click("#shortcut-hints")
            wait_until(lambda: saved(path, appearance="dark", interfaceFont="nunito", textSize="extraLarge",
                                     showShortcutHints=False, onboardingVersion=2), "all settings saved")
            assert web.evaluate("""
                const style = getComputedStyle(document.documentElement);
                return [style.colorScheme, style.fontFamily, style.fontSize];
            """) == ["dark", "Nunito, system-ui, sans-serif", "18px"]
            capture(web, directory, "raqsh-settings-dark")
            resize(web, 480, 360)
            assert web.evaluate("""
                const dialog = document.querySelector(arguments[0]);
                return dialog.scrollWidth <= dialog.clientWidth && dialog.scrollHeight > dialog.clientHeight;
            """, SETTINGS)
            capture(web, directory, "raqsh-settings-compact")
            dialog_button(web, SETTINGS, "Quick tour")
            dialog_button(web, TOUR, "Close tour")
            assert shown(web, SETTINGS)
            resize(web, 1024, 720)
            dialog_button(web, SETTINGS, "About")
            assert shown(web, "dialog.about-settings[open] .about-brand")
            assert web.evaluate("""
                const agreement = document.querySelector('.about-license-summary a[href="https://melashri.net/raqsh/eula/"]');
                return agreement?.textContent === 'End User Licence Agreement';
            """)
            web.click('dialog.about-settings[open] [aria-label="Back to Settings"]')
            assert shown(web, SETTINGS)
            press(web, "\ue00c")
            assert not shown(web, "dialog[open]")
            assert web.evaluate('return document.activeElement.matches(".settings-link");')
            capture(web, directory, "raqsh-project-start-dark")

        with session(binary, ["--fixture=empty"]) as web:
            wait_until(lambda: shown(web, ".lean-editor[data-editor-ready]"), "board ready")
            assert not shown(web, TOUR)
            wait_until(lambda: shown(web, ".excalidraw.theme--dark"), "saved dark theme on the canvas")
            assert web.evaluate('return getComputedStyle(document.querySelector(".tool-key")).display;') == "none"
            assert web.evaluate('return getComputedStyle(document.querySelector(".lean-editor")).fontFamily;').startswith("Nunito")
            open_disclosure(web, ".board-header")
            dialog_button(web, ".board-menu", "Settings")
            web.click(f'{SETTINGS} [value="light"]')
            wait_until(lambda: saved(path, appearance="light"), "board settings saved")
            assert not shown(web, ".excalidraw.theme--dark")
            dialog_button(web, SETTINGS, "Done")
            assert web.evaluate('return document.activeElement.matches(".board-header > summary");')
            press(web, "\ue031")
            assert shown(web, 'dialog[open][aria-label="Board shortcuts"]')
            press(web, "\ue00c")
            close_board(web)
            wait_until(lambda: shown(web, ".board-row"), "board still in project library")

        path.write_text('{"appearance":"future-theme","textSize":"large","interfaceFont":"assistant","onboardingSeen":true}')
        with session(binary) as web:
            wait_until(lambda: shown(web, TOUR), "updated tour with an existing project and older tour flag")
            assert shown(web, ".library-list .project-link")
            dialog_button(web, TOUR, "Skip tour")
            wait_until(lambda: saved(path, onboardingVersion=2), "dismissal of the updated tour saved")
            launcher_settings(web)
            assert not shown(web, TOUR)
            assert web.evaluate("""
                return [document.querySelector('input[name=appearance]:checked').value,
                        document.querySelector('#interface-font').value,
                        document.querySelector('#interface-size').value,
                        document.querySelector('#shortcut-hints').checked];
            """) == ["system", "assistant", "large", True]
            path.unlink()
            path.mkdir()
            web.click(f'{SETTINGS} [value="dark"]')
            wait_until(lambda: shown(web, f'{SETTINGS} [role="alert"]'), "preference write failure")
            assert web.evaluate('return document.querySelector("input[name=appearance]:checked").value;') == "system"
            assert not list(path.parent.glob(".raqsh-*.tmp"))
            path.rmdir()
            web.click(f'{SETTINGS} [value="light"]')
            wait_until(lambda: saved(path, appearance="light", interfaceFont="assistant", textSize="large"),
                       "preferences saved after retry")

        with session(binary) as web:
            wait_until(lambda: shown(web, '.library-list .project-link:not([disabled])'), "existing project ready")
            assert web.evaluate("""
                const done = arguments[arguments.length - 1];
                requestAnimationFrame(() => requestAnimationFrame(() =>
                    done(document.documentElement.dataset.interfaceFont === 'assistant' &&
                        !document.querySelector('.onboarding-dialog[open]'))));
            """, asynchronous=True)
            assert web.evaluate("return document.querySelector('.project-start h2').textContent;") == "Choose a project"
            web.click(".library-list .project-link")
            wait_until(lambda: shown(web, ".board-row"), "saved project boards")
            assert web.evaluate('return document.activeElement.matches("[aria-label=Boards] h2");')
            assert not shown(web, ".library-start-copy")
            web.click(".board-row button:last-child")
            dialog_button(web, 'dialog[aria-label="Delete board"]', "Delete board")
            wait_until(lambda: shown(web, ".library-start-copy h3"), "empty project guidance")
            assert web.evaluate("""
                const actions = document.querySelector('.library-actions');
                return [actions.querySelector('h3').textContent,
                        ...Array.from(actions.querySelectorAll('button'), button => button.textContent.trim())];
            """) == ["Create your first board", "Create board", "New from task…", "Templates…", "Import board…"]
            capture(web, directory, "raqsh-first-board")
            resize(web, 480, 360)
            assert web.evaluate('return document.documentElement.scrollWidth <= innerWidth;')
        print("PASS guided exercises, project and board start screens, tour completion and upgrade, focus, persistence, canvas appearance, and write recovery")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    run(args.binary, args.screenshots)
