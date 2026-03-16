[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/VEhNQXxYMB)

# Veslo

> Veslo helps you run your agents, skills, and MCP. It's a local-first alternative to Claude Cowork/Codex (desktop app).

## Core Philosophy

- Local-first, cloud-ready: Veslo runs on your machine in one click. Send a message instantly.
- Composable: desktop app, WhatsApp/Slack/Telegram connector, or server. Use what fits, no lock-in.
- Ejectable: Veslo is powered by OpenCode, so everything OpenCode can do works in Veslo, even without a UI yet.
- Sharing is caring: start solo, then share. One CLI or desktop command spins up an instantly shareable instance.

<p align="center">
  <img src="./app-demo.gif" alt="Veslo demo" width="800" />
</p>

Veslo is designed around the idea that you can easily ship your agentic workflows as a repeatable, productized process.

## Alternate UIs

- **Veslo Code Router (WhatsApp bot)**: a lightweight WhatsApp bridge for a running OpenCode server. Install with:
  - `curl -fsSL https://raw.githubusercontent.com/neatech/veslo-code-router/dev/install.sh | bash`
  - run `veslo-code-router setup`, then `veslo-code-router whatsapp login`, then `veslo-code-router start`
  - full setup: https://github.com/neatech/veslo-code-router/blob/dev/README.md
- **Veslo Orchestrator (CLI host)**: run OpenCode + Veslo server without the desktop UI.
  - install: `npm install -g veslo-orchestrator`
  - run: `veslo start --workspace /path/to/workspace --approval auto`
  - docs: [packages/orchestrator/README.md](./packages/orchestrator/README.md)

## Quick start

Download the dmg here https://github.com/neatech/veslo/releases (or install from source below)

## Why

Current CLI and GUIs for opencode are anchored around developers. That means a focus on file diffs, tool names, and hard to extend capabilities without relying on exposing some form of cli.

Veslo is designed to be:

- **Extensible**: skill and opencode plugins are installable modules.
- **Auditable**: show what happened, when, and why.
- **Permissioned**: access to privileged flows.
- **Local/Remote**: Veslo works locally as well as can connect to remote servers.

## What's Included

- **Host mode**: runs opencode locally on your computer
- **Client mode**: connect to an existing OpenCode server by URL.
- **Sessions**: create/select sessions and send prompts.
- **Live streaming**: SSE `/event` subscription for realtime updates.
- **Execution plan**: render OpenCode todos as a timeline.
- **Permissions**: surface permission requests and reply (allow once / always / deny).
- **Templates**: save and re-run common workflows (stored locally).
- **Skills manager**:
  - list installed `.opencode/skills` folders
  - install from OpenPackage (`opkg install ...`)
  - import a local skill folder into `.opencode/skills/<skill-name>`

## Skill Manager

<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />

## Works on local computer or servers

<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />

## Quick Start

### Requirements

- Node.js + `pnpm`
- Rust toolchain (for Tauri): install via `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Tauri CLI: `cargo install tauri-cli`
- OpenCode CLI installed and available on PATH: `opencode`

### Local Dev Prerequisites (Desktop)

Before running `pnpm dev`, ensure these are installed and active in your shell:

- Node + pnpm (repo uses `pnpm@10.27.0`)
- **Bun 1.3.9+** (`bun --version`)
- Rust toolchain (for Tauri), with Cargo from current `rustup` stable (supports `Cargo.lock` v4)
- Xcode Command Line Tools (macOS)

### One-minute sanity check

Run from repo root:

```bash
git checkout dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile

which bun
bun --version
pnpm --filter @neatech/veslo exec tauri --version
```

### Install

```bash
pnpm install
```

Veslo now lives in `packages/app` (UI) and `packages/desktop` (desktop shell).

### Run (Desktop)

```bash
pnpm dev
```

### Run (Web UI only)

```bash
pnpm dev:ui
```

### Developing against the cloud dev environment (pre-authenticated)

`packages/app/.env.development` contains credentials for the shared dev cloud stack. When you run `pnpm dev` or `pnpm dev:ui`, Vite picks this file up automatically and injects these values into the app at startup:

| Variable | Purpose |
|---|---|
| `VITE_VESLO_ENV=development` | Selects the `_DEV` suffix for all env lookups |
| `VITE_VESLO_URL_DEV` | Points the UI at the dev cloud worker |
| `VITE_VESLO_LOGIN_URL_DEV` | Den API base URL for desktop auth |
| `VITE_VESLO_TOKEN_DEV` | Access token written to `localStorage` on first load |

On startup, `hydrateVesloServerSettingsFromEnv()` (see `packages/app/src/app/lib/veslo-server.ts`) reads these values and persists them to `localStorage`. This means the app boots already connected to the dev worker with a valid token — no manual URL or token entry needed in the settings UI.

> **Note:** This pre-fills the **veslo server connection token** only. Den cloud auth (`veslo.den.auth` in `localStorage`) is separate and still requires going through the normal sign-in flow.

### Arch Users:

```bash
yay -s opencode # Releases version
```

## Architecture (high-level)

- In **Host mode**, Veslo runs a local host stack and connects the UI to it.
  - Default runtime: `veslo` (installed from `veslo-orchestrator`), which orchestrates `opencode`, `veslo-server`, and optionally `veslo-code-router`.
  - Fallback runtime: `direct`, where the desktop app spawns `opencode serve --hostname 127.0.0.1 --port <free-port>` directly.

When you select a project folder, Veslo runs the host stack locally using that folder and connects the desktop UI.
This lets you run agentic workflows, send prompts, and see progress entirely on your machine without a remote server.

- The UI uses `@opencode-ai/sdk/v2/client` to:
  - connect to the server
  - list/create sessions
  - send prompts
  - subscribe to SSE events(Server-Sent Events are used to stream real-time updates from the server to the UI.)
  - read todos and permission requests

## Folder Picker

The folder picker uses the Tauri dialog plugin.
Capability permissions are defined in:

- `packages/desktop/src-tauri/capabilities/default.json`

## OpenPackage Notes

If `opkg` is not installed globally, Veslo falls back to:

```bash
pnpm dlx opkg install <package>
```

## OpenCode Plugins

Plugins are the **native** way to extend OpenCode. Veslo now manages them from the Skills tab by
reading and writing `opencode.json`.

- **Project scope**: `<workspace>/opencode.json`
- **Global scope**: `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/opencode.json`)

You can still edit `opencode.json` manually; Veslo uses the same format as the OpenCode CLI:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## Useful Commands

```bash
pnpm dev
pnpm dev:ui
pnpm typecheck
pnpm build
pnpm build:ui
pnpm test:e2e
```

## Troubleshooting

### Linux / Wayland (Hyprland)

If Veslo crashes on launch with WebKitGTK errors like `Failed to create GBM buffer`, disable dmabuf or compositing before launch. Try one of the following environment flags.

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 veslo
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 veslo
```

## Security Notes

- Veslo hides model reasoning and sensitive tool metadata by default.
- Host mode binds to `127.0.0.1` by default.

## Contributing

- Review `AGENTS.md` plus `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, and `ARCHITECTURE.md` to understand the product goals before making changes.
- Ensure Node.js, `pnpm`, the Rust toolchain, and `opencode` are installed before working inside the repo.
- Run `pnpm install` once per checkout, then verify your change with `pnpm typecheck` plus `pnpm test:e2e` (or the targeted subset of scripts) before opening a PR.
- Use `.github/pull_request_template.md` when opening PRs and include exact commands, outcomes, manual verification steps, and evidence.
- If CI fails, classify failures in the PR body as either code-related regressions or external/environment/auth blockers.
- Add new PRDs to `packages/app/pr/<name>.md` following the `.opencode/skills/prd-conventions/SKILL.md` conventions described in `AGENTS.md`.

Community docs:

- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `SUPPORT.md`
- `TRIAGE.md`

First contribution checklist:

- [ ] Run `pnpm install` and baseline verification commands.
- [ ] Confirm your change has a clear issue link and scope.
- [ ] Add/update tests for behavioral changes.
- [ ] Include commands run and outcomes in your PR.
- [ ] Add screenshots/video for user-facing flow changes.

## For Teams & Businesses

Interested in using Veslo in your organization? We'd love to hear from you — reach out at [benjamin.shafii@gmail.com](mailto:benjamin.shafii@gmail.com) to chat about your use case.

## License

Proprietary — all rights reserved. See `LICENSE`.
