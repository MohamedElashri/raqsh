#!/usr/bin/env bash
set -euo pipefail

deb=${1:?Pass the x86-64 Raqsh Debian package}
archive=${2:?Pass the output .tar.gz path}
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

test "$(dpkg-deb -f "$deb" Package)" = raqsh
test "$(dpkg-deb -f "$deb" Architecture)" = amd64
dpkg-deb -x "$deb" "$scratch/package"
bundle="$scratch/raqsh"
mv "$scratch/package/usr" "$bundle"
test -x "$bundle/bin/raqsh"
test -x "$bundle/bin/raqsh-mcp"
install -m 755 "$repository/install.sh" "$bundle/install.sh"
touch "$bundle/.raqsh-archive"
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$archive" -C "$scratch" raqsh
