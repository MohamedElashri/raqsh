# Raqsh

Raqsh is a local-first whiteboard for planning with coding agents. Arrange tasks, link dependencies, sketch ideas, and send feedback through MCP. Your boards are stored on your device.

## Install

Get the package for your platform from [GitHub Releases](https://github.com/MohamedElashri/raqsh/releases/latest). Releases support Apple silicon and Intel Macs, plus x86-64 Ubuntu and Fedora.

Or run the installer in your terminal with curl or wget.

```sh
curl -fsSL https://github.com/MohamedElashri/raqsh/releases/latest/download/install.sh | sh
wget -qO- https://github.com/MohamedElashri/raqsh/releases/latest/download/install.sh | sh
```

## Get started

Open Raqsh, choose a project folder, and create a board. Focus the canvas and press **N** to add a card. Open **Agents** to pair a coding client, then use **Setup command** to get its MCP configuration.

## Build and test on macOS

Install the Xcode Command Line Tools, Python 3.11 or newer, the Node version in `.node-version`, and the Rust toolchain in `rust-toolchain.toml`. Use the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm test:unit
pnpm test:macos
pnpm desktop:build
APPLE_SIGNING_IDENTITY=- pnpm desktop:bundle --bundles app
codesign --verify --deep --strict target/release/bundle/macos/visual-board.app
open target/release/bundle/macos/visual-board.app
```

The live suite needs a logged-in macOS desktop session. It drives the editor in WebKit, exercises the MCP sidecar, and reopens a board to check persistence using a temporary library. Use `pnpm test:macos --stress-only` to repeat the eraser benchmark on a 500-card, 2,000-stroke board. It reports the median time for a batch of 160 synthetic pointer moves.

The bundle command above produces an ad hoc signed app for local use. The release workflow handles Developer ID signing and notarization.

### Test with Codex and Claude Code

With the provider CLIs installed and authenticated, run either test from the repository root. Each test uses a real model turn to update a card through MCP, checks the change in the open editor, then reopens the board to verify that it was saved. The app uses a disposable library with synthetic data.

```sh
pnpm test:macos --provider codex
pnpm test:macos --provider claude-code
```

The **CI** workflow builds on Linux and macOS and runs the credential-free live suite on macOS. To run the two model-backed tests on GitHub, configure `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` as repository secrets, then dispatch **CI** with `providers` enabled. To publish an existing `vMAJOR.MINOR.PATCH` tag whose version matches `apps/desktop/src-tauri/Cargo.toml`, dispatch **Release** with that tag. Release tests the tagged source before packaging and signing.
