#!/usr/bin/env python3
"""Measure closed-board process memory and collectability of editor nodes."""

import argparse
from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import runpy
import time

from webkit_driver import close_board, isolated_library, process_birth, wait_until, webdriver


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--persisted", action="store_true", help="Measure the Phase 1 persisted board")
    parser.add_argument("--cycles", type=int, default=50)
    settings = parser.parse_args()
    sample = runpy.run_path(str(Path(__file__).with_name("linux-process-family.py")))["sample"]
    checkpoints = []
    opener = ".board-link" if settings.persisted else ".board-picker button"
    args = ("--fixture=normal",) if settings.persisted else ("--phase-zero-probe",)
    with (isolated_library() if settings.persisted else nullcontext()), webdriver() as (launch, parent):
        with launch(settings.binary, args) as session:
            pid, _ = wait_until(lambda: process_birth(parent, settings.binary), "owned desktop")
            if not settings.persisted:
                wait_until(lambda: session.evaluate('return !!document.querySelector("#board-size");'), "launcher")
                session.click('#board-size option[value="normal"]')
            session.evaluate("window.retiredEditors = [];")
            engine_gc = session.evaluate('return typeof $vm !== "undefined" && typeof $vm.gc === "function";')
            heap_script = '''
                if (typeof $vm === "undefined" || typeof $vm.heapSize !== "function") return null;
                const size = $vm.heapSize();
                return Number.isFinite(size) ? size : null;
            '''
            for index in range(1, settings.cycles + 1):
                if index != 1 or not settings.persisted:
                    session.click(opener)
                wait_until(lambda: session.evaluate('return document.querySelector(".board-editor")?.dataset.editorReady;'), "editor mount")
                scene_count = session.evaluate('''
                    const editor = document.querySelector(".board-editor");
                    window.retiredEditors.push([new WeakRef(editor), new WeakRef(editor.querySelector("canvas"))]);
                    return Number(editor.dataset.initialElements);
                ''')
                assert scene_count == 800, scene_count
                if index == 1:
                    time.sleep(1)
                    first_callbacks = session.evaluate('return Number(document.querySelector(".board-editor").dataset.sceneCallbacks ?? 0);')
                    time.sleep(3)
                    after_callbacks = session.evaluate('return Number(document.querySelector(".board-editor").dataset.sceneCallbacks ?? 0);')
                    open_heap_bytes = session.evaluate(heap_script)
                close_board(session)
                wait_until(lambda: session.evaluate('return !document.querySelector(".board-editor") && !!document.querySelector(arguments[0]);', opener), "editor unmount")
                if index % 10 == 0 or index == settings.cycles:
                    if engine_gc:
                        session.evaluate("$vm.gc();")
                    time.sleep(2)
                    family = sample(pid)
                    surviving = session.evaluate('return window.retiredEditors.map(pair => pair.map(ref => !!ref.deref()));')
                    checkpoints.append({"closed_cycles": index, "process_pss_kib": sum(p["pss_kib"] for p in family),
                                        "jsc_heap_bytes": session.evaluate(heap_script),
                                        "reachable_editor_wrappers": sum(pair[0] for pair in surviving),
                                        "reachable_canvas_wrappers": sum(pair[1] for pair in surviving), "processes": family})
    with settings.binary.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    result = {"binary_sha256": digest, "cycles": settings.cycles, "explicit_jsc_gc": engine_gc,
              "open_normal_board_jsc_heap_bytes": open_heap_bytes,
              "idle_callbacks_first_normal_board_in_3_seconds": after_callbacks - first_callbacks,
              "checkpoints": checkpoints}
    settings.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"cycles": settings.cycles, "explicit_jsc_gc": engine_gc, "final_wrappers": [checkpoints[-1]["reachable_editor_wrappers"], checkpoints[-1]["reachable_canvas_wrappers"]], "idle_callbacks": after_callbacks - first_callbacks}))


if __name__ == "__main__":
    main()
