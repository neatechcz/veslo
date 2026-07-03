# Fix 23: Runtime Cold Start Session Handoff Core Implementation

## Problem

The installed desktop path could keep the startup overlay open while
non-critical workspace hydration ran, then defer local engine startup until the
first send. On a cold first send with no selected session, the app could also
move from an optimistic pending conversation surface to a real session while the
runtime and transcript were still materializing.

Source plan:

```text
docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md
```

Issue link status:

```text
unlinked
```

This checkpoint records the KISS core implementation that was completed before
installed-runtime pilot validation was intentionally skipped.

## Implemented

- Moved updater environment detection and updater check scheduling out of the
  awaited startup hydration path.
- Published the local workspace shell before `workspaceVesloRead` and sidebar
  DB hydration complete; both now continue as bounded background hydration.
- Changed lazy local boot so onboarding completion and startup overlay close do
  not wait for sidebar DB hydration.
- Added active local workspace engine warmup after workspace identity is known.
- Reused the existing `ensureEngineForWorkspace` single-flight owner for boot
  warmup instead of adding a second warmup state system.
- Added narrow `ensureEngineForWorkspace` options so boot warmup can start and
  route the engine with `reason: "boot-warmup"` and `loadSessions: false`.
- Normalized local workspace paths for warmup stale checks and dedupe keys so
  Windows slash/case differences do not suppress the warmup.
- Preserved the optimistic pending conversation surface through pending-to-real
  session materialization by skipping the initial-anchor hide path during that
  handoff.
- Added focused app/source tests for non-blocking bootstrap, engine warmup, and
  pending session materialization.
- Added the Windows Tauri-pilot scenario scaffold for
  `runtime-cold-start-session-handoff`.
- Added runner/Rust support to disable debug dev autostart for that pilot
  scenario via `VESLO_DISABLE_DEV_AUTOSTART`.

## Not Claimed

- The installed Tauri-pilot scenario is not accepted as passed in this
  checkpoint. The user explicitly asked to skip further Tauri pilot testing for
  this slice.
- `RSH04` should remain verification-pending unless a later agent runs and
  passes `pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario
  runtime-cold-start-session-handoff`.
- `RSH00` remains open because no real YouTrack issue id was linked.

## Coverage

Run on 2026-07-03 before pilot validation was skipped:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-bootstrap-nonblocking.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-activation-local-source.test.ts src/app/tests/app-boot-engine-ready.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/app-startup-hydration.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/send-runtime-readiness.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-message-queue.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests::dev_autostart_disable_env_accepts_truthy_values
git diff --check -- packages/app/src/app/context/workspace.ts packages/app/src/app/context/workspace-runtime-controller.ts packages/app/src/app/tests/context/workspace-engine-warmup.test.ts packages/app/src/app/tests/context/workspace-runtime-controller-source.test.ts packages/e2e/helpers/pilot-runner.ts packages/e2e/helpers/pilot-runner.test.ts packages/e2e/pilot-scenarios/runtime-cold-start-session-handoff.toml packages/desktop/src-tauri/src/commands/engine.rs
```

Results recorded during the implementation slice:

- RSH01 bootstrap bundle passed: `32` tests.
- App startup hydration test passed: `6` tests.
- RSH02 warmup bundle passed: `35` tests.
- Pending-session source test passed: `21` tests.
- RSH03 session bundle passed: `110` tests.
- App typecheck passed.
- E2E runner tests passed: `19` tests.
- Rust dev-autostart env guard test passed.
- `git diff --check` passed for the touched runtime, pilot-runner, and Rust
  files.

## Status

Core implementation is complete for RSH01 through RSH03 and the RSH04 scenario
scaffold exists. Final installed-runtime acceptance is intentionally left open
because the Tauri-pilot pass was skipped. The plan top-level `done` flag should
stay false until RSH00 is linked and RSH04 is verified or explicitly waived.
