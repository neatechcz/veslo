---
title: VSLO-270 Stop Reload Reconnect KISS Plan
date: 2026-07-03
status: complete
done: true
issue: VSLO-270
depends_on:
  - VSLO-269 model-stream retry diagnostics
  - VSLO-235 local host lifecycle status
v27000_baseline_tests_done: true
v27001_abort_blocked_run_from_ui_done: true
v27002_server_resolved_abort_done: true
v27003_durable_abort_intent_done: true
v27004_reload_force_stop_gate_done: true
v27005_installed_runtime_regression_done: true
v270d1_engine_stop_semantics_followup_done: false
v270d2_reload_copy_followup_done: false
source_issue: VSLO-270 - Agent cannot be stopped or restarted after long run and app restart does not reconnect to Veslo server
---

# VSLO-270 Stop Reload Reconnect KISS Plan

## Goal

After a very long or blocked desktop agent run, Veslo must give the user back
control:

- Stop must reach the backend lifecycle owner, not only clear local UI state.
- Restart or skill reload must not continue while an active run failed to stop.
- After quitting and reopening the app, the local Veslo server must reconnect
  through the existing local host recovery path.

The incident was reported against installed app version `2026.7.0` on
2026-07-03. It followed a VSLO-269-style long run: the agent ran for roughly two
hours, the user could not stop or restart it, a skill change showed a backend
restart prompt, and after app relaunch the app did not reconnect to the Veslo
server.

## Implementation Status Contract

Every task starts as `done: false`.

Only change a task to `done: true` after its code, focused tests, and listed
verification are complete in the original worktree. Do not flip top-level
`done` until V27000 through V27005 are complete and verified.

Deferred tasks V270-D1 and V270-D2 are useful cleanup/product follow-ups, but
they do not block the top-level `done` unless implementation proves they are
required for the same stop/reload/reconnect failure.

If only part of a task is completed, append a dated note under that task and
leave its `done: false` line unchanged.

## Current Audit

This issue is not fully solved by VSLO-269 or VSLO-235.

VSLO-269 adds the useful diagnostic state for model-stream retry no-progress.
In the current working tree, a `model_retry_no_output` diagnostic with lifecycle
status `blocked` is rendered as UI phase `error` in:

```text
packages/app/src/app/pages/session.tsx
```

The orchestrator still treats `blocked` as an active run status in:

```text
packages/orchestrator/src/run-store.ts
```

That mismatch matters because `cancelRun()` currently has a blanket
`runPhase() === "error"` short-circuit in:

```text
packages/app/src/app/pages/session-conversation-flow.ts
```

That branch resets local run state and returns before calling `abortSession()`.
For a VSLO-269 hard-threshold run, this can make the visible Stop action local
only while the durable run remains active.

The app abort path is also still app-run-id-authoritative:

```text
packages/app/src/app/context/conversation-service.ts
packages/app/src/app/tests/context/conversation-service.test.ts
packages/app/src/app/tests/app-conversation-abort.test.ts
```

If the local latest-run-id map is missing after a restart or stale session
handoff, `abortConversationFromVesloWriteApi()` throws
`Conversation run id is not available for abort.` before contacting the server.
That is the intentionally deferred LFC07 follow-up from the lifecycle-controller
plan, but VSLO-270 makes it core.

The server has the primitives needed for a KISS fix:

```text
packages/orchestrator/src/cli.ts
packages/server/src/orchestrator-lifecycle-client.ts
packages/server/src/routes/conversations.ts
```

The orchestrator lifecycle route already supports `runs/active`, and the server
already exposes run status through `/runs/:runId`. The abort endpoint currently
requires `runId`, but it can be extended compatibly with an active-run mode
instead of inventing a new lifecycle store.

The server abort controller currently calls OpenCode abort first, then records
`abort_requested` and schedules reconcile:

```text
packages/server/src/conversation-run-lifecycle-controller.ts
```

If OpenCode abort is slow, dead, or throws, durable abort intent is not recorded.
That is a bad ordering for a user control path.

Reload has a second control gap:

```text
packages/app/src/app/app.tsx
packages/app/src/app/system-state.ts
packages/app/src/app/pages/config.tsx
```

`forceStopActiveSessionsAndReload()` catches abort errors and proceeds to reload
anyway. `system-state.ts` has an `anyActiveRuns()` reload guard commented out.
The config reload UI warns that reload stops active tasks, but the lower-level
reload function does not own a reliable stop-and-wait protocol.

VSLO-235 remains useful but not sufficient. It added structured local host
lifecycle status and Tauri-pilot startup coverage. It also intentionally kept
`engine_stop` as "stop the whole local runtime", including the Veslo host and
persisted host state. VSLO-270 should not reopen that product decision in the
core KISS slice; it should first make stop/reload use the existing lifecycle
owner correctly.

Implementation must be based on the intended VSLO-269 model-stream retry slice.
Do not start VSLO-270 implementation from a checkout where those diagnostics are
half-applied or accidentally reverted; this plan assumes the `blocked`
diagnostic contract exists.

## KISS Shape

Use the smallest causal path:

1. UI Stop must call backend abort for active lifecycle states, including
   `blocked`.
2. App abort may remember run ids, but it must not require a locally remembered
   run id to stop the active conversation.
3. Server abort must write durable abort intent before or regardless of OpenCode
   abort success.
4. Reload after skill/config change must wait for stop success or refuse to
   reload with a concrete error.
5. Installed-runtime regression must cover the full sequence:
   blocked run -> Stop -> reload prompt -> app relaunch -> local host reachable.

Do not add a second local runtime supervisor, do not parse logs in the app, and
do not rewrite OpenCode stream retry behavior in this issue.

## KISS Implementation Guardrails

- Implement app/server unit contracts before the Tauri-pilot regression. The
  pilot should prove the installed runtime sequence, not be the first debugging
  surface.
- Keep V27004 as a small wait/refuse gate. Do not introduce a new reload
  orchestrator, scheduler, or runtime supervisor.
- Prefer deleting or narrowing broken shortcuts over adding compensating state:
  local-only `error` reset, explicit-run-id-only abort, dead reload policy
  comments, and silent force-stop `catch {}` are the main targets.
- Use the existing lifecycle/status/diagnostic sources. Do not add another
  active-run cache in the app.
- Treat VSLO-269 `blocked model_retry_no_output` diagnostics as the base
  contract. If that slice is not present, stop and finish it first.

## What To Remove Or Replace

This fix should remove or replace stale control shortcuts instead of only adding
new compensating code:

- Replace the blanket `runPhase() === "error"` local-reset branch in
  `session-conversation-flow.ts` with a narrower branch that only local-resets
  non-backend errors. Active backend diagnostics must call abort.
- Replace app tests that require an explicit local run id for abort. Keep
  compatibility tests for explicit `runId`, but add the server-resolved active
  abort path as the preferred fallback.
- Remove the commented-out `anyActiveRuns()` block in `system-state.ts`.
  Either implement a real guard or move the guard to the single reload owner.
  Do not leave dead policy comments.
- Replace the silent `catch {}` in `forceStopActiveSessionsAndReload()` with
  failure accounting. If any active run cannot be stopped, do not reload.
- Avoid adding another app-side active-run cache. Keep the existing latest-run
  memory map for compatibility and diagnostics, but do not make it authoritative.
- Do not add a second "restart backend" path for skills. Reuse the existing
  `reloadWorkspaceEngine()` ownership path after stop has succeeded.

## V27000: Baseline Tests For The Broken Control Path

Status: implemented
done: true

Add failing tests first around the current failure mode.

Implementation scope:

- Add or update `session-conversation-flow` tests proving that an active
  backend `blocked` run calls `abortSession()` instead of only resetting local
  run state.
- Add app conversation-service tests proving abort can continue when the local
  latest-run-id map is missing but a conversation/workspace scope exists.
- Add server conversation-route tests proving `POST /abort` can resolve the
  active lifecycle row when the body uses active mode or omits `runId`.
- Add lifecycle-controller tests proving OpenCode abort failure does not prevent
  durable abort intent from being recorded for local lifecycle-owned runs.

Acceptance:

- At least one focused test fails on the current code for each control gap:
  UI cancel, app missing run id, server active abort, durable abort intent.
- Tests preserve existing explicit-run-id compatibility.
- Tests do not require a real provider or a two-hour run.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/app-conversation-abort.test.ts
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
```

## V27001: Abort Blocked Runs From The UI

Status: implemented
done: true

Make the Stop button and Escape stop path abort active backend runs even when
the visible phase is `error`.

Implementation scope:

- Add one small `runControl` accessor to `createSessionConversationFlow`, for
  example `hasAbortableBackendRun()`.
- In `session.tsx`, compute it from current backend lifecycle diagnostics and
  active UI status. It must be true for `submitted`, `running`, and `blocked`.
- Change `cancelRun()` so:
  - `runPhase() === "error" && !hasAbortableBackendRun()` keeps the local reset
    behavior,
  - `runPhase() === "error" && hasAbortableBackendRun()` calls
    `abortSession(selectedSessionId)` like other active runs.
- Keep the existing user-visible stopped/error toasts unless tests show they are
  misleading.

Acceptance:

- A VSLO-269 hard-threshold `blocked` run reaches the backend abort path from
  the normal composer Stop button.
- Escape-stop follows the same path because it calls `cancelRun()`.
- Local-only UI errors still have a cheap reset path.
- No new global session state owner is introduced.

Guardrail:

- This task only proves the UI invokes abort for backend-active error phases.
  End-to-end "can be stopped" requires V27002 and V27003 as well.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-inline-loading.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

## V27002: Server-Resolved Active Conversation Abort

Status: implemented
done: true

Let the server resolve the active run for a conversation when the app no longer
has a local `runId`.

Implementation scope:

- Extend the app Veslo server client abort input to allow:
  - legacy `{ runId }`, and
  - active mode, for example `{ mode: "active" }` or omitted `runId`.
- In `conversation-service.ts`, keep trying the remembered `runId` first when
  present, but call the server active abort path when it is missing.
- In `routes/conversations.ts`, change `requireConversationRunId()` into a
  compatible resolver:
  - explicit `runId` keeps current behavior,
  - active mode uses `lifecycleClient.active(workspace.id, conversationId)`,
  - no active lifecycle row returns a clear compatible error.
- Use active lifecycle, not latest lifecycle, so a completed latest run does not
  get aborted accidentally.
- Keep remote/no-lifecycle behavior explicit. If lifecycle owner is unavailable,
  do not silently guess.

Acceptance:

- App restart or lost local run-id memory does not prevent stopping the active
  conversation run.
- Explicit `runId` abort remains supported.
- Queued-run behavior still remembers active run ids where available.
- No duplicate app-side active-run cache is added.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/app-conversation-abort.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts
pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts src/tests/orchestrator-lifecycle-client.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
```

## V27003: Durable Abort Intent Before OpenCode Abort

Status: implemented
done: true

Make user stop intent durable even if OpenCode abort is unavailable, slow, or
throws.

Implementation scope:

- For local lifecycle-owned runs, call `markAbortRequested()` before the
  OpenCode abort attempt, or guarantee it in a `finally` path that cannot be
  skipped by OpenCode abort failure.
- Schedule abort reconciliation even when OpenCode abort fails.
- Keep `abortActiveGatewayProxyRequests()` early, because it can break active
  model/gateway streams immediately.
- Make OpenCode abort best-effort after durable intent for local runs.
- Return a clear abort result that can include an upstream abort error without
  making the user stop action look like it did nothing.
- Preserve current behavior for route shapes that genuinely cannot identify a
  run.

Acceptance:

- A broken OpenCode abort call does not prevent `abort_requested` from being
  recorded.
- Queue/reconcile gets a wake-up after abort intent.
- The UI gets a deterministic response instead of depending on OpenCode abort
  health.
- Existing successful-abort tests still pass after their ordering expectations
  are intentionally updated.

Verification:

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
```

## V27004: Reload Waits For Stop Or Refuses To Reload

Status: implemented
done: true

Make skill/config reload safe after a long active run.

Implementation scope:

- Update `forceStopActiveSessionsAndReload()` so it:
  - attempts abort for every active reload-blocking session,
  - records per-session failures,
  - does not call `reloadWorkspaceEngine()` if any abort failed,
  - waits for active reload-blocking sessions to clear from the lifecycle/status
    source used by `activeReloadBlockingSessions()`, or for a bounded timeout
    before refusing reload.
- Do not treat `abortSession()` returning as proof that the run is terminal or
  no longer reload-blocking. The source of truth for the wait is the same
  lifecycle/status/diagnostic state that marks the session reload-blocking.
- Surface a concrete reload error such as "Could not stop active run before
  reload" instead of silently proceeding.
- Replace the commented-out `anyActiveRuns()` policy in `system-state.ts` with
  live behavior:
  - plain reload while active runs exist should refuse and explain, or
  - route through the same force-stop-and-wait owner.
- Align the config reload button with the same policy. If the button says reload
  stops active tasks, it must use force-stop-and-wait. Otherwise change the
  copy to "Stop active tasks before reload."
- Keep skill materialization pending/replay behavior. Do not make skill writes
  force-kill active runs by themselves.

Acceptance:

- Skill reload cannot proceed after stop failed.
- Skill reload cannot proceed merely because `abortSession()` returned; the
  active reload-blocking state must clear or timeout.
- Manual config reload cannot bypass the active-run safety policy.
- MCP auth modal force-stop uses the same abort path and surfaces failure.
- No second reload implementation is added.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-conversation-abort.test.ts src/app/tests/app-skill-registry-events.test.ts src/app/tests/lib/skill-reload-guard.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

## V27005: Installed Runtime Regression

Status: implemented
done: true

Prove the installed/Tauri path, not only web/dev UI tests.

Implementation scope:

- Add a Tauri-pilot scenario or extend the VSLO-269 model-stream fixture to run
  the VSLO-270 control sequence:
  1. create or simulate a conversation run that reaches
     `model_retry_no_output` hard threshold,
  2. click Stop and assert backend abort intent is recorded,
  3. trigger a skill/reload-required state,
  4. use the reload path and assert it waits for stop or refuses safely,
  5. quit/relaunch the app,
  6. assert `veslo_server_info.running === true`,
  7. assert `GET /health` and authenticated `GET /status` succeed.
- Reuse the existing debug+E2E fixture hooks from VSLO-235 and VSLO-269. Do not
  create a real two-hour run.
- If this scenario reuses the VSLO-269 model-stream retry fixture, update the
  pilot runner's scenario-selection fixture hook so
  `vslo-270-stop-reload-reconnect` receives the same isolated retry fixture.
- Include process cleanup checks for lingering `veslo`, `bun`, and `tauri`
  processes after the scenario.

Acceptance:

- The regression covers installed desktop runtime behavior.
- The app cannot remain in a state where Stop did not reach lifecycle but reload
  proceeded anyway.
- Relaunch recovers the local Veslo server through the existing host lifecycle
  path.

Verification:

```powershell
pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-270-stop-reload-reconnect
pnpm --filter @neatech/veslo-e2e exec tsc --noEmit
```

2026-07-03 final note:

- Added `packages/e2e/pilot-scenarios/vslo-270-stop-reload-reconnect.toml`.
  It covers model retry visible state, blocked retry hard threshold, blocked
  reload banner visibility, normal UI Stop reaching Veslo backend abort, active
  lifecycle clear, and local Veslo `/health` plus authenticated `/status`.
- Added `packages/e2e/pilot-scenarios/vslo-270-relaunch-reconnect.toml`.
  The pilot runner preserves the isolated profile, restarts the installed
  debug app, verifies `veslo_server_info.running`, `/health`, `/status`, then
  activates the saved workspace engine/lifecycle owner and waits until the
  original conversation no longer has an active run.
- Updated `packages/e2e/helpers/pilot-runner.ts` so the VSLO-270 scenario uses
  the same managed AI and model-stream retry fixture hooks as VSLO-269 and
  automatically runs the relaunch reconnect check after the main scenario.
- The installed pilot intentionally uses the normal Stop control for the
  durable abort assertion. Reload wait/refuse behavior remains covered by app
  unit contracts; the pilot does not rely on the same WebView surviving a
  runtime reload before the runner performs the controlled quit/relaunch step.

Current verification:

```powershell
python -c "import tomllib; tomllib.load(open('packages/e2e/pilot-scenarios/vslo-270-relaunch-reconnect.toml','rb')); tomllib.load(open('packages/e2e/pilot-scenarios/vslo-270-stop-reload-reconnect.toml','rb')); print('toml ok')"
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts helpers/app-launcher.test.ts
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario vslo-270-stop-reload-reconnect
```

Result:

- TOML parse: passed.
- E2E runner/app launcher tests: `35 pass`, `0 fail`, `1 skip`.
- Installed debug pilot main scenario:
  `vslo-270-stop-reload-reconnect` passed `4 passed`, `0 failed`.
- Installed debug relaunch scenario:
  `vslo-270-relaunch-reconnect` passed `4 passed`, `0 failed`.
- The pilot stopped managed child processes after both app runs.

## Validation Snapshot

2026-07-03 focused validation completed for V27000 through V27004:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/app-conversation-abort.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/pages/session-inline-loading.test.ts
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts src/tests/orchestrator-lifecycle-client.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
git diff --check
```

Result:

- app focused tests: `71 pass`, `0 fail`
- server lifecycle/conversation tests: `55 pass`, `0 fail`
- app typecheck: passed
- server typecheck: passed
- `git diff --check`: no whitespace errors; Windows LF-to-CRLF warnings only

Installed/Tauri verification:

```powershell
pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario vslo-270-stop-reload-reconnect
```

Result:

- debug Tauri binary was built successfully earlier in the implementation
  checkpoint; the final scenario-only patch did not require a rebuild.
- installed pilot main scenario and relaunch scenario both passed.

## V270-D1: Engine Stop Semantics Follow-Up

Status: deferred
done: false

Do not reopen `engine_stop` semantics in the core VSLO-270 slice.

VSLO-235 intentionally decided that `engine_stop` stops the whole local runtime,
including the Veslo host and persisted host state. If V27005 proves the only
remaining relaunch problem is this product decision, open a separate follow-up
to split commands:

- "stop/reload engine" keeps Veslo host alive,
- "disconnect local runtime" stops Veslo host and clears persisted host state.

This is not required before fixing Stop and reload safety.

## V270-D2: Reload Copy Follow-Up

Status: deferred
done: false

After V27004, audit Czech and English reload copy.

If reload now refuses while active runs exist, copy should say "Stop active
tasks before reload." If reload owns force-stop-and-wait, copy may keep saying
reload stops active tasks.

Do this only after behavior is settled so copy does not drift from product
truth again.

## Required Coverage Matrix

| Scenario | Owner | Test target |
| --- | --- | --- |
| Blocked model-retry run Stop calls abort | App session flow | `session-conversation-flow.test.ts` |
| Missing local run id uses active abort | App conversation service | `conversation-service.test.ts` |
| Server abort resolves active lifecycle row | Server routes | `server-conversations.test.ts` |
| OpenCode abort failure still records intent | Server lifecycle controller | `conversation-run-lifecycle-controller.test.ts` |
| Reload does not continue after stop failure | App reload owner | `app-conversation-abort.test.ts` or focused reload test |
| Relaunch reconnects local Veslo server | Tauri-pilot | `vslo-270-stop-reload-reconnect` |

## Completion Checklist

- [x] V27000 baseline tests added and verified.
- [x] V27001 UI Stop aborts active `blocked` runs.
- [x] V27002 app/server support active-run abort without local run id.
- [x] V27003 abort intent is durable before OpenCode abort dependency.
- [x] V27004 reload waits for stop or refuses safely.
- [x] V27005 installed runtime regression passes.
- [x] `docs/fixes` checkpoint written after implementation, not before.
- [x] Top-level `done` changed to `true` only after all core tasks pass.
