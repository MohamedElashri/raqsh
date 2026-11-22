#!/usr/bin/env python3
"""Measure a release editor under the stress or MCP status stream fixture."""

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import runpy
import time

from webkit_driver import isolated_library, process_birth, wait_until, webdriver

directory = Path(__file__).parent
p1 = runpy.run_path(str(directory / "linux-p1-proof.py"))
p2 = runpy.run_path(str(directory / "linux-p2-bridge.py"))
timing = runpy.run_path(str(directory / "linux-input-timing.py"))
button, ready, revision = (p1[name] for name in ("button", "ready", "revision"))
sample, helper_inventory, add_pairing, client, call, executable, uuid = (
    p2[name] for name in ("sample", "helper_inventory", "add_pairing", "client", "call", "executable", "uuid")
)
retry_transport = p2["retry_transport"]
FIXTURE_SECONDS = 60
IDLE_SECONDS = 300
OPERATIONS_PER_SEC = 10


def memory(pid, helper=None):
    processes = sample(pid)
    helpers = helper_inventory(helper) if helper else []
    return {"desktop_pss_kib": sum(item["pss_kib"] for item in processes),
            "helper_pss_kib": sum(item["pss_kib"] for item in helpers),
            "desktop_processes": processes, "helpers": helpers}


def profile_canvas(launch, parent, desktop, fixture):
    with launch(desktop, (f"--fixture={fixture}",)) as web:
        ready(web)
        pid, _ = process_birth(parent, desktop)
        counts = web.evaluate("""
            return {cards: document.querySelectorAll("[data-card-id]").length,
                    initial_elements: Number(document.querySelector(".lean-editor").dataset.initialElements)};
        """)
        expected_cards, expected_elements = (500, 3500) if fixture == "stress" else (200, 800)
        assert counts == {"cards": expected_cards, "initial_elements": expected_elements}, counts
        time.sleep(5)
        before = memory(pid)
        motion = timing["track_movement"](web, "pan", 12)
        motion["mean_strokes_per_clear"] = motion["paths_stroked"] / motion["canvas_clears"]
        time.sleep(5)
        return {"fixture": fixture, "counts": counts, "before_pan": before, "after_pan": memory(pid), "pan": motion}


async def stream_round(web, session, scope, task, current, pid, helper, progress, idle_seconds):
    web.evaluate("window.streamCounts = {boardSignals: 0, deltaRequests: 0, canvasRepaints: 0};")
    result = {"before_stream": memory(pid, helper), "initial_revision": current,
              "target_updates_per_second": OPERATIONS_PER_SEC, "target_seconds": FIXTURE_SECONDS}
    started = time.monotonic()
    latencies = []
    within_window = 0
    retry_count = 0
    count = FIXTURE_SECONDS * OPERATIONS_PER_SEC
    for index in range(count):
        await asyncio.sleep(max(0, started + index / OPERATIONS_PER_SEC - time.monotonic()))
        launched = time.monotonic()
        reply, retries = await retry_transport(session, "board_set_task_status", {
            **scope, "taskId": task, "status": "todo" if index % 2 else "inProgress",
            "expectedRevision": current, "operationId": uuid(),
        })
        retry_count += retries
        assert reply["revision"] == current + 1
        current = reply["revision"]
        ended = time.monotonic()
        within_window += ended - started <= FIXTURE_SECONDS
        latencies.append((ended - launched) * 1000)
    elapsed = time.monotonic() - started
    revision(web, current)
    counts = web.evaluate("return window.streamCounts;")
    assert counts["boardSignals"] == count, counts
    assert counts["canvasRepaints"] == 0, counts
    result.update(acknowledged_operations=count, elapsed_seconds=elapsed, within_window=within_window,
                  transport_retries=retry_count, tool_response=timing["percentiles"](latencies), final_revision=current,
                  projection=counts, immediately_after=memory(pid, helper))
    progress(result)
    await asyncio.sleep(idle_seconds)
    result.update(after_idle=memory(pid, helper), idle_seconds=idle_seconds)
    assert web.evaluate('return document.querySelector("[data-card-id]")?.dataset.status;') == "todo"
    return result


async def stream(launch, parent, desktop, helper, rounds, write, idle_seconds):
    with launch(desktop, ("--fixture=normal",)) as web:
        ready(web)
        button(web, "Agents")
        binding = add_pairing(web, "Stream client")
        button(web, "Close")
        pid, _ = process_birth(parent, desktop)
        async with client(helper, False, binding) as session:
            scope = {"boardId": (await call(session, "board_list"))["items"][0]["id"]}
            opened = await call(session, "board_get", scope)
            task = opened["page"]["items"][0]["id"]
            current = opened["board"]["semanticRevision"]
            web.evaluate("""
                const done = arguments[arguments.length - 1];
                window.streamCounts = {boardSignals: 0, deltaRequests: 0, canvasRepaints: 0};
                window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
                    event: "board-remote-revision", target: {kind: "Any"},
                    handler: window.__TAURI_INTERNALS__.transformCallback(() => window.streamCounts.boardSignals++)
                }).then(done);
                const original = window.fetch;
                window.fetch = function(url) {
                    if (String(url).endsWith("/board_deltas")) window.streamCounts.deltaRequests++;
                    return original.apply(this, arguments);
                };
                const canvas = document.querySelector("[data-board-surface]").getContext("2d");
                const originalClear = canvas.clearRect;
                canvas.clearRect = function(...bounds) {
                    window.streamCounts.canvasRepaints++;
                    return originalClear.apply(this, bounds);
                };
            """, asynchronous=True)
            await asyncio.sleep(5)
            results = []
            for _ in range(rounds):
                def progress(result):
                    write(result if rounds == 1 else {"rounds": [*results, result]})
                result = await stream_round(web, session, scope, task, current, pid, helper, progress, idle_seconds)
                current = result["final_revision"]
                progress(result)
                results.append(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop", type=Path)
    parser.add_argument("--helper", type=Path, help="Run the stream fixture with this stdio helper, instead of the stress fixture.")
    parser.add_argument("--rounds", type=int, choices=(1, 2), default=1, help="Repeat the stream in the same editor.")
    parser.add_argument("--idle-seconds", type=int, default=IDLE_SECONDS, help="Settle period after the stream.")
    parser.add_argument("--fixture", choices=("stress", "normal"), default="stress", help="Scene for the canvas profile.")
    parser.add_argument("--output", type=Path, required=True)
    settings = parser.parse_args()
    if settings.idle_seconds < 0:
        parser.error("The settle period must be nonnegative.")
    result = {"recorded_at_utc": datetime.now(timezone.utc).isoformat(), "desktop": executable(settings.desktop)}

    def write(metrics):
        result["measurement"] = metrics
        settings.output.write_text(json.dumps(result, indent=2) + "\n")

    with isolated_library(), webdriver() as (launch, parent):
        if settings.helper:
            result["helper"] = executable(settings.helper)
            asyncio.run(stream(launch, parent, settings.desktop, settings.helper, settings.rounds, write, settings.idle_seconds))
        else:
            write(profile_canvas(launch, parent, settings.desktop, settings.fixture))
    print(f"Evidence in {settings.output}")


if __name__ == "__main__":
    main()
