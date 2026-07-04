---
title: VSLO-235 Local Veslo Host Lifecycle KISS Plan
date: 2026-07-02
status: complete
done: true
slice_1_status_model_done: true
slice_2_pilot_regression_done: true
slice_3_engine_stop_decision_done: true
source_issue: Veslo server unavailable after desktop startup; stabilize local host lifecycle
---

# VSLO-235 Local Veslo Host Lifecycle KISS Plan

## Goal

Keep the desktop-owned local Veslo host understandable and recoverable during
cold start, no-workspace startup, port contention, and child-process exit.

This is a narrow follow-up to the old VSLO-235 report. The current app no
longer needs the original broad "rewrite local host lifecycle" proposal. The
small useful slice is:

- expose a precise local host lifecycle/status reason,
- prove no-workspace startup and recovery with Tauri-pilot,
- decide whether `engine_stop` should stop only engines or the whole local
  runtime.

## Current Snapshot

Already covered in current source:

- Desktop local Veslo host defaults to `127.0.0.1:8787`.
- `/health` works without a workspace.
- `/status` can report `workspace: null` and `workspaceCount: 0`.
- App startup has a clean-profile `app-service` ensure path.
- Local request storm mitigation exists at the Veslo transport boundary.
- Managed-AI routing now separates UI loopback URL from WSL engine-reachable
  URL.

Resolved in this KISS slice:

- The app/native surface now exposes structured local host lifecycle status and
  reason.
- Port contention is visible as `blocked/port_unavailable`.
- Child exit is visible as `exited/child_exited` and can recover through
  explicit `veslo_server_restart`.
- Current cold-start coverage is Tauri-pilot based and does not rely on the
  legacy WDIO startup spec.
- `engine_stop` is intentionally treated as "stop local runtime", so it keeps
  stopping the Veslo host and clearing persisted host state.

## Non-Goals

- Do not switch the normal desktop bind from `127.0.0.1` to `0.0.0.0`.
- Do not add dynamic port fallback outside E2E harnesses.
- Do not build a new global supervisor or request scheduler.
- Do not restart the local host on every transient `/health` failure.
- Do not split `engine_stop` semantics in this KISS slice; the recorded decision
  is that it stops the whole local runtime.
- Do not treat "no workspace" as an error.

## Slice 1: Local Host Status And Reason

Status: implemented and validated

Add an additive status/reason surface without rewriting process ownership.

Implementation shape:

- Extend desktop `VesloServerInfo` with optional fields such as:
  - `lifecycleStatus`: `stopped`, `starting`, `running`, `exited`, `blocked`
  - `lifecycleReason`: `none`, `spawn_pending`, `port_unavailable`,
    `child_exited`, `health_unreachable`, `token_missing`
- Keep existing `running`, URLs, tokens, pid, stdout, and stderr fields
  unchanged for compatibility.
- Set `blocked/port_unavailable` when fixed-port bind fails.
- Set `exited/child_exited` when the supervised child terminates.
- Let the app derive `ready_no_workspace` versus `ready_with_workspace` from a
  successful `/status` response instead of asking Tauri to own workspace
  business state.
- Keep current status hysteresis for transient socket failures.

Acceptance:

- Cold start without workspaces can show a non-error ready state after
  `/health` and `/status` succeed.
- Port contention can be surfaced as a specific blocked reason.
- Child exit can be distinguished from generic connection refused.
- Existing consumers that only read `running` continue to work.

Implementation notes:

- Added `lifecycleStatus` and `lifecycleReason` to `veslo_server_info`.
- Preserved the existing `running` field and URL/token fields.
- `port_unavailable`, `spawn_failed`, `child_exited`, and
  `identity_mismatch` are now structured lifecycle reasons.
- Focused native, app, server, and Tauri-pilot validation passed.

## Slice 2: Tauri-Pilot Regression

Status: implemented and validated

Convert the useful old startup expectations into current desktop validation.

Scenarios:

- Cold start with no workspace:
  - launch a clean-profile desktop build,
  - wait for `veslo_server_info.running === true`,
  - assert `GET /health` succeeds,
  - assert authenticated `GET /status` returns `workspaceCount: 0` and
    `workspace: null`.
- Cold start with one local workspace:
  - launch with a registered local workspace,
  - assert `/health`, `/status`, and `/workspaces` succeed,
  - assert the active workspace is present.
- Port contention:
  - occupy the isolated E2E Veslo host port on `127.0.0.1`,
  - launch or trigger local host ensure,
  - assert a structured blocked reason, not a silent unavailable loop.
- Child exit after listen:
  - start desktop host,
  - terminate only the Veslo server child,
  - assert the app reports `exited/child_exited` and can recover on the next
    explicit ensure/restart.

Acceptance:

- New scenarios live under `packages/e2e/pilot-scenarios` or the existing
  tauri-pilot helper path.
- Legacy WDIO `veslo-server-startup.spec.ts` is not used as proof.
- Tests use the desktop preflight/cleanup rules from `packages/desktop/AGENTS.md`.

Current status:

- `vslo-235-local-host-no-workspace` Tauri-pilot scenario exists and passed
  against a rebuilt E2E debug binary.
- `vslo-235-local-host-with-workspace` Tauri-pilot scenario exists and passed
  against the rebuilt E2E debug binary.
- `vslo-235-local-host-port-contention` Tauri-pilot scenario exists and passed.
  The runner holds a random local E2E port and injects it through
  `E2E_VESLO_SERVER_PORT`, so normal pilot runs still get isolated free ports.
- `vslo-235-local-host-child-exit` Tauri-pilot scenario exists and passed. It
  uses a debug+`e2e` gated Tauri command to kill only the Veslo server child,
  then asserts `exited/child_exited`, calls `veslo_server_restart`, and verifies
  `/health` plus authenticated `/status` after recovery.
- The child-exit command is compiled only for debug builds with the `e2e`
  feature, matching the Tauri-pilot plugin gate. It is not part of release
  runtime behavior.

## Slice 3: Engine Stop Product Decision

Status: decided and closed

Current code stops the Veslo host as part of `engine_stop`. This conflicts with
the strict reading of the old VSLO-235 text, but it may match a user-visible
"stop local runtime" action.

Decision options:

- Option A: `engine_stop` means stop the whole local runtime.
  - Keep current behavior.
  - Rename/copy UI text if needed so users understand the Veslo host also stops.
- Option B: `engine_stop` means stop only OpenCode/orchestrator/router engines.
  - Leave Veslo host running.
  - Add a separate "stop local host" command if a full shutdown is needed.
- Option C: split commands.
  - Keep a destructive "disconnect local runtime" path.
  - Add a narrower "reload/stop engine" path that does not kill Veslo host.

Decision: Option A.

For this KISS closure, `engine_stop` means stop the whole local runtime. The
existing behavior is intentionally kept:

- stop orchestrator,
- stop OpenCode engine,
- stop Veslo local host,
- clear persisted Veslo host state,
- stop OpenCode router.

Rationale: splitting this now would add a second runtime ownership model and a
new user-facing distinction that the current UI does not expose cleanly. The
stable-host guarantee is covered by normal startup, workspace attach/restart,
and explicit `veslo_server_restart` recovery. A future product pass can still
add a narrower "stop engine only" command, but that is not needed to close the
old VSLO-235 lifecycle failure.

## Validation

Focused validation before marking any slice done:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-local-veslo-server-ensure.test.ts src/app/tests/app-veslo-server-state-stability.test.ts src/app/tests/lib/veslo-server-status-stability.test.ts src/app/tests/lib/veslo-server-request-broker.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/app-send-preflight-context.test.ts
bun test packages/server/src/routes/health.ts packages/server/src/tests/server.health-status-routes.test.ts packages/server/src/tests/server.workspaces-crud.test.ts packages/server/src/tests/workspaces.test.ts
cargo test veslo_server::spawn::tests --quiet
cargo test veslo_server::tests --quiet
cargo test commands::veslo_server::tests --quiet
git diff --check
```

Desktop acceptance before closing Slice 2:

```powershell
pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario <new-vslo-235-scenario>
```

Validation completed for Slice 1 and the no-workspace pilot scenario on
2026-07-02:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::manager::tests --quiet
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-local-veslo-server-ensure.test.ts src/app/tests/app-veslo-server-state-stability.test.ts src/app/tests/lib/veslo-server-host.test.ts src/app/tests/lib/veslo-server-status-stability.test.ts
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::spawn::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
bun test packages/server/src/routes/health.ts packages/server/src/tests/server.health-status-routes.test.ts packages/server/src/tests/server.workspaces-crud.test.ts packages/server/src/tests/workspaces.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-no-workspace
```

Result:

- Native lifecycle manager tests: `3 pass`, `0 fail`.
- App focused tests: `14 pass`, `0 fail`.
- E2E runner unit tests: `13 pass`, `0 fail`.
- Native spawn/server/command subsets: `20 pass`, `38 pass`, `18 pass`.
- Server route/workspace tests: `28 pass`, `0 fail`.
- App typecheck passed.
- E2E debug Tauri build passed.
- `vslo-235-local-host-no-workspace` Tauri-pilot scenario passed:
  `2 passed`, `0 failed`.

Validation completed for the additional Slice 2 pilots on 2026-07-02:

```powershell
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-no-workspace
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-with-workspace
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-port-contention
pnpm --filter @neatech/veslo-e2e exec tsc --noEmit
git diff --check -- packages/e2e/helpers/pilot-runner.ts packages/e2e/helpers/pilot-runner.test.ts packages/e2e/pilot-scenarios/vslo-235-local-host-no-workspace.toml packages/e2e/pilot-scenarios/vslo-235-local-host-with-workspace.toml packages/e2e/pilot-scenarios/vslo-235-local-host-port-contention.toml docs/plans/2026-07-02-vslo-235-local-host-lifecycle-kiss-plan.md
```

Result:

- E2E runner unit tests: `14 pass`, `0 fail`.
- `vslo-235-local-host-no-workspace` Tauri-pilot scenario re-run passed:
  `2 passed`, `0 failed`.
- `vslo-235-local-host-with-workspace` Tauri-pilot scenario passed:
  `2 passed`, `0 failed`.
- `vslo-235-local-host-port-contention` Tauri-pilot scenario passed:
  `2 passed`, `0 failed`.
- E2E TypeScript check passed.
- Scoped `git diff --check` passed with only Windows LF-to-CRLF warnings.

Validation completed for final Slice 2 and Slice 3 closure on 2026-07-03:

```powershell
cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml --features e2e --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::manager::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-child-exit
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-no-workspace
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-with-workspace
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-port-contention
pnpm --filter @neatech/veslo-e2e exec tsc --noEmit
git diff --check -- packages/desktop/src-tauri/src/commands/veslo_server.rs packages/desktop/src-tauri/src/lib.rs packages/e2e/helpers/app-launcher.ts packages/e2e/helpers/pilot-runner.ts packages/e2e/helpers/pilot-runner.test.ts packages/e2e/pilot-scenarios/vslo-235-local-host-no-workspace.toml packages/e2e/pilot-scenarios/vslo-235-local-host-with-workspace.toml packages/e2e/pilot-scenarios/vslo-235-local-host-port-contention.toml packages/e2e/pilot-scenarios/vslo-235-local-host-child-exit.toml docs/plans/2026-07-02-vslo-235-local-host-lifecycle-kiss-plan.md packages/app/src/app/lib/tauri.ts packages/desktop/src-tauri/src/types.rs packages/desktop/src-tauri/src/veslo_server/manager.rs packages/desktop/src-tauri/src/veslo_server/mod.rs
```

Result:

- `cargo check --features e2e` passed; existing warnings only.
- Native lifecycle manager tests: `3 pass`, `0 fail`.
- Native Veslo server command tests: `18 pass`, `0 fail`.
- E2E debug Tauri build passed and rebuilt
  `packages/desktop/src-tauri/target/debug/veslo.exe`.
- E2E runner unit tests: `14 pass`, `0 fail`.
- `vslo-235-local-host-child-exit` Tauri-pilot scenario passed:
  `6 passed`, `0 failed`.
- `vslo-235-local-host-no-workspace` Tauri-pilot scenario passed:
  `2 passed`, `0 failed`.
- `vslo-235-local-host-with-workspace` Tauri-pilot scenario passed:
  `2 passed`, `0 failed`.
- `vslo-235-local-host-port-contention` Tauri-pilot scenario passed:
  `2 passed`, `0 failed`.
- E2E TypeScript check passed.
- Scoped `git diff --check` passed with only Windows LF-to-CRLF warnings.
- Post-E2E runtime process check found no lingering `veslo*`, `bun*`, or
  `tauri*` processes.

## Done Criteria

- `slice_1_status_model_done: true` only after app/native status fields,
  mappings, and focused tests pass.
- `slice_2_pilot_regression_done: true` only after the Tauri-pilot scenarios
  pass on a real desktop build.
- `slice_3_engine_stop_decision_done: true` only after the product decision is
  recorded and the code either remains intentionally unchanged or is updated.
- Top-level `done: true` only when all non-deferred slices above are complete.
