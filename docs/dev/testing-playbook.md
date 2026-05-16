# Testing Playbook

This file describes the practical verification flow for coding work in Veslo.

## First Rule

Do not use `packages/web` or UI-only web servers as the runtime under test. Do not start `pnpm -w dev:ui`, `pnpm --filter @neatech/veslo-ui dev`, or raw Vite as the app runtime. Veslo's authoritative application runtime is the Tauri desktop app in `packages/desktop`.

When creating tests, always prefer E2E tests. Add lower-level tests only when an E2E test cannot cover the behavior reliably or when they provide useful support around a primary E2E path.

## Desktop Test Runtime Preflight

Veslo desktop is single-tenant in development. Before any test that launches or depends on the desktop runtime, the agent must ensure it is not starting a second app instance.

This is an LLM/operator responsibility, not a step to duplicate inside individual specs.

1. Detect running Veslo dev/test processes from this repo:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

2. If the matches are internally started dev/test runtime processes from this repo, stop them before launching the test runtime:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

3. Verify the post-check is empty before continuing:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If a match looks like a user-launched production/bundled app or otherwise cannot be identified as an internally started dev/test runtime, stop and report what is running instead of force-killing it.

Existing WebDriver reuse is not the default desktop test flow. Attach to an existing WebDriver server only when the user explicitly asks for a debug attach workflow.

The WebdriverIO launcher waits for the Tauri process it started to exit during teardown and escalates to a force kill if the process ignores the graceful stop signal. This harness cleanup does not replace the preflight above; clear matching Veslo dev/test processes before each desktop runtime launch.

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
# First run the Desktop Test Runtime Preflight above.

cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/<target>.spec.ts
```

The E2E launcher uses an isolated app profile under `packages/e2e/.tmp-veslo-home` by default so local desktop state does not leak into tests. Set `E2E_USE_EXISTING_PROFILE=1` only when a test explicitly needs the current user profile.

For visual snapshot updates, run:

```bash
cd packages/e2e
pnpm test:update-baselines --spec ./specs/visual-regression.spec.ts
pnpm test --spec ./specs/visual-regression.spec.ts
```

The second command is required proof that the refreshed baselines pass in normal comparison mode.

### Live feedback-to-YouTrack smoke

Use this only when a real feedback report and a real YouTrack issue are acceptable. This is not a CI gate.

The live smoke uses the desktop WebdriverIO harness to click the feedback UI, submit a unique report, confirm that the UI shows the returned YouTrack task number, and then poll YouTrack through the locally configured MCP transport until the projected issue appears.

Requirements:

- run the Desktop Test Runtime Preflight first
- build the E2E desktop binary with `pnpm tauri build --debug --no-bundle -- --features e2e`
- use a signed-in Den desktop profile with `E2E_USE_EXISTING_PROFILE=1`, or provide `E2E_DEN_AUTH_JSON`
- ensure the YouTrack MCP command is available at `~/.config/youtrack-mcp/run-remote.sh`, or set `E2E_YOUTRACK_MCP_COMMAND`
- set `E2E_YOUTRACK_PROJECT_KEY` if the target project differs from `VSLO`
- set `E2E_YOUTRACK_MCP_WIRE_PROTOCOL=content-length` only when using a Content-Length framed MCP server; the local wrapper defaults to line-delimited JSON-RPC

When `E2E_DEN_AUTH_JSON` is provided, the live spec treats it as authoritative and does not replace loopback Den auth from the desktop snapshot. This allows a Coding Agent run to point the real desktop UI at a locally started Den instance whose projector uses the local YouTrack MCP wrapper.

Run from `packages/e2e`:

```bash
E2E_LIVE_FEEDBACK_YOUTRACK=1 E2E_USE_EXISTING_PROFILE=1 pnpm test:feedback-youtrack-live
```

The live spec disables WebdriverIO spec retries while `E2E_LIVE_FEEDBACK_YOUTRACK=1` is set so a transient failure does not create duplicate YouTrack issues. It writes the latest run metadata to `packages/e2e/.tmp-live-feedback-youtrack/latest.json`.

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

- using `packages/web`, `pnpm -w dev:ui`, `@neatech/veslo-ui dev`, or raw Vite as proof that the app works
- claiming Tauri behavior based only on `vite` dev server checks
- changing `packages/server/src` without rebuilding the binary that orchestrator actually runs
- running only broad tests when a targeted script exists for the changed behavior
