# Development and release

Use the Node version in `.node-version`, the pnpm version in `package.json`, and the Rust toolchain in `rust-toolchain.toml`. On macOS, install the Xcode Command Line Tools and Python 3.11 or newer. On Ubuntu, install the native packages listed in the CI workflow.

```sh
pnpm install --frozen-lockfile
pnpm test:unit
pnpm desktop:dev
```

## macOS

Run the native WebKit, MCP, stress, and signed updater tests from a logged-in desktop session. The updater test uses a disposable bundle and a loopback release server.

```sh
pnpm test:macos
pnpm test:macos --stress-only
pnpm desktop:build
APPLE_SIGNING_IDENTITY=- pnpm desktop:bundle --bundles app
codesign --verify --deep --strict target/release/bundle/macos/Raqsh.app
open target/release/bundle/macos/Raqsh.app
```

The stress test reports the median time for 160 eraser moves on a 500-card, 2,000-stroke board.

With the provider CLIs installed and authenticated, run the model-backed tests below. Each test registers the bundled helper in a disposable client profile and verifies that a real model turn updates a synthetic board. The update must survive reopening.

```sh
pnpm test:macos --provider codex
pnpm test:macos --provider claude-code
```

The **CI** workflow builds on Linux and macOS. To run model-backed tests on GitHub, set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` as repository secrets and dispatch **CI** with `providers` enabled.

## Releases and updates

1. Generate a Tauri updater key outside the repository with `pnpm exec tauri signer generate --write-keys /path/to/raqsh-updater.key`. Store the private key securely. Set `TAURI_SIGNING_PRIVATE_KEY` and, if used, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as GitHub repository secrets. Set the contents of the public key file as the `RAQSH_UPDATER_PUBLIC_KEY` repository variable. Keep the same updater key for future releases so installed versions can verify them.
2. Push a tag `vMAJOR.MINOR.PATCH` whose version matches `apps/desktop/src-tauri/Cargo.toml`, then dispatch **Release** with that tag. The macOS bundle uses ad hoc signing. The README describes the first-launch step for downloaded copies.
3. Download the draft’s packages, verify `SHA256SUMS`, and smoke-test the installers. Publish the draft after those checks pass.

Release builds embed the updater public key. The workflow signs the macOS, Debian, and RPM update packages against the release version and publishes a `latest.json` manifest to GitHub Releases. The download and manifest must be publicly reachable by the app. On Linux, installation may request system authorization. Local builds without the updater key show version information in About.
