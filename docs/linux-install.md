# Install Raqsh on Linux without sudo

Raqsh’s user archive is for x86-64 Linux. The machine needs the system GTK 3 and WebKitGTK 4.1 runtime libraries already installed. Raqsh’s board data stays in your normal app data directory across install methods.

## Install for your user

Save the installer and run it from the download directory as your regular user. It picks the user archive when the release includes one. For older releases, it extracts the DEB with `dpkg-deb` or the RPM with `rpm2archive` or `bsdtar`. [Download install.sh](https://melashri.net/raqsh/install.sh)

```sh
sh ./install.sh
```

The installer adds an app menu entry and puts the command in `~/.local/bin`. Run `sh ./install.sh --system` to install the DEB or RPM through your system package manager.

## Use the Linux archive

Download the Linux `.tar.gz` and `SHA256SUMS` from the same release. In the download directory, verify the archive before extracting it. For the noncommercial edition, run the commands below. For the commercial archive, use its filename from your Ko-fi download.

```sh
grep '  raqsh-linux-x86_64\.tar\.gz$' SHA256SUMS | sha256sum --check &&
  tar -xzf raqsh-linux-x86_64.tar.gz && ./raqsh/bin/raqsh
```

To add Raqsh to your app menu and install the `raqsh` command, run the installer inside the extracted archive.

```sh
sh ./raqsh/install.sh
```

The installer puts the app and MCP helper in `~/.local/opt/raqsh`, links `~/.local/bin/raqsh`, and adds a launcher in the user data directory. If `~/.local/bin` is on your `PATH`, you can start the app with `raqsh` from a terminal. Otherwise use the app menu or the full command path.

## Update or remove a user installation

Close Raqsh and rerun the website installer to update the noncommercial edition. For a downloaded archive, verify and extract it in a fresh directory, then run its installer. This replaces the app at the same path, so existing MCP registrations keep working. Get commercial updates from your Ko-fi order.

To remove the installed app, delete `~/.local/opt/raqsh`, the `~/.local/bin/raqsh` link, and `applications/raqsh-user.desktop` under `${XDG_DATA_HOME:-$HOME/.local/share}`. These are separate from your boards and preferences.

## Extract an older DEB or RPM

For a release that only offers system packages, download the package and the same release’s `SHA256SUMS` and verify the checksum first. Extract into a new directory, then start the app from the extracted `usr/bin` directory. Keep the `usr` tree together so the app can find its MCP helper and resources.

For a DEB, use `dpkg-deb`.

```sh
grep '  raqsh-linux-x86_64\.deb$' SHA256SUMS | sha256sum --check &&
  mkdir raqsh-local && dpkg-deb -x raqsh-linux-x86_64.deb raqsh-local &&
  ./raqsh-local/usr/bin/raqsh
```

For an RPM, use `rpm2archive` or `bsdtar` from libarchive. The example uses `rpm2archive`.

```sh
grep '  raqsh-linux-x86_64\.rpm$' SHA256SUMS | sha256sum --check &&
  mkdir raqsh-local &&
  rpm2archive --nocompression - < raqsh-linux-x86_64.rpm > raqsh-local/package.tar &&
  tar -xf raqsh-local/package.tar -C raqsh-local &&
  ./raqsh-local/usr/bin/raqsh
```

Update an extracted package by verifying and extracting a newer download locally. The in-app updater for a DEB or RPM uses the system package manager.
