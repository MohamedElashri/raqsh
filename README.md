<p align="center"><img src="docs/images/raqsh-mark.png" alt="" width="76" height="76"></p>
<h1 align="center">Raqsh</h1>
<p align="center">A local-first whiteboard for planning with coding agents.</p>

<table>
  <tr>
    <td width="50%"><img src="docs/images/board.png" alt="Raqsh canvas with task cards, dependencies, and handwritten notes" width="512"></td>
    <td width="50%"><img src="docs/images/agents.png" alt="Raqsh agent panel showing a paired client and board feedback" width="512"></td>
  </tr>
</table>

## Install

Download [the latest release](https://github.com/MohamedElashri/raqsh/releases/latest) for macOS (Apple silicon or Intel), Ubuntu x86-64 (`.deb`), or Fedora x86-64 (`.rpm`). On macOS, unzip the download and move Raqsh to Applications.

```sh
curl -fsSL https://github.com/MohamedElashri/raqsh/releases/latest/download/install.sh | sh
```

> **First launch on macOS.** Raqsh is ad hoc signed and has no Apple notarization ticket. Gatekeeper may block the downloaded app. If that happens, verify the ZIP against `SHA256SUMS` from the same GitHub release, then remove the quarantine attribute from your installed copy of Raqsh only. [Apple’s explanation of Gatekeeper](https://support.apple.com/en-us/102445)
>
> ```sh
> # If you moved the app to Applications
> xattr -dr com.apple.quarantine /Applications/visual-board.app
>
> # If you used the shell installer
> xattr -dr com.apple.quarantine "$HOME/Applications/visual-board.app"
> ```

## Get started

Open a project folder, create a board, and press **N** on the canvas to add a card. To connect an agent, open **Agents**, choose Codex or Claude Code, and approve the pairing. Raqsh registers its bundled MCP helper. Open a new session in your client to use it.

Check for updates under **Settings → About**. Checking, downloading, installing, and restarting are each started from the app. Boards are stored on your device.

[Development and release guide](docs/development.md)
