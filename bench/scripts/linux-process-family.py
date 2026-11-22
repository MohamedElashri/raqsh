#!/usr/bin/env python3
"""Measure a production Linux desktop build and its descendant processes."""

import argparse
from contextlib import nullcontext
import gzip
import hashlib
import json
import os
import platform
import statistics
import subprocess
import tempfile
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from webkit_driver import isolated_library


def read_process(pid):
    stat = (Path("/proc") / str(pid) / "stat").read_text()
    name, fields = stat[stat.index("(") + 1 :].rsplit(") ", 1)
    parts = fields.split()
    return {
        "pid": pid,
        "name": name,
        "state": parts[0],
        "parent": int(parts[1]),
        "cpu_ticks": int(parts[11]) + int(parts[12]),
        "start_ticks": int(parts[19]),
    }


def process_family(root_pid):
    processes = {}
    children = defaultdict(list)
    for path in Path("/proc").iterdir():
        if not path.name.isdecimal():
            continue
        try:
            process = read_process(int(path.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        processes[process["pid"]] = process
        children[process["parent"]].append(process["pid"])

    family = []
    pending = [root_pid]
    while pending:
        pid = pending.pop()
        process = processes.get(pid)
        if process is not None and process["state"] != "Z":
            family.append(process)
            pending.extend(children[pid])
    return sorted(family, key=lambda process: process["pid"])


def sample(root_pid):
    family = process_family(root_pid)
    if not any(p["name"].startswith("WebKitWebProces") for p in family):
        raise RuntimeError("No owned WebKit web process was found.")

    for process in family:
        rollup = Path("/proc") / str(process["pid"]) / "smaps_rollup"
        metrics = {}
        for line in rollup.read_text().splitlines():
            key, _, value = line.partition(":")
            if key in {"Pss", "Rss", "Pss_Anon", "Pss_File", "Pss_Shmem"}:
                metrics[key] = int(value.split()[0])
        process["pss_kib"] = metrics["Pss"]
        process["rss_kib"] = metrics["Rss"]
        process["pss_details_kib"] = {key: value for key, value in metrics.items() if key.startswith("Pss_")}
    return family


def gpu_clients(pid):
    clients = {}
    for descriptor in (Path("/proc") / str(pid) / "fdinfo").glob("*"):
        try:
            fields = dict(line.split(":", 1) for line in descriptor.read_text().splitlines() if line.startswith("drm-") and ":" in line)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        client = fields.get("drm-client-id")
        if client:
            clients[client.strip()] = {key: value.strip() for key, value in fields.items() if key.startswith(("drm-memory", "drm-resident", "drm-shared", "drm-driver"))}
    return clients


def measure(binary, app_args, settle, idle_seconds):
    with tempfile.TemporaryFile(mode="w+t") as log:
        with subprocess.Popen([binary, *app_args], stdout=log, stderr=log) as app:
            try:
                time.sleep(settle)
                start = time.monotonic()
                samples = [sample(app.pid)]
                for offset in range(5, idle_seconds, 5):
                    time.sleep(max(0, start + offset - time.monotonic()))
                    samples.append(sample(app.pid))
                time.sleep(max(0, start + idle_seconds - time.monotonic()))
                samples.append(sample(app.pid))
                elapsed = time.monotonic() - start
                for process in samples[-1]:
                    process["drm_clients"] = gpu_clients(process["pid"])
            except (OSError, RuntimeError) as error:
                log.seek(0)
                raise RuntimeError(f"Incomplete process sample: {error}\n{log.read()}") from error
            finally:
                app.terminate()
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    app.kill()
                    app.wait()

    inventories = [{(p["pid"], p["start_ticks"]) for p in family} for family in samples]
    if any(inventory != inventories[0] for inventory in inventories[1:]):
        raise RuntimeError("Process inventory changed during the idle window. Retry after quiescence.")

    totals = [sum(p["pss_kib"] for p in family) for family in samples]
    ticks = sum(p["cpu_ticks"] for p in samples[-1]) - sum(p["cpu_ticks"] for p in samples[0])
    for first, last in zip(samples[0], samples[-1]):
        last["idle_cpu_ticks"] = last["cpu_ticks"] - first["cpu_ticks"]
    return {
        "settle_seconds": settle,
        "idle_seconds": elapsed,
        "idle_cpu_percent_of_one_core": 100 * ticks / os.sysconf("SC_CLK_TCK") / elapsed,
        "median_pss_kib": statistics.median(totals),
        "max_observed_idle_pss_kib": max(totals),
        "inventory": samples[-1],
        "pss_samples_kib": totals,
    }


def frontend_sizes(dist):
    sizes = defaultdict(lambda: {"bytes": 0, "gzip_bytes": 0})
    for path in sorted(dist.rglob("*")):
        if path.is_file():
            content = path.read_bytes()
            counts = sizes[path.suffix or "(other)"]
            counts["bytes"] += len(content)
            counts["gzip_bytes"] += len(gzip.compress(content, compresslevel=9, mtime=0))
    return dict(sizes)


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def command_output(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dist", type=Path, default=Path("apps/desktop/dist"))
    parser.add_argument("--app-arg", action="append", default=[])
    parser.add_argument("--persisted", action="store_true", help="Use a temporary board library for the Phase 1 build")
    parser.add_argument("--settle", type=int, default=15)
    parser.add_argument("--idle-seconds", type=int, default=60)
    parser.add_argument("--display", required=True, help="Renderer, display scale and refresh notes")
    settings = parser.parse_args()
    if settings.settle < 0 or settings.idle_seconds <= 0 or not settings.dist.is_dir():
        parser.error("Require an existing asset directory, nonnegative settle time and positive idle time.")

    binary = settings.binary.resolve(strict=True)
    with (isolated_library() if settings.persisted else nullcontext()):
        measurement = measure(binary, settings.app_arg, settings.settle, settings.idle_seconds)
    result = {
        "label": settings.label,
        "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
        "app_args": settings.app_arg,
        "platform": {
            "system": platform.freedesktop_os_release()["PRETTY_NAME"],
            "kernel": platform.release(),
            "architecture": platform.machine(),
            "cpu": next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")), platform.processor()),
            "memory": Path("/proc/meminfo").read_text().splitlines()[0].split(":", 1)[1].strip(),
            "desktop": os.getenv("XDG_CURRENT_DESKTOP"),
            "session": os.getenv("XDG_SESSION_TYPE"),
            "gdk_backend_override": os.getenv("GDK_BACKEND"),
            "display": settings.display,
            "webkitgtk": command_output("/usr/bin/pkg-config", "--modversion", "webkit2gtk-4.1"),
            "gtk": command_output("/usr/bin/pkg-config", "--modversion", "gtk+-3.0"),
        },
        "toolchains": {tool: command_output(tool, "--version") for tool in ("rustc", "node", "pnpm")},
        "lockfiles_sha256": {path: sha256(Path(path)) for path in ("Cargo.lock", "pnpm-lock.yaml")},
        "executable": {"bytes": binary.stat().st_size, "sha256": sha256(binary)},
        "frontend": frontend_sizes(settings.dist),
        "persisted_fixture": settings.persisted,
        "measurement": measurement,
        "measurement_notes": "Linux descendant PSS and CPU ticks. Per-process DRM client counters are reported separately when the kernel exposes them. Compositor memory is outside the app process family.",
    }
    settings.output.parent.mkdir(parents=True, exist_ok=True)
    settings.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"{settings.label}: {result['measurement']['median_pss_kib'] / 1024:.1f} MiB PSS; evidence in {settings.output}")


if __name__ == "__main__":
    main()
