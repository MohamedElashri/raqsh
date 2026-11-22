#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
target=
profile=release
bundle=("$@")
while (( $# )); do
  case "$1" in
    --target|-t)
      target="${2:?Supply a Rust target triple}"
      shift
      ;;
    --target=*) target="${1#*=}" ;;
    --debug|-d) profile=debug ;;
  esac
  shift
done

directory=$(cargo metadata --no-deps --locked --format-version=1 |
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).target_directory)')
triple=${target:-$(rustc --print host-tuple)}
generated=apps/desktop/src-tauri/generated
mkdir -p "$generated"

helper=(build --locked -p visual-board-mcp)
if [[ "$profile" == release ]]; then helper+=(--release); fi
if [[ "$target" == universal-apple-darwin ]]; then
  arm=aarch64-apple-darwin
  intel=x86_64-apple-darwin
  cargo "${helper[@]}" --target "$arm"
  cargo "${helper[@]}" --target "$intel"
  lipo -create "$directory/$arm/$profile/visual-board-mcp" \
    "$directory/$intel/$profile/visual-board-mcp" -output "$generated/visual-board-mcp-$triple"
else
  if [[ -n "$target" ]]; then
    helper+=(--target "$target")
    directory="$directory/$target"
  fi
  cargo "${helper[@]}"
  cp "$directory/$profile/visual-board-mcp" "$generated/visual-board-mcp-$triple"
fi

pnpm --filter visual-board-desktop exec tauri bundle --config \
  '{"bundle":{"externalBin":["generated/visual-board-mcp"]}}' "${bundle[@]}"
