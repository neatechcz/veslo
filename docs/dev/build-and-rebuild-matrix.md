# Build and Rebuild Matrix

Use this matrix to decide what must be rebuilt after a code change.

## Quick Matrix

| Change area | Minimum follow-up | Why |
| --- | --- | --- |
| `packages/app/src` UI-only logic | `pnpm typecheck` plus focused app tests | Solid app compile and behavior checks |
| `packages/app/src` with desktop-only behavior assumptions | Run through Tauri desktop runtime | Browser-only checks are not authoritative |
| `packages/server/src` | `pnpm --filter veslo-server build:bin` | Orchestrator uses the built server binary, not TS sources |
| `packages/desktop/src-tauri` | Rebuild desktop runtime | Native commands and shell behavior live in Tauri |
| Local host child lifecycle/recovery | `pnpm check:desktop-recovery` after desktop preflight | Rebuilds the focused E2E binary and proves VSLO-235 child exit/restart with a fresh profile |
| `packages/e2e` | Re-run targeted `tauri-pilot` scenario | Runtime expectations changed |
| Windows MSI payload or startup contract | Run extracted-MSI verification, then the disposable-VM installed-MSI gate | An administrative extraction cannot prove Program Files startup, profile isolation, or second-start behavior |
| `packages/orchestrator/src` | Re-run orchestrator tests and relevant host flows | Sidecar orchestration is CLI-owned |
| shared docs only | No binary rebuild required | Documentation-only change |

## Practical Commands

### App

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

### Server binary

```bash
pnpm --filter veslo-server build:bin
```

### Desktop runtime

```bash
pnpm dev
```

### Tauri E2E build

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

### Focused desktop recovery quality gate

After the Desktop Test Runtime Preflight, run:

```bash
pnpm check:desktop-recovery
```

This is the same Windows CI command behind `Quality / Desktop recovery`. It builds the
server binary and E2E Tauri app, prepares sidecars, then runs only
`vslo-235-local-host-child-exit`; it does not substitute the broader Pilot suite.

### tauri-pilot

```bash
cd packages/e2e
pnpm test:pilot -- --scenario <name-or-path>
```

WebdriverIO is not part of the Veslo E2E surface. Add or run a Tauri Pilot scenario before relying on desktop validation.
For core platform skill materialization, run the focused pilot gate:

```bash
pnpm --filter veslo-server build:bin
VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar

cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e

cd ../e2e
pnpm test:pilot:core-platform-skills
```

The pilot script requires `tauri-pilot` on `PATH`, or `E2E_TAURI_PILOT_BIN=/absolute/path/to/tauri-pilot`.
The desktop plugin is pinned to the upstream `tauri-pilot` 0.7.2 revision that routes macOS eval results through the Pilot IPC callback; keep the CLI at 0.7.2 or set `E2E_TAURI_PILOT_BIN` to a compatible binary.

### Release bundle sidecars

Release bundle verification must check more than `versions.json` presence. The
macOS extracted-app verifier also requires the bundled `veslo-server`,
`veslo-code-router`, `veslo-orchestrator`, `veslo-code`, `opencode`,
`chrome-devtools-mcp`, `veslo-node`, and `opencode-managed-deps.json` sidecars to exist, and
executable sidecars must have executable permissions on POSIX platforms.
The bundled `veslo-node` runtime accompanies Chrome DevTools MCP in every
Windows and macOS distributable bundle. `prepare-sidecar.mjs` provisions the
matching target binary, while the target-specific Tauri configs declare it.
The shared Tauri config does not list it, so Linux-only configurations do not
require a Node sidecar they do not provision.
Generated CI config extensions must stay minimal and override only the intended
setting; copying the base config into a later `--config` layer would replace the
Windows-specific `externalBin` array.

### Windows final MSI

Validate a final Windows asset in two distinct steps. The first is an exact
artifact check and may run on a build machine with Node available:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release/verify-windows-msi-runtime.ps1 -MsiPath <exact-signed-msi> -SummaryPath <evidence-dir>\payload.json
```

It performs an administrative extraction and verifies the sidecar payload,
manifest, bundled document-runtime provider, and Chrome DevTools MCP runtime.
It does not install the MSI and therefore cannot prove customer startup.
Production, prerelease, manual, and staging Windows workflows run this exact
gate and Authenticode verification before their first MSI artifact upload.

The second step runs only on an elevated, disposable Windows VM with the exact
same MSI:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release/verify-windows-msi-installed.ps1 -Scenario clean -MsiPath <exact-signed-msi> -ReleaseTag <tag> -Commit <commit> -SummaryPath <evidence-dir>\clean.json
```

The installed-MSI verifier deliberately does not use Tauri Pilot. It observes
the Program Files process, main window, authenticated local server status,
document-runtime status, and redacted durable `desktop-bootstrap-ready.json`
marker. Run its clean, no-WSL, upgrade, normal-second-start, forced-runtime,
foreign-listener, and updater scenarios before promoting the public Windows
release.

## When in Doubt

- If the change crosses app and server boundaries, rebuild the server binary and verify through the desktop app.
- If the change touches native commands or shell integration, use the desktop runtime, not just `vite`.
- If the change only affects docs, keep verification focused on the docs and repo references.
