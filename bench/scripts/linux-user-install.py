#!/usr/bin/env python3
"""Exercise the release installer with a real archive and isolated user paths."""

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ASSET = "raqsh-linux-x86_64.tar.gz"
DEB = "raqsh-linux-x86_64.deb"
INSTALLER = Path(__file__).resolve().parents[2] / "install.sh"


def write_command(directory, name, body):
    path = directory / name
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)
    return path


def install(env, *arguments, success=True):
    result = subprocess.run(["sh", str(INSTALLER), *arguments], env=env, text=True, capture_output=True)
    assert (result.returncode == 0) == success, result.stdout + result.stderr
    return result.stdout + result.stderr


def checksum(package):
    with package.open("rb") as stream:
        return f'{hashlib.file_digest(stream, "sha256").hexdigest()}  {package.name}\n'


def verify(archive, legacy_deb):
    with tempfile.TemporaryDirectory(prefix="raqsh-user-install-") as directory:
        root = Path(directory)
        home = root / 'User "home"'
        data = root / "User data"
        downloads = root / "downloads"
        commands = root / "commands"
        for path in (home, data, downloads, commands):
            path.mkdir()
        package = downloads / ASSET
        package.symlink_to(archive.resolve(strict=True))
        checksums = downloads / "SHA256SUMS"
        checksums.write_text(f'{"0" * 64}  {ASSET}\n')

        write_command(commands, "curl", '''
            for argument do
                case "$argument" in https://*) asset=${argument##*/} ;; esac
                destination=$argument
            done
            cp "$RAQSH_TEST_DOWNLOADS/$asset" "$destination"
        ''')
        write_command(commands, "sudo", '''
            touch "$RAQSH_TEST_DOWNLOADS/sudo-was-called"
            exit 1
        ''')
        env = dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(data),
                   PATH=f"{commands}:{os.environ['PATH']}", RAQSH_TEST_DOWNLOADS=str(downloads))

        assert "Checksum verification failed" in install(env, success=False)
        assert not (home / ".local").exists()
        if legacy_deb:
            old_package = downloads / DEB
            old_package.symlink_to(legacy_deb.resolve(strict=True))
            checksums.write_text(checksum(old_package))
            install(env)
            assert (home / ".local/opt/raqsh/bin/raqsh-mcp").is_file()
        checksums.write_text(checksum(package))
        install(env)

        app = home / ".local/opt/raqsh"
        command = home / ".local/bin/raqsh"
        launcher = data / "applications/raqsh-user.desktop"
        assert command.resolve(strict=True) == app / "bin/raqsh"
        assert next(app.glob("lib/*/licenses/Raqsh-LICENSE.txt")).is_file()
        assert "X-Raqsh-UserInstall=true" in launcher.read_text()
        subprocess.run([app / "bin/raqsh-mcp", "--help"], env=env, check=True, capture_output=True)
        if validator := shutil.which("desktop-file-validate"):
            subprocess.run([validator, launcher], check=True)

        library = data / "dev.local.raqsh/library"
        library.mkdir(parents=True)
        (library / "preferences.json").write_text('{"appearance":"dark"}')
        (app / "previous-install").touch()
        move = write_command(commands, "mv", '''
            for destination do :; done
            case "$destination" in */raqsh-user.desktop) exit 1 ;; esac
            exec /bin/mv "$@"
        ''')
        install(env, "--user", success=False)
        assert (app / "previous-install").is_file()
        assert command.resolve(strict=True) == app / "bin/raqsh"
        move.unlink()

        install(env, "--user")
        assert not (app / "previous-install").exists()
        assert command.resolve(strict=True) == app / "bin/raqsh"
        assert (library / "preferences.json").read_text() == '{"appearance":"dark"}'

        subprocess.run(["tar", "-xzf", archive, "-C", root], check=True)
        write_command(commands, "curl", "exit 1")
        subprocess.run(["sh", root / "raqsh/install.sh"], env=env, check=True, capture_output=True)
        assert command.resolve(strict=True) == app / "bin/raqsh"

        command.unlink()
        command.write_text("Unrelated user file")
        result = subprocess.run(["sh", root / "raqsh/install.sh"], env=env, text=True, capture_output=True)
        assert result.returncode and "An unrelated command already exists" in result.stderr
        assert command.read_text() == "Unrelated user file"
        assert not (downloads / "sudo-was-called").exists()
        assert not list(app.parent.glob(".raqsh-install.????????"))
    print("Linux user install passed without sudo, including checksum rejection, offline install, upgrade, and rollback.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--legacy-deb", type=Path)
    args = parser.parse_args()
    verify(args.archive, args.legacy_deb)
