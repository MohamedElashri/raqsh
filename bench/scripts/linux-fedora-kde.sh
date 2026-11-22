#!/usr/bin/env bash
set -euo pipefail

artifact=$(realpath "${1:?Supply a local RPM}")
mode=${2:-fixture}
if [[ "$mode" != fixture && "$mode" != workspace ]]; then
  echo "Expected fixture or workspace." >&2
  exit 2
fi
checks=$(cd -- "$(dirname -- "$0")" && pwd)
driver=$(command -v tauri-driver)

docker run --rm -i --network "${RAQSH_TEST_DOCKER_NETWORK:-bridge}" --env "BOARD_TEST_MODE=$mode" \
  --mount "type=bind,src=$artifact,dst=/tmp/visual-board.rpm,readonly" \
  --mount "type=bind,src=$checks,dst=/checks,readonly" \
  --mount "type=bind,src=$driver,dst=/usr/local/bin/tauri-driver,readonly" \
  fedora:43 bash -se <<'FEDORA'
dnf -y --setopt=install_weak_deps=False install /tmp/visual-board.rpm kwin webkitgtk6.0 python3 dbus-daemon mesa-dri-drivers shadow-utils libcap >/tmp/deps.log 2>&1 || { tail -n 40 /tmp/deps.log; exit 1; }
rpm -q visual-board kwin webkit2gtk4.1 webkitgtk6.0
# A private virtual compositor does not need the installed realtime-priority capability.
kwin=$(readlink -f "$(command -v kwin_wayland)")
if test -n "$(getcap "$kwin")"; then setcap -r "$kwin"; fi
useradd -m desktop-test
python3 - <<'RUN_AS_USER'
import os
import pwd

account = pwd.getpwnam("desktop-test")
os.setgroups([])
os.setgid(account.pw_gid)
os.setuid(account.pw_uid)
os.environ.update(HOME=account.pw_dir, USER=account.pw_name)
os.execvp("dbus-run-session", ["dbus-run-session", "--", "bash", "-ec", r'''
    export XDG_RUNTIME_DIR=$(mktemp -d)
    export GDK_BACKEND=wayland WAYLAND_DISPLAY=wayland-raqsh
    export LIBGL_ALWAYS_SOFTWARE=1 QT_QUICK_BACKEND=software
    QT_QPA_PLATFORM=offscreen kwin_wayland --virtual --socket wayland-raqsh > /tmp/raqsh-kwin.log 2>&1 &
    for attempt in $(seq 1 60); do
        test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" && break
        sleep .2
    done
    test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" || { cat /tmp/raqsh-kwin.log; exit 1; }
    QT_QPA_PLATFORM=offscreen kwin_wayland --version
    if test "$BOARD_TEST_MODE" = workspace; then
        python3 /checks/linux-p4-ui.py /usr/bin/visual-board --workspace --output /tmp/raqsh-kde-result.json
    else
        python3 /checks/linux-fixture-proof.py /usr/bin/visual-board --output /tmp/raqsh-kde-result.json
    fi
'''])
RUN_AS_USER
FEDORA
