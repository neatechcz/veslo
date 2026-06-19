# Build and Rebuild Matrix

Use this matrix to decide what must be rebuilt after a code change.

## Quick Matrix

| Change area | Minimum follow-up | Why |
| --- | --- | --- |
| `packages/app/src` UI-only logic | `pnpm typecheck` plus focused app tests | Solid app compile and behavior checks |
| `packages/app/src` with desktop-only behavior assumptions | Run through Tauri desktop runtime | Browser-only checks are not authoritative |
| `packages/server/src` | `pnpm --filter veslo-server build:bin` | Orchestrator uses the built server binary, not TS sources |
| `packages/desktop/src-tauri` | Rebuild desktop runtime | Native commands and shell behavior live in Tauri |
| `packages/e2e` | Re-run targeted WebdriverIO spec | Snapshots and runtime expectations changed |
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

### WebdriverIO

```bash
cd packages/e2e
pnpm test --spec ./specs/<target>.spec.ts
```

## When in Doubt

- If the change crosses app and server boundaries, rebuild the server binary and verify through the desktop app.
- If the change touches native commands or shell integration, use the desktop runtime, not just `vite`.
- If the change only affects docs, keep verification focused on the docs and repo references.
