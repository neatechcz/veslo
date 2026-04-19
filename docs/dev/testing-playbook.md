# Testing Playbook

This file describes the practical verification flow for coding work in Veslo.

## First Rule

Do not use `packages/web` as the runtime under test. Veslo's authoritative application runtime is the Tauri desktop app in `packages/desktop`.

## Fast Checks by Surface

### App-only documentation or copy changes

Run from repo root:

```bash
pnpm typecheck
```

If you touched app logic or page composition, also run the most relevant UI checks from `packages/app/package.json`.

### Solid app changes in `packages/app`

Start with:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Then run focused script tests relevant to the changed area, for example:

- `pnpm --filter @neatech/veslo-ui test:cloud-onboarding`
- `pnpm --filter @neatech/veslo-ui test:desktop-auth-onboarding`
- `pnpm --filter @neatech/veslo-ui test:session-switch`
- `pnpm --filter @neatech/veslo-ui test:fs-engine`
- `pnpm --filter @neatech/veslo-ui test:browser-entry`

### Desktop runtime or native command changes

Use the real desktop runtime:

```bash
pnpm dev
```

For internal end-to-end testing, follow the repo rule from `AGENTS.md`:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/<target>.spec.ts
```

### Server changes in `packages/server/src`

Run server tests if relevant, and rebuild the server binary used by orchestrator-driven flows:

```bash
pnpm --filter openwork-server build:bin
```

If app behavior depends on that server change, verify the app against the rebuilt binary.

### Orchestrator changes

Run the orchestrator-focused tests from the workspace root:

```bash
pnpm test:orchestrator
```

### Full app sanity

For a broad app-level check from the repo root:

```bash
pnpm test:e2e
```

This is still not a replacement for the Tauri + WebdriverIO runtime gate when the user asked to test the real app.

## High-Risk Flow Validation

For onboarding, sharing, runtime recovery, or other user-visible multi-step flows:

1. Start the Veslo dev stack if required.
2. Validate in the real desktop runtime.
3. If the task requires feature-complete flow validation, use Docker plus Chrome MCP per `AGENTS.md`.

If you cannot run Docker or Chrome MCP, report exactly what you verified instead.

## What to Record

In the final summary for implementation work, report:

- exact commands run
- whether they passed or failed
- any gaps you could not execute

## Anti-Patterns

- using `packages/web` as proof that the app works
- claiming Tauri behavior based only on `vite` dev server checks
- changing `packages/server/src` without rebuilding the binary that orchestrator actually runs
- running only broad tests when a targeted script exists for the changed behavior
