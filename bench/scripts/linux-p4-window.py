#!/usr/bin/env python3
"""Measure a native Wayland window's minimized idle and scoped process recovery."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import signal
import time
import zlib

from webkit_driver import isolated_library, process_birth, wait_until, webdriver

directory = Path(__file__).parent
proof = runpy.run_path(str(directory / "linux-p1-proof.py"))
memory = runpy.run_path(str(directory / "linux-process-family.py"))
button, add, ready, revision, pointer, at = (
    proof[name] for name in ("button", "add", "ready", "revision", "pointer", "at")
)


def window_action(pid, name):
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    Atspi.init()
    desktop = Atspi.get_desktop(0)

    def control():
        roots = (desktop.get_child_at_index(i) for i in range(desktop.get_child_count()))
        pending = [root for root in roots if root.get_process_id() == pid]
        while pending:
            item = pending.pop()
            if item.get_name() == name and item.get_n_actions():
                return item
            pending.extend(item.get_child_at_index(i) for i in range(item.get_child_count()))

    item = wait_until(control, f"native window action {name}")
    assert item.do_action(0), name


def snapshot(web):
    content = web.evaluate('return document.querySelector("[data-board-surface]").toDataURL();')
    return f"{zlib.crc32(content.encode()):08x}"


def window_cycle(web, pid, idle_seconds):
    result = {"visibility_before": web.evaluate("return document.visibilityState;")}
    frame = web.call("GET", "/window/rect")
    before_canvas = snapshot(web)
    web.evaluate("""
        window.visibilityChanges = [];
        document.addEventListener("visibilitychange", () => window.visibilityChanges.push(document.visibilityState));
    """)
    try:
        result["webdriver_minimize"] = web.call("POST", "/window/minimize", {})
    except RuntimeError as failure:
        result["webdriver_minimize_error"] = str(failure)
    if web.evaluate("return !document.hidden;"):
        window_action(pid, "Minimize")
    time.sleep(1)
    result["visibility_when_minimized"] = web.evaluate("return document.visibilityState;")
    started = time.monotonic()
    before = memory["sample"](pid)
    time.sleep(idle_seconds)
    end = memory["sample"](pid)
    elapsed = time.monotonic() - started
    assert [(p["pid"], p["start_ticks"]) for p in before] == [(p["pid"], p["start_ticks"]) for p in end]
    diff = sum(p["cpu_ticks"] for p in end) - sum(p["cpu_ticks"] for p in before)
    result["idle_seconds"] = elapsed
    result["idle_cpu_percent_one_core"] = 100 * diff / os.sysconf("SC_CLK_TCK") / elapsed
    result["minimized_desktop_pss_kib"] = sum(p["pss_kib"] for p in end)
    try:
        result["webdriver_restore_maximized"] = web.call("POST", "/window/maximize", {})
    except RuntimeError as failure:
        result["webdriver_restore_error"] = str(failure)
    time.sleep(1)
    result["visibility_after"] = web.evaluate("return document.visibilityState;")
    result["visibility_change_events"] = web.evaluate("return window.visibilityChanges;")
    if result["visibility_when_minimized"] == "hidden" and result["visibility_after"] == "visible":
        web.call("POST", "/window/rect", {name: frame[name] for name in ("width", "height")})
        wait_until(lambda: snapshot(web) == before_canvas, "same canvas content after restore and resize")
        result["same_canvas_at_original_size"] = True
    return result


def process_cycle(web, pid):
    current = web.evaluate('return Number(document.querySelector(".lean-editor").dataset.semanticRevision);')
    add(web, "Retained through process pause")
    revision(web, current + 1)
    pointer(web, at(web, 610, 230), {"type": "pointerDown", "button": 0}, at(web, 635, 243),
            {"type": "pointerUp", "button": 0})
    family = memory["process_family"](pid)
    started = time.monotonic()
    paused = []
    try:
        for process in family:
            os.kill(process["pid"], signal.SIGSTOP)
            paused.append(process["pid"])
        time.sleep(3)
    finally:
        for process in reversed(paused):
            os.kill(process, signal.SIGCONT)
    duration = time.monotonic() - started
    saved = wait_until(lambda: web.evaluate("""
        const text = document.querySelector("[data-drawing-save]")?.textContent;
        return text?.includes("Drawing saved") && text;
    """), "drawing checkpoint after process pause")
    revision(web, current + 1)
    return {"elapsed_seconds": duration, "processes_paused": [p["name"] for p in family],
            "semantic_revision": current + 1, "checkpoint_after_continue": saved,
            "canvas_after_continue_crc32": snapshot(web)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--idle-seconds", type=int, default=60)
    parser.add_argument("--output", type=Path, required=True)
    settings = parser.parse_args()
    with isolated_library(), webdriver() as (launch, parent):
        with launch(settings.binary, ("--fixture=ordinary",)) as web:
            ready(web)
            pid, _ = process_birth(parent, settings.binary)
            web.click('[data-tool="pen"]')
            result = {"process_recovery": process_cycle(web, pid), "window": window_cycle(web, pid, settings.idle_seconds)}
    with settings.binary.open("rb") as file:
        result["binary_sha256"] = hashlib.file_digest(file, "sha256").hexdigest()
    settings.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
