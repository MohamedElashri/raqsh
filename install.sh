#!/bin/sh
set -eu

release=https://github.com/MohamedElashri/raqsh/releases/latest/download

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}

[ "$#" -le 1 ] || fail "Usage: sh install.sh [--user | --system]"
case "${1:---user}" in
    --user) mode=user ;;
    --system) mode=system ;;
    -h|--help)
        printf '%s\n' 'Usage: sh install.sh [--user | --system]' \
            'The default installs for the current user. On Linux, --system installs with APT or DNF.'
        exit 0
        ;;
    *) fail "Usage: sh install.sh [--user | --system]" ;;
esac

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

install_linux_user() (
    bundle=$1
    [ -x "$bundle/bin/raqsh" ] && [ -x "$bundle/bin/raqsh-mcp" ] || fail "Extract the complete Raqsh archive first."
    if ! libraries=$(ldd "$bundle/bin/raqsh" 2>&1) || printf '%s\n' "$libraries" | grep -q 'not found'; then
        printf '%s\n' "$libraries" >&2
        fail "Raqsh requires the system GTK 3 and WebKitGTK 4.1 libraries. Ask your administrator to install any missing libraries."
    fi

    opt="$HOME/.local/opt"
    app="$opt/raqsh"
    bin="$HOME/.local/bin"
    data=${XDG_DATA_HOME:-"$HOME/.local/share"}
    case "$data" in /*) ;; *) data="$HOME/.local/share" ;; esac
    applications="$data/applications"
    launcher="$applications/raqsh-user.desktop"
    command="$bin/raqsh"
    target="$app/bin/raqsh"

    mkdir -p "$opt" "$bin" "$applications"
    # A stable path keeps existing MCP registrations valid after an upgrade.
    exec 9>>"$opt/.raqsh-install.lock"
    flock -n 9 || fail "Another Raqsh user installation is running."
    if [ -L "$app" ] || { [ -e "$app" ] && [ ! -f "$app/.raqsh-user-install" ]; }; then
        fail "An unmanaged path already exists at $app."
    fi
    if [ -L "$command" ]; then
        [ "$(readlink "$command")" = "$target" ] || fail "An unrelated command already exists at $command."
    elif [ -e "$command" ]; then
        fail "An unrelated command already exists at $command."
    fi
    if [ -L "$launcher" ] || { [ -e "$launcher" ] && ! grep -Fxq 'X-Raqsh-UserInstall=true' "$launcher"; }; then
        fail "An unmanaged launcher already exists at $launcher."
    fi

    set -- "$bundle/share/applications/"*.desktop
    [ "$#" -eq 1 ] && [ -f "$1" ] || fail "The Raqsh desktop entry is missing."
    desktop_entry=$1
    icon_relative=share/icons/hicolor/128x128/apps/raqsh.png
    [ -f "$bundle/$icon_relative" ] || fail "The Raqsh desktop icon is missing."

    stage=$(mktemp -d "$opt/.raqsh-install.XXXXXXXX")
    launcher_stage=
    added_command=false
    replaced_app=false
    installed=false
    # Invoked by this subshell's EXIT trap.
    # shellcheck disable=SC2329
    cleanup_user_install() {
        if [ "$installed" = false ]; then
            if [ "$added_command" = true ]; then rm -f "$command"; fi
            if [ "$replaced_app" = true ]; then rm -rf "$app"; fi
            if [ -d "$stage/previous" ] && ! mv -- "$stage/previous" "$app"; then
                printf 'Previous installation kept at %s/previous\n' "$stage" >&2
                return 1
            fi
        fi
        if [ -n "$launcher_stage" ]; then rm -f "$launcher_stage"; fi
        rm -rf "$stage"
    }
    trap cleanup_user_install EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP

    mkdir "$stage/next"
    cp -R "$bundle/bin" "$bundle/lib" "$bundle/share" "$stage/next/"
    touch "$stage/next/.raqsh-user-install"
    launcher_stage=$(mktemp "$applications/.raqsh-launcher.XXXXXXXX")
    # Exec quoting has two layers in desktop entries. Use an absolute executable
    # because the desktop session may not have ~/.local/bin on PATH.
    RAQSH_DESKTOP_PATH="$target" RAQSH_DESKTOP_ICON="$app/$icon_relative" awk '
        function escape(value, exec, result, i, char) {
            for (i = 1; i <= length(value); i++) {
                char = substr(value, i, 1)
                if (char == "\\") result = result (exec ? "\\\\\\\\" : "\\\\")
                else if (char == "\n" || char == "\r" || (exec && char == "=")) exit 1
                else if (char == "\t") result = result "\\t"
                else if (exec && char == "%") result = result "%%"
                else if (exec && char ~ /["$`]/) result = result "\\\\" char
                else result = result char
            }
            return result
        }
        /^Exec=/ { print "Exec=\"" escape(ENVIRON["RAQSH_DESKTOP_PATH"], 1) "\""; next }
        /^Icon=/ { print "Icon=" escape(ENVIRON["RAQSH_DESKTOP_ICON"], 0); next }
        { print }
        END { print "X-Raqsh-UserInstall=true" }
    ' "$desktop_entry" > "$launcher_stage" || fail "The installation path cannot be used in a desktop launcher."
    chmod 644 "$launcher_stage"

    if [ -e "$app" ]; then mv -- "$app" "$stage/previous"; fi
    mv -- "$stage/next" "$app"
    replaced_app=true
    if [ ! -L "$command" ]; then
        ln -s -- "$target" "$command"
        added_command=true
    fi
    mv -f -- "$launcher_stage" "$launcher"
    installed=true
    printf 'Raqsh installed in %s. Open Raqsh from your app menu or run %s.\n' "$app" "$command"
)

case "$(uname -s):$(uname -m)" in
    Darwin:arm64|Darwin:x86_64)
        [ "$mode" = user ] || fail "macOS installs to ~/Applications. Use --user."
        asset=raqsh-macos-universal.zip
        ;;
    Linux:x86_64|Linux:amd64)
        if [ "$mode" = user ]; then
            if [ -f "$0" ]; then
                bundle=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
                if [ -f "$bundle/.raqsh-archive" ]; then
                    install_linux_user "$bundle"
                    exit 0
                fi
            fi
            asset=raqsh-linux-x86_64.tar.gz
        elif command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
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
# Earlier releases have native packages only. Extract one for the user
# instead of invoking a system package manager.
if [ "$asset" = raqsh-linux-x86_64.tar.gz ] &&
   ! awk -v wanted="$asset" '$2 == wanted { found = 1 } END { exit !found }' "$temp_dir/SHA256SUMS"; then
    if command -v dpkg-deb >/dev/null 2>&1; then
        asset=raqsh-linux-x86_64.deb
    elif command -v rpm2archive >/dev/null 2>&1 || command -v bsdtar >/dev/null 2>&1; then
        asset=raqsh-linux-x86_64.rpm
    else
        fail "This release needs dpkg-deb, rpm2archive, or bsdtar for a user install."
    fi
fi
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
    *.tar.gz)
        tar -xzf "$package" -C "$temp_dir"
        install_linux_user "$temp_dir/raqsh"
        ;;
    *.deb|*.rpm)
        if [ "$mode" = system ]; then
            case "$asset" in
                *.deb) as_root apt-get install -y "$package" ;;
                *.rpm) as_root dnf install -y "$package" ;;
            esac
        else
            unpacked="$temp_dir/unpacked"
            mkdir "$unpacked"
            case "$asset" in
                *.deb) dpkg-deb -x "$package" "$unpacked" ;;
                *.rpm)
                    if command -v rpm2archive >/dev/null 2>&1; then
                        rpm2archive --nocompression - < "$package" > "$temp_dir/package.tar"
                        tar -xf "$temp_dir/package.tar" -C "$unpacked"
                    else
                        bsdtar -xf "$package" -C "$unpacked"
                    fi
                    ;;
            esac
            install_linux_user "$unpacked/usr"
        fi
        ;;
    *.zip)
        app_dir="$HOME/Applications"
        mkdir -p "$app_dir"
        app_path="$app_dir/Raqsh.app"
        [ ! -L "$app_path" ] || fail "The installation path is a symbolic link: $app_path"
        app_stage=$(mktemp -d "$app_dir/.raqsh-install.XXXXXXXX")
        ditto -x -k "$package" "$app_stage"
        app="$app_stage/Raqsh.app"
        codesign --verify --deep --strict "$app"
        if [ -e "$app_path" ]; then
            [ -d "$app_path" ] || fail "The installation path is not an app: $app_path"
            mv "$app_path" "$app_stage/previous.app"
        fi
        mv "$app" "$app_path"
        printf 'Raqsh installed in %s.\n' "$app_path"
        ;;
esac
