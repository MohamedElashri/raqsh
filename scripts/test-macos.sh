#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $(uname -s) != Darwin ]]; then
  echo 'The live suite requires a logged-in macOS desktop session.' >&2
  exit 1
fi

pnpm brand:generate
pnpm --filter visual-board-desktop frontend:build
triple=$(rustc --print host-tuple)
directory=$(cargo metadata --no-deps --locked --format-version=1 |
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).target_directory)')
# An explicit target keeps the live-test executables out of the normal bundle inputs.
cargo build --release --locked --target "$triple" -p visual-board -p visual-board-mcp \
  --features visual-board/custom-protocol,visual-board/macos-live-test
python3 bench/scripts/macos-live.py "$directory/$triple/release/visual-board" \
  "$directory/$triple/release/visual-board-mcp" "$@"
if (( $# == 0 )); then
  python3 bench/scripts/macos-updater.py "$directory/$triple/release/visual-board" \
    "$directory/$triple/release/visual-board-mcp"
fi
