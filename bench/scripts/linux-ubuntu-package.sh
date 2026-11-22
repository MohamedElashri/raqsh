#!/usr/bin/env bash
set -euo pipefail

previous=$(realpath "${1:?Supply the predecessor DEB}")
current=$(realpath "${2:?Supply the release DEB}")
image=${3:-raqsh-ubuntu-package-check:24.04}
checks=$(cd -- "$(dirname -- "$0")" && pwd)
driver=$(command -v tauri-driver)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
dpkg-deb -R "$previous" "$scratch/predecessor"
version=$(dpkg-deb -f "$current" Version)
previous_version=$(dpkg-deb -f "$previous" Version)
if ! dpkg --compare-versions "$previous_version" lt "$version"; then
  previous_version=0.0.99
  dpkg --compare-versions "$previous_version" lt "$version"
  sed -i "s/^Version:.*/Version: $previous_version/" "$scratch/predecessor/DEBIAN/control"
  echo "Fixture uses synthetic predecessor metadata version $previous_version."
fi
dpkg-deb --build "$scratch/predecessor" "$scratch/previous.deb" >/dev/null
cp "$current" "$scratch/current.deb"

docker run --rm -i --network none \
  --env "EXPECTED_DISPLAY_NAME=${RAQSH_TEST_DISPLAY_NAME:-}" \
  --mount "type=bind,src=$scratch,dst=/packages,readonly" \
  --mount "type=bind,src=$checks,dst=/checks,readonly" \
  --mount "type=bind,src=$driver,dst=/usr/local/bin/tauri-driver,readonly" \
  "$image" bash -se <<'UBUNTU'
set -euo pipefail
dpkg -i /packages/previous.deb
install -d -m 0700 -o desktop-test -g desktop-test /tmp/lifecycle
x11() {
  runuser -u desktop-test -- env GDK_BACKEND=x11 GTK_IM_MODULE=gtk-im-context-simple \
    LIBGL_ALWAYS_SOFTWARE=1 dbus-run-session -- xvfb-run -a -s '-screen 0 1160x840x24' "$@"
}
x11 python3 /checks/linux-package-state.py seed /tmp/lifecycle
config_hash=$(sha256sum /tmp/lifecycle/agent.json)
dpkg -i /packages/current.deb
test "$(dpkg-query -W -f='${Version}' visual-board)" = "$(dpkg-deb -f /packages/current.deb Version)"
dpkg-query -W visual-board libgtk-3-0t64 libwebkit2gtk-4.1-0
desktop-file-validate /usr/share/applications/visual-board.desktop
if test -n "$EXPECTED_DISPLAY_NAME"; then
  grep -Fx "Name=$EXPECTED_DISPLAY_NAME" /usr/share/applications/visual-board.desktop
fi
sha256sum /usr/bin/visual-board /usr/bin/visual-board-mcp
x11 python3 /checks/linux-package-state.py import /tmp/lifecycle --display-name "$EXPECTED_DISPLAY_NAME"
x11 python3 /checks/linux-p4-ui.py /usr/bin/visual-board --workspace --native-text --output /tmp/x11.json

runuser -u desktop-test -- env LIBGL_ALWAYS_SOFTWARE=1 dbus-run-session -- bash -ec '
  export XDG_RUNTIME_DIR=$(mktemp -d)
  export GDK_BACKEND=wayland WAYLAND_DISPLAY=wayland-raqsh
  mutter --headless --wayland --no-x11 --wayland-display "$WAYLAND_DISPLAY" --virtual-monitor 1160x840 > /tmp/mutter.log 2>&1 &
  compositor=$!
  trap "kill $compositor" EXIT
  for i in $(seq 1 60); do
    test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" && break
    sleep .2
  done
  test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" || { cat /tmp/mutter.log; exit 1; }
  mutter --version
  python3 /checks/linux-p4-ui.py /usr/bin/visual-board --workspace --output /tmp/wayland.json
'

dpkg -i /packages/previous.deb
x11 python3 /checks/linux-package-state.py verify /tmp/lifecycle
dpkg -P visual-board
test ! -e /usr/bin/visual-board && test ! -e /usr/bin/visual-board-mcp
test -f /tmp/lifecycle/data/dev.local.visualboard/library/boards.sqlite3
test "$config_hash" = "$(sha256sum /tmp/lifecycle/agent.json)"
dpkg -i /packages/current.deb
x11 python3 /checks/linux-package-state.py verify /tmp/lifecycle --display-name "$EXPECTED_DISPLAY_NAME"
echo 'Ubuntu lifecycle passed: offline install, upgrade, export import, rollback, purge, reinstall.'
UBUNTU
