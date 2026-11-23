#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $(uname -s) != Darwin ]]; then
  echo 'The live suite requires a logged-in macOS desktop session.' >&2
  exit 1
fi

pnpm brand:generate
pnpm --filter raqsh-desktop frontend:build
triple=$(rustc --print host-tuple)
directory=$(cargo metadata --no-deps --locked --format-version=1 |
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).target_directory)')
# An explicit target keeps the live-test executables out of the normal bundle inputs.
cargo build --release --locked --target "$triple" -p raqsh -p raqsh-mcp \
  --features raqsh/custom-protocol,raqsh/macos-live-test
python3 bench/scripts/macos-live.py "$directory/$triple/release/raqsh" \
  "$directory/$triple/release/raqsh-mcp" "$@"
if (( $# == 0 )) && [[ $(<apps/desktop/src-tauri/generated/edition) == noncommercial ]]; then
  python3 bench/scripts/macos-updater.py "$directory/$triple/release/raqsh" \
    "$directory/$triple/release/raqsh-mcp"
fi
