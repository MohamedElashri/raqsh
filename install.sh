#!/bin/sh
set -eu

release=https://github.com/MohamedElashri/raqsh/releases/latest/download

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl --proto '=https' --proto-redir '=https' -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget --https-only -q "$1" -O "$2"
    else
        fail "Install curl or wget, then try again."
    fi
}

as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        command -v sudo >/dev/null 2>&1 || fail "Installing the Linux package requires sudo."
        sudo "$@"
    fi
}

case "$(uname -s):$(uname -m)" in
    Darwin:arm64|Darwin:x86_64)
        asset=raqsh-macos-universal.zip
        ;;
    Linux:x86_64|Linux:amd64)
        if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
            asset=raqsh-linux-x86_64.deb
        elif command -v dnf >/dev/null 2>&1 && command -v rpm >/dev/null 2>&1; then
            asset=raqsh-linux-x86_64.rpm
        else
            fail "Raqsh requires an APT or DNF distribution on Linux."
        fi
        ;;
    *)
        fail "This platform has no Raqsh release package."
        ;;
esac

temp_dir=$(mktemp -d)
app_stage=
app_path=
cleanup() {
    if [ -n "$app_stage" ]; then
        if [ -d "$app_stage/previous.app" ] && [ ! -e "$app_path" ]; then
            mv "$app_stage/previous.app" "$app_path" || {
                printf 'Previous app kept at %s/previous.app\n' "$app_stage" >&2
                rm -rf "$temp_dir"
                return 1
            }
        fi
        rm -rf "$app_stage"
    fi
    rm -rf "$temp_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

fetch "$release/SHA256SUMS" "$temp_dir/SHA256SUMS" || fail "Could not download the Raqsh release checksums."
expected=$(awk -v asset="$asset" '$2 == asset && length($1) == 64 && $1 !~ /[^0-9a-f]/ { print $1 }' "$temp_dir/SHA256SUMS")
[ "${#expected}" -eq 64 ] || fail "No valid checksum for $asset."
package="$temp_dir/$asset"
fetch "$release/$asset" "$package" || fail "Could not download $asset."
case "$asset" in
    *.zip) actual=$(shasum -a 256 "$package") ;;
    *) actual=$(sha256sum "$package") ;;
esac
[ "${actual%% *}" = "$expected" ] || fail "Checksum verification failed for $asset."

case "$asset" in
    *.deb) as_root apt-get install -y "$package" ;;
    *.rpm) as_root dnf install -y "$package" ;;
    *.zip)
        app_dir="$HOME/Applications"
        mkdir -p "$app_dir"
        app_path="$app_dir/visual-board.app"
        [ ! -L "$app_path" ] || fail "The installation path is a symbolic link: $app_path"
        app_stage=$(mktemp -d "$app_dir/.raqsh-install.XXXXXXXX")
        ditto -x -k "$package" "$app_stage"
        app="$app_stage/visual-board.app"
        codesign --verify --deep --strict "$app"
        if [ -e "$app_path" ]; then
            [ -d "$app_path" ] || fail "The installation path is not an app: $app_path"
            mv "$app_path" "$app_stage/previous.app"
        fi
        mv "$app" "$app_path"
        printf 'Raqsh installed in %s.\n' "$app_path"
        ;;
esac
