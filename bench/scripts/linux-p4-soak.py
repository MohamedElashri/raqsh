#!/usr/bin/env python3
"""Soak a release desktop with drawing, board switches and one real stdio helper."""

import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import runpy
import tempfile
import time

from webkit_driver import isolated_library, process_birth, wait_until, webdriver

root_script = Path(__file__).parent
p1 = runpy.run_path(str(root_script / "linux-p1-proof.py"))
p2 = runpy.run_path(str(root_script / "linux-p2-bridge.py"))
button, text, pointer, at, close_editor = (
    p1[name] for name in ("button", "text", "pointer", "at", "close_editor")
)
sample, helper_inventory, add_pairing, client, call, executable, uuid = (
    p2[name] for name in ("sample", "helper_inventory", "add_pairing", "client", "call", "executable", "uuid")
)
retry_transport = p2["retry_transport"]
SECOND = "Soak companion board"


def record(output, metrics):
    pending = output.with_suffix(output.suffix + ".tmp")
    pending.write_text(json.dumps(metrics, indent=2) + "\n")
    pending.replace(output)


def ready(web):
    try:
        wait_until(lambda: web.evaluate('return !!document.querySelector(\'[data-editor-ready="true"]\');'),
                   "painted board fixture", timeout=60)
    except RuntimeError as failure:
        raise RuntimeError(web.evaluate("return document.body.innerText;")) from failure


def board(web, title):
    selector = ".board-link"
    identifier = wait_until(lambda: web.evaluate("""
        return Array.from(document.querySelectorAll(arguments[0]))
            .find(button => button.textContent === arguments[1] && !button.disabled)?.dataset.boardId;
    """, selector, title), f"openable board {title}")
    web.click(f'[data-board-id="{identifier}"]')
    ready(web)


def create_companion(web):
    close_editor(web)
    text(web, 'input[aria-label="New board title"]', SECOND)
    button(web, "Create board")
    ready(web)
    close_editor(web)
    board(web, "normal")


def drawing_status(web):
    return web.evaluate('return document.querySelector("[data-drawing-save]")?.textContent;')


def update_drawing(web, index):
    web.click('[data-tool="pen"]')
    previous = drawing_status(web)
    x = 470 + index % 12 * 8
    y = 240 + index % 7 * 7
    for press_attempt in range(3):
        pointer(web, at(web, x, y), {"type": "pointerDown", "button": 0}, at(web, x + 19, y + 6),
                {"type": "pointerUp", "button": 0})
        try:
            wait_until(lambda: drawing_status(web) != previous, "accepted pen stroke", timeout=3)
            break
        except RuntimeError:
            if press_attempt == 2:
                raise

    try:
        status = wait_until(lambda: web.evaluate("""
            const status = document.querySelector("[data-drawing-save]")?.textContent;
            return /Drawing (saved|save failed)/.test(status) && status;
        """), "drawing checkpoint response", timeout=45)
        if "Drawing saved" in status:
            return press_attempt, 0
        button(web, "Retry drawing save")
        wait_until(lambda: "Drawing saved" in drawing_status(web), "drawing checkpoint after retry", timeout=45)
        return press_attempt, 1
    except RuntimeError as failure:
        raise RuntimeError(f"Drawing checkpoint stalled. Status: {drawing_status(web)}") from failure


async def run(launch, parent, settings, output):
    with launch(settings.desktop, ("--fixture=normal",)) as web:
        ready(web)
        create_companion(web)
        button(web, "Agents")
        binding = add_pairing(web, "Soak client")
        button(web, "Close")
        pid, _ = wait_until(lambda: process_birth(parent, settings.desktop), "owned desktop")
        async with client(settings.helper, False, binding) as agent:
            listing = await call(agent, "board_list")
            scope = {"boardId": listing["items"][0]["id"]}
            initial = await call(agent, "board_get", scope)
            task = initial["page"]["items"][0]["id"]
            revision = initial["board"]["semanticRevision"]
            metrics = {"started_at_utc": datetime.now(timezone.utc).isoformat(), "duration_target_seconds": settings.duration,
                       "interval_seconds": settings.interval, "desktop": executable(settings.desktop),
                       "helper": executable(settings.helper), "gdk_backend": os.getenv("GDK_BACKEND"),
                       "temporary_library_parent": tempfile.gettempdir(),
                       "completed": False, "samples": []}
            record(output, metrics)
            web.evaluate("window.retiredEditors = [];")
            started = time.monotonic()
            index = 0
            reconnects = 0
            edits = 0
            retries = 0
            extra_pen_attempts = 0
            drawing_retries = 0
            while True:
                index += 1
                target = min(settings.duration, index * settings.interval)
                web.evaluate("""
                    const editor = document.querySelector(".board-editor");
                    window.retiredEditors.push([new WeakRef(editor), new WeakRef(editor.querySelector("canvas"))]);
                """)
                close_editor(web)
                current = SECOND if index % 2 else "normal"
                board(web, current)
                for _ in range(2):
                    state, retry_count = await retry_transport(agent, "board_session_state")
                    assert state["binding"]["id"] == binding
                    retries += retry_count
                    reconnects += 1
                if current == "normal":
                    state = "inProgress" if edits % 2 == 0 else "todo"
                    mutation, retry_count = await retry_transport(agent, "board_set_task_status", {
                        **scope, "taskId": task, "status": state, "operationId": uuid(), "expectedRevision": revision,
                    })
                    retries += retry_count
                    revision = mutation["revision"]
                    wait_until(lambda: web.evaluate("""
                        return Number(document.querySelector(".lean-editor")?.dataset.semanticRevision) === arguments[0];
                    """, revision), "agent status projected")
                    pen, save = update_drawing(web, edits)
                    extra_pen_attempts += pen
                    drawing_retries += save
                    edits += 1

                await asyncio.sleep(max(0, started + target - time.monotonic()))
                owned = sample(pid)
                helpers = helper_inventory(settings.helper)
                assert len(helpers) == 1
                reachable = web.evaluate("""
                    return [0, 1].map(index => window.retiredEditors.filter(pair => !!pair[index].deref()).length);
                """)
                elapsed = time.monotonic() - started
                total = sum(item["pss_kib"] for item in [*owned, *helpers])
                metrics["samples"].append({
                    "elapsed_seconds": round(elapsed, 2), "board": current, "aggregate_pss_kib": total,
                    "processes": owned, "helpers": helpers, "reachable_retired_editor_and_canvas_wrappers": reachable,
                })
                metrics.update(switches=index, reconnects=reconnects, semantic_edits=edits,
                               drawing_checkpoints=edits, transport_retries=retries,
                               extra_pen_attempts=extra_pen_attempts, drawing_retries=drawing_retries)
                if target == settings.duration:
                    metrics["completed"] = elapsed >= settings.duration
                record(output, metrics)
                if index == 1 or index % 5 == 0 or metrics["completed"]:
                    print(f"{elapsed / 60:.1f} min · {index} switches · {total / 1024:.1f} MiB PSS", flush=True)
                if metrics["completed"]:
                    return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop", type=Path)
    parser.add_argument("helper", type=Path)
    parser.add_argument("--duration", type=int, default=600)
    parser.add_argument("--interval", type=int, default=20)
    parser.add_argument("--output", type=Path, required=True)
    settings = parser.parse_args()
    if settings.duration < settings.interval or settings.interval < 3:
        parser.error("Duration must be at least one interval of three seconds or more.")
    with isolated_library(), webdriver() as (launch, parent):
        asyncio.run(run(launch, parent, settings, settings.output))


if __name__ == "__main__":
    main()
