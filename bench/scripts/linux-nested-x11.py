#!/usr/bin/env python3
"""Run a Linux acceptance command on an isolated, local Xephyr X11 display."""

import argparse
import os
from pathlib import Path
import select
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="Xephyr")
    parser.add_argument("--screen", default="1160x840")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    settings = parser.parse_args()
    if not settings.command:
        parser.error("Supply an acceptance command.")
    screen = ["0", f"{settings.screen}x24"] if Path(settings.server).name == "Xvfb" else [settings.screen]
    display = subprocess.Popen([settings.server, "-displayfd", "1", "-screen", *screen, "-nolisten", "tcp", "-ac"], stdout=subprocess.PIPE, text=True)
    try:
        ready, _, _ = select.select([display.stdout], [], [], 10)
        number = display.stdout.readline().strip() if ready else ""
        if not number.isdecimal():
            raise RuntimeError("Xephyr did not provide an X11 display number.")
        env = {**os.environ, "DISPLAY": f":{number}", "GDK_BACKEND": "x11", "GTK_IM_MODULE": "gtk-im-context-simple"}
        subprocess.run(settings.command, env=env, check=True)
    finally:
        display.terminate()
        display.wait(timeout=10)


if __name__ == "__main__":
    main()
