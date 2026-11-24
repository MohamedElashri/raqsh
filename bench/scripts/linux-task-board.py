#!/usr/bin/env python3
"""Exercise task-board creation in the native Linux webview."""

import argparse
from base64 import b64decode
import json
from pathlib import Path
import sqlite3

from webkit_driver import close_board, isolated_library, wait_until, webdriver


DIALOG = ".task-board-dialog[open]"
ACTION = ".task-board-action"
SUBMIT = f"{DIALOG} button[type=submit]"
EDITOR = ".lean-editor[data-editor-ready]"
CASES = (
    ("bug", "Keep the color picker above Agents", "At 520 × 410 the hex field sent the click to Agents.",
     ("Reproduce at 520 × 410", "Fix popover stacking", "Check the hex field and Escape")),
    ("feature", "Verify board recovery after suspend", "Cover the Linux suspend and resume item in P4.05.",
     ("Capture a saved baseline", "Suspend and resume", "Reopen and compare")),
    ("refactor", "Share portable board serialization", "Keep benchmark and task-board files importable.",
     ("Capture baseline exports", "Share the document envelope", "Verify both import paths")),
)


def shown(web, selector):
    return web.evaluate("return !!document.querySelector(arguments[0]);", selector)


def key(web, value):
    web.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard", "actions": [
        {"type": "keyDown", "value": value}, {"type": "keyUp", "value": value},
    ]}]})


def text(web, selector, value):
    web.evaluate("""
        const el = document.querySelector(arguments[0]);
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, arguments[1]);
        el.dispatchEvent(new Event('input', {bubbles: true}));
    """, selector, value)


def value(web, selector):
    return web.evaluate("return document.querySelector(arguments[0]).value;", selector)


def capture(web, directory, name):
    if directory:
        (directory / f"{name}.png").write_bytes(b64decode(web.call("GET", "/screenshot")))


def board_records(db, title):
    board_id, semantic, drawing = db.execute(
        "SELECT id, semantic_revision, drawing_revision FROM boards WHERE title = ?", (title,)
    ).fetchone()
    cards = sorted((json.loads(body) for (body,) in db.execute(
        "SELECT body FROM nodes WHERE board_id = ?", (board_id,)
    )), key=lambda card: card["order"])
    links = [json.loads(body) for (body,) in db.execute("SELECT body FROM edges WHERE board_id = ?", (board_id,))]
    return cards, links, semantic, drawing


def checklist_workflow(web, database, screenshots):
    title = "Verify the Linux user archive"
    brief = f"""# {title}

Use a disposable profile for release checklist P5.10.
- [x] Extract the user archive
- [ ] Install without sudo
- [ ] Verify the MCP helper path
- [ ] Reopen a saved board
- [ ] Try an upgrade
- [ ] Verify uninstall preserves the library

Example to keep in the brief:
```markdown
- [ ] Placeholder checklist item
```
"""
    tasks = ["Extract the user archive", "Install as a regular user", "Verify the MCP helper path",
             "Reopen a saved board", "Try an upgrade", "Verify uninstall preserves the library"]
    brief_input = f"{DIALOG} textarea[name=brief]"
    checklist_option = f"{DIALOG} input[value=checklist]"
    web.call("POST", "/window/rect", {"width": 1024, "height": 720})
    wait_until(lambda: web.evaluate("return [innerWidth, innerHeight];") == [1024, 720], "full window")
    web.click(ACTION)
    assert not shown(web, checklist_option)
    text(web, brief_input, brief)
    assert value(web, f"{DIALOG} input[name=task-template]:checked") == "feature"
    web.click(checklist_option)
    row = f"{DIALOG} li:nth-child(2)"
    web.click(f"{row} summary")
    text(web, f"{row} input", tasks[1])
    text(web, f"{row} textarea", "Confirm the install works from a normal user account.")
    web.click(f"{DIALOG} input[value=bug]")
    web.click(checklist_option)
    text(web, brief_input, f"# {title}\n\nThe checklist was temporarily removed.")
    assert shown(web, f"{SUBMIT}:disabled")
    assert shown(web, f"{checklist_option}:checked")
    brief = brief.replace("- [ ] Install", "- [x] Install")
    text(web, brief_input, brief)
    assert web.evaluate("return [...document.querySelectorAll('.task-board-preview summary span')].map(el => el.textContent);") == tasks
    assert web.evaluate("return document.querySelectorAll('.task-board-preview summary small').length;") == 2
    capture(web, screenshots, "checklist-preview")
    web.click(SUBMIT)
    wait_until(lambda: shown(web, EDITOR), "created checklist board")
    capture(web, screenshots, "checklist-board")
    close_board(web)
    wait_until(lambda: shown(web, f"{ACTION}:not(:disabled)"), "board library after checklist creation")
    with sqlite3.connect(database) as db:
        cards, links, semantic, drawing = board_records(db, title)
        board_id = db.execute("SELECT id FROM boards WHERE title = ?", (title,)).fetchone()[0]
    assert (semantic, drawing) == (0, 0)
    assert cards[0]["description"] == brief
    assert [card["title"] for card in cards[1:]] == tasks
    assert [card["status"] for card in cards[1:]] == ["done", "done", "todo", "todo", "todo", "todo"]
    assert cards[2]["description"] == "Confirm the install works from a normal user account."
    assert not links
    assert cards[4]["x"] == cards[1]["x"] and cards[4]["y"] > cards[1]["y"]
    web.click(f'.board-link[data-board-id="{board_id}"]')
    wait_until(lambda: shown(web, EDITOR), "reopened checklist board")
    assert web.evaluate("return document.querySelectorAll('.lean-card[data-status=done]').length;") == 2


def run(binary, screenshots):
    with isolated_library() as root, webdriver() as (session, _), session(binary, ["--fixture=empty"]) as web:
        database = root / "data/dev.local.raqsh/library/boards.sqlite3"
        wait_until(lambda: shown(web, EDITOR), "fixture editor")
        close_board(web)
        wait_until(lambda: shown(web, f"{ACTION}:not(:disabled)"), "board library")
        web.click(ACTION)
        assert web.evaluate("return document.activeElement.name;") == "brief"
        key(web, "\ue004")  # Tab
        assert web.evaluate("return document.activeElement.name;") == "title"
        key(web, "\ue004")
        assert web.evaluate("return document.activeElement.name;") == "task-template"
        assert web.evaluate("return document.activeElement.getBoundingClientRect().width < 24;")
        key(web, "\ue012")  # Left arrow
        assert value(web, f"{DIALOG} input[name=task-template]:checked") == "bug"
        key(web, "\ue004")
        assert web.evaluate("return document.activeElement.tagName;") == "SUMMARY"
        key(web, "\ue007")  # Enter
        assert shown(web, f"{DIALOG} li:first-child details[open]")
        key(web, "\ue004")
        assert web.evaluate("return document.activeElement.name;") == "step-title"
        key(web, "\ue00c")  # Escape
        assert web.evaluate(f"return document.activeElement.matches('{ACTION}');")

        for kind, title, context, tasks in CASES:
            if kind == "refactor":
                web.click(".settings-link")
                web.click('dialog[open] input[value="dark"]')
                web.evaluate("""
                    const size = document.querySelector('#interface-size');
                    size.value = 'extraLarge';
                    size.dispatchEvent(new Event('change', { bubbles: true }));
                """)
                wait_until(lambda: web.evaluate("""
                    const root = document.documentElement;
                    return root.dataset.theme === 'dark' && getComputedStyle(root).fontSize === '18px';
                """), "dark theme and extra-large text")
                web.click("dialog[open] [data-initial-focus]")
            web.click(ACTION)
            brief = f"  ## {title} ##\n\n{context}\n\n    Preserve indentation.\n"
            if kind == "feature":
                brief = brief.ljust(4096, "ع")
                text(web, f"{DIALOG} textarea[name=brief]", brief + "ع")
                assert shown(web, f"{SUBMIT}:disabled")
                assert shown(web, f"{DIALOG} textarea[aria-invalid=true]")
            text(web, f"{DIALOG} textarea[name=brief]", brief)
            assert value(web, f"{DIALOG} input[name=title]") == title
            web.click(f"{DIALOG} input[value={kind}]")

            for index, task in enumerate(tasks, 1):
                row = f"{DIALOG} li:nth-child({index})"
                web.click(f"{row} summary")
                if index == 1:
                    text(web, f"{row} input", "  ")
                    web.click(f"{row} summary")
                    assert shown(web, f"{SUBMIT}:disabled")
                    web.click(f"{row} summary")
                text(web, f"{row} input", task)
                text(web, f"{row} textarea", f"{task}. {context}")
                if kind == "bug" and index == 1:
                    capture(web, screenshots, "edit-starter-task")
                web.click(f"{row} summary")

            other = "bug" if kind == "feature" else "feature"
            web.click(f"{DIALOG} input[value={other}]")
            web.click(f"{DIALOG} input[value={kind}]")
            assert web.evaluate("return [...document.querySelectorAll('.task-board-preview summary')].map(e => e.textContent);") == list(tasks)

            if kind == "refactor":
                web.call("POST", "/window/rect", {"width": 480, "height": 360})
                wait_until(lambda: web.evaluate("return [innerWidth, innerHeight];") == [480, 360], "small window")
                assert web.evaluate("""
                    const body = document.querySelector('.task-board-body');
                    const footer = document.querySelector('.task-board-footer').getBoundingClientRect();
                    return body.scrollWidth <= body.clientWidth && footer.bottom < innerHeight;
                """)
                capture(web, screenshots, "compact-task-dialog")
                project = root / "worktree"
                moved = root / "temporarily-moved"
                project.rename(moved)
                try:
                    web.click(SUBMIT)
                    wait_until(lambda: shown(web, f"{DIALOG} footer [role=alert]"), "visible retry error")
                    assert value(web, f"{DIALOG} textarea[name=brief]") == brief
                    with sqlite3.connect(database) as db:
                        assert db.execute("SELECT count(*) FROM boards WHERE title = ?", (title,)).fetchone() == (0,)
                finally:
                    moved.rename(project)

            web.click(SUBMIT)
            wait_until(lambda: shown(web, EDITOR), "created editor")
            if kind == "refactor":
                wait_until(lambda: web.evaluate("""
                    const cards = [...document.querySelectorAll('.lean-card')];
                    return cards.length === 4 && cards.every(card => {
                        const rect = card.getBoundingClientRect();
                        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
                    });
                """), "all four cards framed on the compact canvas")
                capture(web, screenshots, "compact-task-board")
            close_board(web)
            wait_until(lambda: web.evaluate("return document.activeElement.matches('.board-link') && document.activeElement.textContent.trim() === arguments[0];",
                                           title), "focus on the saved board")
            with sqlite3.connect(database) as db:
                cards, links, semantic, drawing = board_records(db, title)
            assert (semantic, drawing) == (0, 0)
            assert cards[0]["description"] == brief
            assert [card["title"] for card in cards[1:]] == list(tasks)
            assert [card["description"] for card in cards[1:]] == [f"{task}. {context}" for task in tasks]
            assert {(edge["from"], edge["to"], edge["kind"]) for edge in links} == {
                (cards[1]["id"], cards[2]["id"], "dependency"), (cards[2]["id"], cards[3]["id"], "dependency"),
            }

        board_id = web.evaluate("""
            return [...document.querySelectorAll('.board-link')]
                .find(button => button.textContent.trim() === arguments[0]).dataset.boardId;
        """, CASES[-1][1])
        web.click(f'.board-link[data-board-id="{board_id}"]')
        wait_until(lambda: shown(web, EDITOR), "reopened task board")
        assert web.evaluate("return document.querySelectorAll('.lean-card').length;") == 4
        close_board(web)
        wait_until(lambda: shown(web, f"{ACTION}:not(:disabled)"), "board library for checklist test")
        checklist_workflow(web, database, screenshots)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    run(args.binary, args.screenshots)
    print("PASS task-board keyboard flow, templates, checklist import, draft persistence, text limits, retry, and compact framing")
