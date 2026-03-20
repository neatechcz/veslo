# Veslo Orchestrator

Host orchestrator for opencode + Veslo server + opencode-router. This is a CLI-first way to run host mode without the desktop UI.

Published on npm as `veslo-orchestrator` and installs the `veslo` command.

## Quick start

```bash
npm install -g veslo-orchestrator
veslo start --workspace /path/to/workspace --approval auto
```

When run in a TTY, `veslo` shows an interactive status dashboard with service health, ports, and
connection details. Use `veslo serve` or `--no-tui` for log-only mode.

```bash
veslo serve --workspace /path/to/workspace
```

`veslo` ships as a compiled binary, so Bun is not required at runtime.

`veslo` downloads and caches the `veslo-server`, `opencode-router`, and `opencode` sidecars on
first run using a SHA-256 manifest. Use `--sidecar-dir` or `VESLO_SIDECAR_DIR` to control the
cache location, and `--sidecar-base-url` / `--sidecar-manifest` to point at a custom host.

Use `--sidecar-source` to control where `veslo-server` and `opencode-router` are resolved
(`auto` | `bundled` | `downloaded` | `external`), and `--opencode-source` to control
`opencode` resolution. Set `VESLO_SIDECAR_SOURCE` / `VESLO_OPENCODE_SOURCE` to
apply the same policies via env vars.

By default the manifest is fetched from
`https://github.com/neatechcz/veslo/releases/download/veslo-orchestrator-v<version>/veslo-orchestrator-sidecars.json`.

OpenCode Router is optional. If it exits, `veslo` continues running unless you pass
`--opencode-router-required` or set `VESLO_OPENCODE_ROUTER_REQUIRED=1`.

For development overrides only, set `VESLO_ALLOW_EXTERNAL=1` or pass `--allow-external` to use
locally installed `veslo-server` or `opencode-router` binaries.

Add `--verbose` (or `VESLO_VERBOSE=1`) to print extra diagnostics about resolved binaries.

OpenCode hot reload is enabled by default when launched via `veslo`.
Tune it with:

- `--opencode-hot-reload` / `--no-opencode-hot-reload`
- `--opencode-hot-reload-debounce-ms <ms>`
- `--opencode-hot-reload-cooldown-ms <ms>`

Equivalent env vars:

- `VESLO_OPENCODE_HOT_RELOAD` (router mode)
- `VESLO_OPENCODE_HOT_RELOAD_DEBOUNCE_MS`
- `VESLO_OPENCODE_HOT_RELOAD_COOLDOWN_MS`
- `VESLO_OPENCODE_HOT_RELOAD` (start/serve mode)
- `VESLO_OPENCODE_HOT_RELOAD_DEBOUNCE_MS`
- `VESLO_OPENCODE_HOT_RELOAD_COOLDOWN_MS`

Or from source:

```bash
pnpm --filter veslo-orchestrator dev -- \
  start --workspace /path/to/workspace --approval auto --allow-external
```

The command prints pairing details (Veslo server URL + token, OpenCode URL + auth) so remote Veslo clients can connect.

Use `--detach` to keep services running and exit the dashboard. The detach summary includes the
Veslo URL, tokens, and the `opencode attach` command.

## Sandbox mode (Docker / Apple container)

`veslo` can run the sidecars inside a Linux container boundary while still mounting your workspace
from the host.

```bash
# Auto-pick sandbox backend (prefers Apple container on supported Macs)
veslo start --sandbox auto --workspace /path/to/workspace --approval auto

# Explicit backends
veslo start --sandbox docker --workspace /path/to/workspace --approval auto
veslo start --sandbox container --workspace /path/to/workspace --approval auto
```

Notes:

- `--sandbox auto` prefers Apple `container` on supported Macs (arm64), otherwise Docker.
- Docker backend requires `docker` on your PATH.
- Apple container backend requires the `container` CLI (https://github.com/apple/container).
- In sandbox mode, sidecars are resolved for a Linux target (and `--sidecar-source` / `--opencode-source`
  are effectively `downloaded`).
- Custom `--*-bin` overrides are not supported in sandbox mode yet.
- Use `--sandbox-image` to pick an image with the toolchain you want available to OpenCode.
- Use `--sandbox-persist-dir` to control the host directory mounted at `/persist` inside the container.

### Extra mounts (allowlisted)

You can add explicit, validated mounts into `/workspace/extra/*`:

```bash
veslo start --sandbox auto --sandbox-mount "/path/on/host:datasets:ro" --workspace /path/to/workspace
```

Additional mounts are blocked unless you create an allowlist at:

- `~/.config/veslo/sandbox-mount-allowlist.json`

Override with `VESLO_SANDBOX_MOUNT_ALLOWLIST`.

## Logging

`veslo` emits a unified log stream from OpenCode, Veslo server, and opencode-router. Use JSON format for
structured, OpenTelemetry-friendly logs and a stable run id for correlation.

```bash
VESLO_LOG_FORMAT=json veslo start --workspace /path/to/workspace
```

Use `--run-id` or `VESLO_RUN_ID` to supply your own correlation id.

Veslo server logs every request with method, path, status, and duration. Disable this when running
`veslo-server` directly by setting `VESLO_LOG_REQUESTS=0` or passing `--no-log-requests`.

## Router daemon (multi-workspace)

The router keeps a single OpenCode process alive and switches workspaces JIT using the `directory` parameter.

```bash
veslo daemon start
veslo workspace add /path/to/workspace-a
veslo workspace add /path/to/workspace-b
veslo workspace list --json
veslo workspace path <id>
veslo instance dispose <id>
```

Use `VESLO_DATA_DIR` or `--data-dir` to isolate router state in tests.

## Pairing notes

- Use the **Veslo connect URL** and **client token** to connect a remote Veslo client.
- The Veslo server advertises the **OpenCode connect URL** plus optional basic auth credentials to the client.

## Approvals (manual mode)

```bash
veslo approvals list \
  --veslo-url http://<host>:8787 \
  --host-token <token>

veslo approvals reply <id> --allow \
  --veslo-url http://<host>:8787 \
  --host-token <token>
```

## Health checks

```bash
veslo status \
  --veslo-url http://<host>:8787 \
  --opencode-url http://<host>:4096
```

## File sessions (JIT catalog + batch read/write)

Create a short-lived workspace file session and sync files in batches:

```bash
# Create writable session
veslo files session create \
  --veslo-url http://<host>:8787 \
  --token <client-token> \
  --workspace-id <workspace-id> \
  --write \
  --json

# Fetch catalog snapshot
veslo files catalog <session-id> \
  --veslo-url http://<host>:8787 \
  --token <client-token> \
  --limit 200 \
  --json

# Read one or more files
veslo files read <session-id> \
  --veslo-url http://<host>:8787 \
  --token <client-token> \
  --paths "README.md,notes/todo.md" \
  --json

# Write a file (inline content or --file)
veslo files write <session-id> \
  --veslo-url http://<host>:8787 \
  --token <client-token> \
  --path notes/todo.md \
  --content "hello from veslo" \
  --json

# Watch change events and close session
veslo files events <session-id> --veslo-url http://<host>:8787 --token <client-token> --since 0 --json
veslo files session close <session-id> --veslo-url http://<host>:8787 --token <client-token> --json
```

## Smoke checks

```bash
veslo start --workspace /path/to/workspace --check --check-events
```

This starts the services, verifies health + SSE events, then exits cleanly.

## Local development

Point to source CLIs for fast iteration:

```bash
veslo start \
  --workspace /path/to/workspace \
  --allow-external \
  --veslo-server-bin packages/server/src/cli.ts \
  --opencode-router-bin ../opencode-router/dist/cli.js
```
