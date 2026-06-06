# Build and Rebuild Matrix

Use this matrix to decide what must be rebuilt after a code change.

## Quick Matrix

| Change area | Minimum follow-up | Why |
| --- | --- | --- |
| `packages/app/src` UI-only logic | `pnpm typecheck` plus focused app tests | Solid app compile and behavior checks |
| `packages/app/src` with desktop-only behavior assumptions | Run through Tauri desktop runtime | Browser-only checks are not authoritative |
| `packages/server/src` | `pnpm --filter veslo-server build:bin` | Orchestrator uses the built server binary, not TS sources |
| `packages/desktop/src-tauri` | Rebuild desktop runtime | Native commands and shell behavior live in Tauri |
| `packages/e2e` | Re-run targeted `tauri-pilot` scenario | Runtime expectations changed |
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

### tauri-pilot

```bash
cd packages/e2e
pnpm test -- --scenario <name-or-path>
```

Legacy WebdriverIO specs are not a runtime gate. Convert the target behavior to `tauri-pilot` before relying on it for validation.
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

## When in Doubt

- If the change crosses app and server boundaries, rebuild the server binary and verify through the desktop app.
- If the change touches native commands or shell integration, use the desktop runtime, not just `vite`.
- If the change only affects docs, keep verification focused on the docs and repo references.
