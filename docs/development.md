# Development and release

Use the Node version in `.node-version`, the pnpm version in `package.json`, and the Rust toolchain in `rust-toolchain.toml`. On macOS, install the Xcode Command Line Tools and Python 3.11 or newer. On Ubuntu, install the native packages listed in the CI workflow.

```sh
pnpm install --frozen-lockfile
pnpm test:unit
pnpm desktop:dev
```

## Import a GitHub issue

Install GitHub CLI and sign in with `gh auth login`. In **New from task**, expand **Load a GitHub issue**, paste the issue URL, and choose **Load issue**. **Use issue** fills the title and brief. If the issue has checkboxes, choose **From checklist** to create editable cards. For a long issue, edit the brief to keep the relevant excerpt. Its GitHub source link stays in the resulting Task brief card.

Run `python3 bench/scripts/linux-github-issue.py target/release/raqsh` to exercise the import and its recovery paths with a disposable CLI fixture.

## Reuse board templates

In the project library, open **Templates → Template examples** or import a `.raqsh-template` file. Try [Bug triage](../examples/board-templates/bug-triage.raqsh-template), [Feature delivery](../examples/board-templates/feature-delivery.raqsh-template), or [Release verification](../examples/board-templates/release-verification.raqsh-template).

Select a saved template and choose **Edit template** to change its name, card text, or priorities. To change the structure or layout, create a board from the template, edit it on the canvas, then choose **Save as template → Update a saved template** from the board menu. Changes apply to future boards created from that template.

## Coding harnesses

Choose a client under **Agents** and approve a pairing. For manual setup, merge the generated entry into the file shown in the panel, preserve existing entries, and follow the client's approval flow. Keep generated entries local to your machine. After revoking a manual pairing in Raqsh, remove its named entry from the client's config. Raqsh removes registrations it installed automatically when the client's removal command succeeds.

Each client uses the same local stdio helper. The portable feedback workflow requires the agent to read, acknowledge, and respond using the board tools. For clients without a named profile, choose **Other MCP client** for a generic snippet.

| Client | Setup | Linux evidence |
| --- | --- | --- |
| Codex | Automatic | Existing real model proof |
| Claude Code | Automatic | Existing registration and connection proof |
| OpenCode | Project config for v2 | v2.3.2 connected over stdio |
| Pi | Automatic with Pi 1.6.0 or later. Manual project config is also available for an existing pairing | v1.6.0 discovered all nine tools and removed the registration on revoke |
| GitHub Copilot CLI | Project MCP config | Config generation tested |
| Cursor Agent CLI | Project MCP config and server approval | Config generation tested |
| Google Antigravity CLI | Workspace or user MCP config | v1.5.12 listed the user config entry |
| Cline CLI | User MCP config | Config generation tested |
| Qwen Code | Project settings | Config generation tested |
| Kiro CLI | Workspace MCP config | Config generation tested |
| Goose CLI | Stdio extension config | Config generation tested |
| Amp CLI | Workspace settings and server approval | Config generation tested |

### Raqsh skill

The optional [Raqsh skill](../skills/raqsh-board/SKILL.md) gives paired agents guidance on board selection, writes, and feedback. In **Agents**, choose a client and open **Raqsh skill** to install the file in the active project. The paths are relative to the project root.

| Clients | Skill path |
| --- | --- |
| Codex, OpenCode, Pi, Copilot CLI, Cursor, Antigravity, Qwen Code, Amp | `.agents/skills/raqsh-board/SKILL.md` |
| Claude Code | `.claude/skills/raqsh-board/SKILL.md` |
| Kiro CLI | `.kiro/skills/raqsh-board/SKILL.md` |

For other clients, choose **Save SKILL.md** and place the file in a directory named `raqsh-board` under the client’s skill folder. Restart the client from the project after installation. Remove the skill file to uninstall it. Pairings are managed separately in Agents.

### Maintaining profiles

The profile modules live in `crates/harnesses/src/`. For a new client, add its module with a stable ID and include it in `REGISTRY` in `lib.rs`. Change the client's module to update detection, registration, setup instructions or removal commands. Set its registry flag to `false` to hide it from the desktop and disable its named format in `raqsh-mcp setup` and `probe`. Keep the adapter registered so Raqsh can still revoke existing pairings and remove past automatic registrations.

`raqsh-mcp setup --pairing UUID --format PROFILE` prints a snippet. `raqsh-mcp probe --pairing UUID --format PROFILE` checks the authenticated Raqsh session. Use the client's MCP tooling to verify discovery and run a real model turn against a disposable board to verify the feedback workflow.

On Linux, with `tauri-driver`, `WebKitWebDriver`, and the relevant CLIs installed, run the native setup check after building the desktop and helper together.

```sh
python3 bench/scripts/linux-harnesses.py target/release/raqsh target/release/raqsh-mcp opencode pi antigravity
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

## Linux editor verification

With `tauri-driver` and `WebKitWebDriver` installed, run the editing check from a logged-in Linux desktop session.

```sh
pnpm desktop:build
python3 bench/scripts/linux-editing.py target/release/raqsh
```

The check uses a disposable board and exercises keyboard shortcuts, grouped pointer gestures, drawing edits, unified history, and reopening the saved board.

Run `python3 bench/scripts/linux-preferences.py target/release/raqsh` to verify first launch, reopening the tour, switching the board theme, and recovering from a settings write failure. Both checks use isolated local data.

## Releases and updates

1. Generate a Tauri updater key outside the repository with `pnpm exec tauri signer generate --write-keys /path/to/raqsh-updater.key`. Store the private key securely. Set `TAURI_SIGNING_PRIVATE_KEY` and, if used, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as GitHub repository secrets. Set the contents of the public key file as the `RAQSH_UPDATER_PUBLIC_KEY` repository variable. Keep the same updater key for future releases so installed versions can verify them.
2. Push a tag `vMAJOR.MINOR.PATCH` whose version matches `apps/desktop/src-tauri/Cargo.toml`, then dispatch **Release** with that tag. The macOS bundle uses ad hoc signing. [First launch on macOS](https://melashri.net/raqsh/#macos-first-launch)
3. Download the draft’s packages, verify `SHA256SUMS`, and smoke-test the installers. Publish the draft after those checks pass.

Release builds embed the updater public key. The workflow signs the macOS, Debian, and RPM update packages against the release version and publishes a `latest.json` manifest to GitHub Releases. The download and manifest must be publicly reachable by the app. On Linux, installation may request system authorization. Local builds without the updater key show version information in About.

The Linux user archive reuses the matching DEB's executable, helper, icons and notices. After `pnpm desktop:build` and `pnpm desktop:bundle --bundles deb,rpm`, run the shared packager for either edition.

```sh
bash scripts/bundle-linux-user.sh path/to/package.deb raqsh-linux-x86_64.tar.gz
```

Include the archive in the release checksums. The public `install.sh` defaults to the user archive on Linux, and `--system` selects APT or DNF. User installations update by replacing the archive contents, with the executable and MCP helper kept at the same paths. [User installation and upgrade instructions](linux-install.md)

The public release workflow and shell installer distribute the noncommercial edition. The build generates the edition label, license resource and updater configuration together from the edition selected in `branding/edition.json`. The commercial release uses the same app and package identities and delivers updates through Ko-fi.
