#!/usr/bin/env python3
"""Measure release-board readiness, frame cadence and native input-to-canvas time."""

import argparse
from contextlib import nullcontext
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time

from webkit_driver import close_board, isolated_library, process_birth, wait_until, webdriver

PAINT_CANVAS = ".board-editor canvas:not(.interactive), .board-editor canvas[data-board-surface]"

def percentiles(values):
    ordered = sorted(values)
    return {f"p{p}_ms": round(ordered[math.ceil(len(ordered) * p / 100) - 1], 2) for p in (50, 95, 99)}


def accept_board(session):
    wait_until(lambda: session.evaluate('return document.querySelector(".board-editor")?.dataset.editorReady === "true";'), "board readiness")
    before = session.evaluate('return document.querySelector(arguments[0]).toDataURL();', PAINT_CANVAS)
    session.click(".zoom-in-button")
    wait_until(lambda: session.evaluate('return document.querySelector(arguments[0]).toDataURL() !== arguments[1];', PAINT_CANVAS, before), "rendered zoom")


def move(x, y, duration):
    return {"type": "pointerMove", "x": x, "y": y, "origin": "viewport", "duration": duration}


def track_movement(session, kind, seconds):
    top = session.evaluate('return Math.round(document.querySelector(".board-editor canvas.interactive").getBoundingClientRect().top);')
    x, y = (110, top + 148) if kind == "drag" else (655, top + 204)
    steps = math.ceil(seconds * 10)
    pointers = [move(x, y, 0), {"type": "pointerDown", "button": 0}]
    pointers += [move(x + round(49 * math.sin(index / 6)), y + round(17 * math.sin(index / 9)), 105) for index in range(1, steps + 1)]
    pointers.append({"type": "pointerUp", "button": 0})
    actions = [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": pointers}]
    lean = session.evaluate('return document.querySelector(".board-editor").dataset.renderer === "lean";')
    if kind == "pan" and lean:
        session.click('[data-tool="pan"]')
    if kind == "pan" and not lean:
        actions.append({"type": "key", "id": "keyboard", "actions": [
            {"type": "keyDown", "value": " "},
            *[{"type": "pause", "duration": 0}] * (len(pointers) - 2),
            {"type": "keyUp", "value": " "},
        ]})
    session.evaluate((Path(__file__).parent / "trace-canvas.js").read_text())
    try:
        session.call("POST", "/actions", {"actions": actions})
        session.call("DELETE", "/actions")
    finally:
        result = session.evaluate("return window.finishCanvasTrace();")
    assert result["elapsed_ms"] >= seconds * 1000, result["elapsed_ms"]
    assert result["paint_responses_ms"] and result["frame_intervals_ms"], f"{kind}: {result['pointer_moves']} moves and {len(result['paint_responses_ms'])} captured draws"
    result["frame_intervals"] = percentiles(result["frame_intervals_ms"])
    result["input_to_canvas"] = percentiles(result["paint_responses_ms"])
    return result


def open_normal(session):
    wait_until(lambda: session.evaluate('return !!document.querySelector("#board-size");'), "launcher selector")
    session.click('#board-size option[value="normal"]')
    session.click(".board-picker button")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--persisted", action="store_true", help="Measure the Phase 1 persisted board")
    parser.add_argument("--trials", type=int, default=30)
    parser.add_argument("--seconds", type=int, default=12)
    parser.add_argument("--output", type=Path, required=True)
    settings = parser.parse_args()
    cold, warm, processes = [], [], []
    opener = ".board-link" if settings.persisted else ".board-picker button"
    with (isolated_library() if settings.persisted else nullcontext()), webdriver() as (new_session, parent):
        for _ in range(settings.trials):
            with new_session(settings.binary, ("--fixture=normal",)) as session:
                pid, birth = wait_until(lambda: process_birth(parent, settings.binary), "owned desktop process")
                processes.append([pid, birth])
                accept_board(session)
                cold.append((time.clock_gettime(time.CLOCK_BOOTTIME) - birth) * 1000)
                close_board(session)
                wait_until(lambda: session.evaluate("return !!document.querySelector(arguments[0]);", opener), "board library")
                started = time.perf_counter()
                session.click(opener)
                accept_board(session)
                warm.append((time.perf_counter() - started) * 1000)
        motion = {}
        if settings.persisted:
            for kind in ("drag", "pan"):
                with new_session(settings.binary, ("--fixture=normal",)) as session:
                    wait_until(lambda: session.evaluate('return document.querySelector(".board-editor")?.dataset.editorReady === "true";'), "persisted normal fixture")
                    motion[kind] = track_movement(session, kind, settings.seconds)
                    close_board(session)
                    wait_until(lambda: session.evaluate('return !document.querySelector(".board-editor");'), "editor close")
        else:
            with new_session(settings.binary) as session:
                for kind in ("drag", "pan"):
                    open_normal(session)
                    wait_until(lambda: session.evaluate('return document.querySelector(".board-editor")?.dataset.editorReady === "true";'), "fresh normal fixture")
                    motion[kind] = track_movement(session, kind, settings.seconds)
                    close_board(session)

    assert len(set(map(tuple, processes))) == settings.trials, processes
    with settings.binary.open("rb") as executable:
        digest = hashlib.file_digest(executable, "sha256").hexdigest()
    result = {
        "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
        "binary_sha256": digest,
        "startup_method": "Fresh process birth from Linux /proc clock ticks or warm open click initiation through WebDriver-observed canvas change after an accepted zoom. Includes driver transport and observation overhead.",
        "motion_method": "Trusted WebKit WebDriver mouse events at the normal fixture. Frame cadence is requestAnimationFrame. Input-to-canvas is the event to a completed draw on the visible canvas, sampled by the next animation frame. Compositor and display scanout are outside this measurement.",
        "cold": {**percentiles(cold), "samples_ms": cold, "processes": processes},
        "warm": {**percentiles(warm), "samples_ms": warm},
        "motion": motion,
    }
    settings.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"cold_p95": result["cold"]["p95_ms"], "warm_p95": result["warm"]["p95_ms"], "motion": {k: (v["frame_intervals"], v["input_to_canvas"]) for k, v in motion.items()}}, indent=2))


if __name__ == "__main__":
    main()
