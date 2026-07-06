---
title: Windows Idle Runtime Chain Recovery Implementation Plan
date: 2026-07-05
status: draft
done: false
issue: VSLO-271
source_issue: Windows installed app v2026.7.0 shows Send failed after idle because local runtime chain does not recover
related_issues:
  - VSLO-235 local host lifecycle / recovery
  - VSLO-270 long run stop/reload/reconnect
  - VSLO-230 sidebar/session retest blocked by runtime failure
---

# Windows Idle Runtime Chain Recovery Implementation Plan

## Goal

done: false

After the Windows installed app is left idle, both new-chat and existing-chat
send must either keep working or recover the whole local runtime chain without
requiring an app restart.

The local runtime chain is not ready just because `veslo-server` answers
`/health`. The ready state for this issue is:

- `veslo-server` is reachable,
- the orchestrator daemon state points to a live daemon,
- the shared unsandboxed OpenCode engine is HTTP/socket usable,
- workspace OpenCode proxy/event requests can reach the active engine,
- send-time failures surface structured local-runtime diagnostics instead of
  only `Send failed`.

## Incident Evidence To Preserve

done: false

The reported failing run was Windows desktop `v2026.7.0`, installed app, shared
unsandboxed runtime mode.

Observed handles:

- `GET /health 200`, `GET /workspaces 200`, and workspace config calls
  succeeded before send failure.
- The same desktop debug spool ended with:
  `[veslo-orchestrator-router] Daemon shutting down`.
- Runtime trace included `orchestrator:proxy-upstream:error` for
  `/workspace/ws-a8ead853a90f/opencode/event` with
  `engineTopology=shared-unsandboxed`,
  `targetBaseUrl=http://127.0.0.1:53553`, and error text
  `The socket connection was closed unexpectedly`.
- After app restart, `http://127.0.0.1:8787/health` returned OK and
  `veslo.exe` plus `veslo-server.exe` were running, but no
  `veslo-orchestrator.exe`, `veslo-code-router.exe`, or `veslo-code.exe`
  process was running.
- `veslo-orchestrator-state.json` still contained stale daemon state:
  `pid=67656`, `port=52008`,
  `baseUrl=http://127.0.0.1:52008`.
- Manual daemon status returned:
  `{ "ok": false, "error": "orchestrator daemon is not running" }`.
- Manual daemon recovery failed with:
  `Unable to connect. Is the computer able to access the url?`.

## Current Audit

done: false

This is not a composer-only failure. The current code allows multiple parts of
the runtime to disagree about readiness:

- `packages/server/src/routes/health.ts` reports only Veslo server process
  health. It does not verify orchestrator, router, or OpenCode engine health.
  Existing server `/status` also lacks a runtime-chain contract, so consumers
  cannot distinguish `server_running` from `runtime_chain_ready`.
- `packages/desktop/src-tauri/src/veslo_server/mod.rs` can recover persisted
  `veslo-server` info from `/health` alone. The recovered info does not prove
  the server was launched with a live `orchestratorDaemonUrl`. The in-memory
  `VesloServerState` already tracks `opencode_base_url`,
  `orchestrator_daemon_url`, and `orchestrator_lifecycle_token`, but
  `PersistedVesloServerState` does not persist that launch-chain metadata.
- `packages/orchestrator/src/cli.ts` saves daemon state in
  `veslo-orchestrator-state.json` and clears it on graceful shutdown, but stale
  state can remain even after the log line `Daemon shutting down`: current
  shutdown clears and saves the daemon field only after `pool.killAll()` and
  `sharedOpenCodeEngine.dispose()`, so a cleanup error can leave stale state
  behind.
- The orchestrator `POST /shutdown` path and signal handlers do not record a
  caller/reason. The incident has a shutdown log but no attribution for whether
  it came from app exit, engine restart, reload, updater, idle policy, signal,
  or an external caller.
- `packages/desktop/src-tauri/src/orchestrator/mod.rs` can resolve stale daemon
  state as `running: false`, but
  `packages/desktop/src-tauri/src/commands/orchestrator.rs` still returns
  `status.daemon.base_url` without requiring `status.running`.
- `packages/orchestrator/src/shared-opencode-engine.ts` treats a shared engine
  as running primarily by process/PID. It waits for HTTP health at startup but
  does not maintain the same ongoing HTTP health contract as the pooled engine.
- `packages/orchestrator/src/cli.ts` logs `orchestrator:proxy-upstream:error`
  but does not mark the shared engine unhealthy or force a restart after socket
  close / upstream connection failures.
- `packages/app/src/app/context/send-runtime-readiness.ts` performs a GET
  preflight health check, while the actual failure can occur later on the
  event/send path.
- `packages/app/src/app/context/veslo-server-connection.ts` can mark the local
  server connected from `/health` plus `/capabilities`. That is server
  reachability, not proof that the orchestrator/OpenCode runtime chain is
  ready.
- `packages/app/src/app/pages/session-send-workflow.ts` records send failure
  after the run call fails. `packages/app/src/app/components/session/message-list.tsx`
  still renders the pending submit label as generic `Send failed`.
- `packages/app/src/app/context/session-event-stream.ts` and
  `packages/desktop/src-tauri/src/commands/engine_sse.rs` can reconnect to the
  same dead event endpoint after `/opencode/event` failures. The incident
  evidence was an event-stream upstream failure, not only a prompt submit
  failure.
- Server-side conversation queue admission has `clientMessageId` dedupe for
  queued runs, but a direct submitted active run is not identified by
  `clientMessageId` through the lifecycle `active` response. A send retry must
  prove idempotence for both queued and already-submitted timing windows.

## Non-Goals

done: false

- Do not build a new global runtime supervisor.
- Do not change the product decision that `engine_stop` stops the whole local
  runtime.
- Do not rewrite the OpenCode proxy/router architecture.
- Do not add log parsing in the app as the recovery mechanism.
- Do not add a second readiness model beside the existing desktop/server/
  orchestrator lifecycle owners.
- Do not add a new background scheduler when an existing timer, lifecycle owner,
  or queue owner can carry the work.
- Do not introduce a new endpoint only for diagnostics if an existing status or
  lifecycle surface can carry the same structured facts.
- Do not treat every transient `/health` miss as a full restart.
- Do not solve unrelated long-run abort semantics here unless a test proves it
  is required for this idle send failure.

## Implementation Status Contract

done: false

Every task starts with `done: false`.

Only flip a task to `done: true` after code, focused tests, and the listed
validation for that task pass in the original worktree. Do not flip top-level
`done` until WIR00 through WIR06 are complete.

If a task is partially implemented, append a dated note under that task and
leave its `done: false` line unchanged.

## KISS Shape

done: false

Fix the causal chain in order:

1. A recovered or green `veslo-server` must not imply the whole runtime chain is
   ready.
2. Send and event-stream failures must recover the runtime chain instead of
   retrying the same dead endpoint.
3. The shared unsandboxed OpenCode engine must be marked unhealthy when the
   proxy observes socket-level upstream failure.
4. Stale orchestrator daemon state must not be used as a live base URL.
5. Orchestrator shutdown must clear daemon state even when child cleanup fails,
   and shutdown logs must include caller/reason attribution.
6. The Windows installed-app regression must kill or stale each runtime layer
   and prove recovery or structured failure.

WIR03 and WIR05 are the primary send-failure path. WIR01 and WIR02 are still
real hardening work, but they should not block a smaller hotfix that proves
runtime-chain readiness and post-preflight/event recovery first.

## KISS Guardrails

done: false

Prefer removing false-ready states over adding compensating status layers.

- One state file should have one routine writer. Rust may refuse to use stale
  orchestrator state, but Node remains the normal writer of
  `veslo-orchestrator-state.json`.
- Reuse existing lifecycle surfaces before adding new ones:
  `orchestrator_status`, `veslo_server_info`, server `/status`, run lifecycle
  `active/status`, and existing send workflow traces.
- Server `/status` is the canonical app-visible runtime-chain status for this
  issue. Do not add an optional parallel status route.
- Add nullable fields to existing records when that solves idempotence or
  recovery. Do not add a new lookup table or dedupe service unless the focused
  tests prove existing owners cannot answer the question.
- Prefer a single bounded retry over a retry loop.
- Prefer deterministic failure injection over long idle soak tests. Soak tests
  can be added later after deterministic pilot coverage is stable.
- Each slice should land as a small causal change with its own tests. Do not
  batch unrelated cleanup into this issue.

## Live-Code Closure Gate

done: false

The latest plan review is no longer an open critique of this document; it is a
checklist against the current code. Do not mark this plan or any fix note
complete while these live-code gaps still exist:

- Server `/status` has no `runtimeChain` object with the required status values.
- `ensureLocalVesloServerRunning` can still treat `/health` plus
  `/capabilities` as full local runtime readiness.
- Send preflight can still set `runtimeReady` from `global.health()` alone for a
  local orchestrator workspace.
- `session-event-stream` or `engine_sse` can still reconnect indefinitely to a
  dead `/opencode/event` endpoint without releasing stale routing and triggering
  bounded recovery.
- Orchestrator `conversation_run` active records still lack persisted
  `client_message_id` and `origin`, or lifecycle `active/status` cannot return
  them for retry idempotence.
- The server lifecycle client, orchestrator `/runs/register` handler,
  run registry, and lifecycle payload do not carry the same nullable
  `clientMessageId`/`origin` fields end to end.
- WIR06 fault injection still depends on manual process killing instead of
  small `e2e`-only commands for daemon kill, shared-engine kill, and live
  process/dead-socket simulation.
- Validation filters can silently run zero tests for a moved or not-yet-created
  Rust module.

## WIR00: Baseline Regression Tests

Status: partial
done: false

2026-07-05 implementation note: focused regression tests were added with the
implemented slices, but this was not captured as a pre-fix failing baseline for
every listed category. Keep WIR00 `done: false` unless a later agent decides the
post-fix guard coverage is sufficient for this bookkeeping task.

Add failing tests before changing runtime behavior.

Implementation scope:

- Desktop Rust tests for stale `veslo-orchestrator-state.json` where the state
  has a daemon base URL but `resolve_orchestrator_status` reports
  `running: false`.
- Desktop Rust tests for recovered persisted `veslo-server` info where server
  `/health` succeeds but the configured orchestrator daemon is missing.
- Orchestrator tests for logged shutdown where child cleanup fails after the
  daemon listener is closed; state must still be saved without a stale daemon.
- Desktop/orchestrator tests proving shutdown reason/caller metadata is sent
  and logged for managed shutdown paths.
- Orchestrator tests for shared unsandboxed engine where the process appears
  alive but HTTP/event proxying fails with a socket close or upstream connection
  error.
- App tests proving a recoverable local runtime error after successful
  preflight triggers one recovery/retry path instead of only recording generic
  send failure.
- App tests proving `ensureLocalVesloServerRunning` and send preflight do not
  return runtime-ready from `/health` alone when `runtimeChain.status` is not
  `runtime_chain_ready`.
- App/desktop tests proving an `/opencode/event` or engine SSE connect failure
  releases stale runtime routing and triggers one bounded recovery instead of
  reconnecting forever to the same dead endpoint.
- Server/app tests proving send retry reuses the same `clientMessageId` and
  does not create a second OpenCode prompt when the first attempt was already
  queued or directly submitted.

Acceptance:

- At least one test fails against current code for each confirmed gap.
- Tests preserve the exact failure categories:
  stale daemon, green server with dead orchestrator, shutdown-state cleanup
  failure, unattributed shutdown, shared engine upstream socket failure,
  post-preflight send failure, and retry idempotence.
- Baseline tests can be introduced slice-by-slice. Do not block WIR01 on a
  large all-at-once harness if the first stale-state test is ready.

## WIR01: Stale Orchestrator State Cannot Drive Commands

Status: implemented
done: true

Patch the native orchestrator command boundary as small hardening. This is a
real bug, but normal chat send primarily flows through `veslo-server` workspace
routes, so WIR01 is not the main VSLO-271 recovery path.

Implementation scope:

- Update `packages/desktop/src-tauri/src/commands/orchestrator.rs` so
  `resolve_base_url` requires `status.running == true`.
- When `status.running == false`, return a structured error such as
  `orchestrator daemon is not running` and include the stale base URL only as
  diagnostic detail, not as an actionable target.
- Audit `orchestrator_reconcile`, `orchestrator_activate_workspace`, and
  disposal paths that call `resolve_base_url`.
- Keep `request_orchestrator_shutdown` as an explicit exception: it may read the
  stale daemon URL for best-effort graceful shutdown, but only that shutdown path
  should use the persisted URL without first requiring `status.running == true`.
- Do not make Rust a second routine writer of `veslo-orchestrator-state.json`
  just to fix this command boundary. A tombstone or stale-state clear from Rust
  is optional and should happen only after an explicit state-ownership decision;
  the primary fix is refusing to use a not-running daemon URL.

Acceptance:

- A stale `veslo-orchestrator-state.json` cannot cause desktop commands to call
  `http://127.0.0.1:<old-port>`.
- Manual status and command behavior agree: if status says daemon not running,
  activate/reconcile commands do not try to connect to the dead base URL.

## WIR02: Orchestrator Shutdown State Cleanup And Attribution

Status: implemented
done: true

Fix the state leak that can happen even when the daemon logs graceful shutdown,
and make the shutdown source observable.

Implementation scope:

- In `packages/orchestrator/src/cli.ts`, clear `state.daemon`, clear or
  snapshot engine state as appropriate, and save `veslo-orchestrator-state.json`
  before or in a `finally` around `pool.killAll()` and
  `sharedOpenCodeEngine.dispose()`.
- Preserve best-effort child cleanup. A failure while stopping pooled or shared
  engines must be logged, but must not prevent daemon state from being saved as
  not running or the daemon process from exiting.
- Extend the daemon `POST /shutdown` request with optional caller/reason
  metadata. Keep it backward compatible for callers that still send an empty
  body.
- Change the desktop shutdown helper from `request_orchestrator_shutdown(data_dir)`
  to a variant that accepts `reason` and `caller`, for example
  `request_orchestrator_shutdown(data_dir, ShutdownAttribution { reason, caller })`.
- Update `OrchestratorManager::stop_locked` to accept/pass shutdown attribution.
  Call sites should choose the reason at the boundary that knows intent:
  `engine_stop`, `engine_start_replace`, `app_exit`, `window_close`,
  `updater_shutdown`, and any misc host-stop helper.
- Log signal shutdowns with a distinct reason such as `signal:SIGINT` or
  `signal:SIGTERM`.
- Include the shutdown reason in runtime/debug traces so a future idle incident
  can tell whether shutdown was expected or externally initiated.

Acceptance:

- A logged `Daemon shutting down` cannot leave stale daemon base URL in
  `veslo-orchestrator-state.json` when engine cleanup throws.
- Cleanup failure cannot leave a zombie daemon with a closed listener; shutdown
  still reaches process exit after saving not-running state.
- Shutdown traces include caller/reason for desktop-managed stops, `/shutdown`
  requests, and signal paths.
- Existing unmanaged/manual `POST /shutdown` callers remain compatible.

## WIR03: Server Green Does Not Mean Runtime Chain Ready

Status: implemented
done: true

Close the restart split-brain where the app can reattach to an orphaned
`veslo-server` and show local runtime as available even though orchestrator and
OpenCode are gone.

Implementation scope:

- Extend the existing server `/status` response with a required `runtimeChain`
  object. Do not add a new status route for this issue.
- `runtimeChain.status` must be one of these exact values:
  - `server_running`
  - `runtime_chain_ready`
  - `orchestrator_unavailable`
  - `shared_engine_unhealthy`
  - `proxy_unreachable`
- Keep the contract small and stable. Suggested shape:
  - `status`: one of the values above,
  - `server`: `{ running: true }`,
  - `orchestrator`: `{ configured: boolean, running: boolean }`,
  - `sharedEngine`: `{ state: string | null, healthy: boolean | null }`,
  - `proxy`: `{ reachable: boolean | null }`,
  - `lastError`: string or null.
  Redact tokens and avoid embedding large health payloads.
- Do not duplicate the existing in-memory launch config in
  `VesloServerState`. Instead, extend the persisted recovery state, plugin
  state, or another single desktop-owned persistence surface so recovery can
  know whether the surviving `veslo-server` was launched with
  `opencode_base_url`, `orchestrator_daemon_url`, and
  `orchestrator_lifecycle_token`.
- On recovered persisted server info, if orchestrator mode was used, probe the
  orchestrator daemon health before returning a full ready state.
- If the server is healthy but the orchestrator chain is missing, report a
  structured lifecycle state such as
  `degraded/orchestrator_unavailable` and force the existing `engine_start`
  path to rebuild the chain.
- Desktop `veslo_server_info` may mirror the minimum recovery fields needed
  before a server client is available, but server `/status.runtimeChain` is the
  canonical app-visible contract.
- Update `packages/app/src/app/context/veslo-server-connection.ts` so
  `ensureLocalVesloServerRunning` cannot return full local-runtime readiness
  from `/health` or `/capabilities` alone. It must read `runtimeChain` or an
  equivalent combination of `engine_info` and `orchestrator_status`.
- Update `packages/app/src/app/context/send-runtime-readiness.ts` so send
  preflight does not set `runtimeReady` from `global.health()` alone when the
  target is a local orchestrator workspace. It must confirm
  `runtimeChain.status === "runtime_chain_ready"` or explicitly trigger bounded
  recovery.
- Keep `/health` backward compatible. Do not turn plain server health into a
  slow chain probe.

Acceptance:

- After app restart, a surviving `veslo-server.exe` without
  `veslo-orchestrator.exe` is not displayed as fully ready.
- The app can distinguish `server_running` from `runtime_chain_ready`.
- `ensureLocalVesloServerRunning` and send preflight both consume the same
  runtime-chain contract, or a documented equivalent while the server client is
  unavailable.
- Existing no-workspace startup behavior from VSLO-235 remains valid.

## WIR04: Shared Engine HTTP/Socket Liveness

Status: implemented
done: true

2026-07-05 review fix: the first implementation marked the shared engine
unhealthy from every proxy `onError`, but a routine client disconnect of a
streaming request (SSE teardown on workspace switch or app reload) makes the
locally destroyed upstream request emit `error: aborted` (ECONNRESET) on the
upstream response — verified on Node 24 and Bun 1.3. That would have
cold-restarted the shared engine on every stream teardown. Fixed in
`router-proxy.ts`: client-initiated aborts are tracked and reported via a new
`onClientAbort` callback; post-abort upstream errors no longer reach
`onError`. `cli.ts` closes the proxy trace as done with `clientAborted: true`
and does not mark the engine unhealthy. Regression tests added in
`router-proxy.test.ts` (client abort → onClientAbort only; upstream
connection failure → onError only).

2026-07-05 follow-up (pre-existing, out of scope here): under Bun's
`node:http` server, a client disconnect on a streaming response is not
observable at all — no request `aborted`, no response `close`, no socket
`close` (verified empirically; Node fires response `close`). The daemon runs
as a compiled Bun binary, so proxied `/opencode/event` upstream connections
leak on client teardown until the engine closes them. If idle incidents show
engine socket exhaustion, revisit with an SSE heartbeat or connection reaper.

Make shared unsandboxed OpenCode recovery match the observed socket failure.

Implementation scope:

- Extend `packages/orchestrator/src/shared-opencode-engine.ts` with an explicit
  unhealthy state or health-strike counter.
- Reuse the engine-pool health model where practical: `healthStrikes`,
  `healthFailureThreshold`, bounded health probe timeout, and a restart after
  repeated failed probes.
- Replace the current shared-engine liveness timer's PID-only `getRunning()`
  tick with an HTTP health probe against the shared engine endpoint. Reuse the
  existing timer path; do not add a second scheduler. Keep a PID check as a
  cheap fast-fail, not as the only readiness source.
- Wire proxy upstream socket failures in `packages/orchestrator/src/cli.ts` so
  `The socket connection was closed unexpectedly`, `ECONNRESET`,
  connection refused, and comparable upstream failures add a health strike or
  mark the shared engine unhealthy.
- On the next non-GET `ensureStarted`, stop/forget the unhealthy process if
  needed and start a fresh engine.
- Preserve read-only GET behavior that avoids spawning cold engines unless the
  request is part of an explicit recovery probe.

Acceptance:

- A PID-alive but HTTP-dead shared engine is not reused indefinitely.
- `orchestrator:proxy-upstream:error` produces actionable diagnostics and a
  recovery path.
- Pooled engine behavior is not regressed.

## WIR05: Send/Event Recovery, Idempotence, And User-Facing Diagnostic

Status: implemented
done: true

Handle send and event-stream failures that happen after preflight succeeds
without duplicating the user prompt.

Implementation scope:

- In `packages/app/src/app/pages/session-send-workflow.ts`, classify
  recoverable local runtime failures from `runConversationOrFail`:
  `opencode_proxy_failed`, `opencode_request_failed`, upstream engine error,
  socket closed, 502, 503, fetch failure, connection refused, and the WIR01
  structured `orchestrator daemon is not running` error.
- After such a failure, perform one bounded full-chain recovery using the
  existing `prepareSendRuntimeForSend` / `ensureEngineForWorkspace` ownership.
- Retry the send once only when the message/session/workspace target still
  matches the original send target.
- In `packages/app/src/app/context/session-event-stream.ts`, classify
  recoverable local runtime stream failures from `/opencode/event` and engine
  SSE. Release stale workspace routing, mark the stream disconnected, and
  trigger the same bounded runtime recovery instead of reconnecting indefinitely
  to the same dead endpoint.
- In `packages/desktop/src-tauri/src/commands/engine_sse.rs`, preserve enough
  structured error detail for the app to distinguish `connect-failed`,
  `non-success-status`, and upstream socket close/reset cases.
- The retry must reuse the original `clientMessageId` and `origin`.
- Prove idempotence across all known timing windows:
  - first attempt failed before server admission, so retry is the first real
    submit,
  - first attempt was queued, so the server queue returns the existing
    `clientMessageId` item,
  - first attempt was directly submitted and registered as active, so retry
    does not enqueue or submit a second OpenCode prompt for the same
    `clientMessageId`.
- Preferred KISS shape for direct-run idempotence: migrate the existing
  orchestrator `conversation_run` table with nullable `client_message_id` and
  `origin`, extend the run lifecycle record and `active/status` response with
  nullable `clientMessageId`/`origin`, then use that to recognize a retry of the
  same admitted run. Do not add a separate dedupe table or app-only memory path
  unless focused tests prove the lifecycle owner cannot carry this state.
- Carry those fields through the existing lifecycle chain instead of adding a
  parallel dedupe service: server `orchestrator-lifecycle-client.register`,
  orchestrator `/workspace/:id/runs/register`, `RunLifecycleOwner.register`,
  `run-store`, and `lifecycleRunPayload`.
- Add a lookup or unique rule that prevents two active/direct submitted runs for
  the same `(workspaceId, conversationId, clientMessageId)` when
  `clientMessageId` is present.
- If retry is not possible or fails, surface a structured local-runtime message
  alongside the generic pending label. Include whether the failed layer is
  server, orchestrator, shared engine, or upstream proxy when known.
- Keep stale-display protection in the send workflow.

Acceptance:

- A post-preflight local runtime failure gets exactly one recovery attempt.
- A recoverable `/opencode/event` or engine SSE failure releases stale route
  state and triggers bounded runtime recovery instead of reconnecting forever to
  the same dead endpoint.
- After stream recovery, a real assistant response is visible in the chat; this
  proves the event subscription moved to the rebuilt route, not only that the
  reconnect loop stopped.
- Retrying with the same `clientMessageId` cannot create a duplicate user
  prompt or duplicate OpenCode run in direct-submit, queued, or pre-admission
  timing windows.
- The UI no longer collapses this incident to only `Send failed`.
- Existing managed-AI and cloud send flows are not routed through local runtime
  recovery.

## WIR06: Installed Windows Regression

Status: implemented
done: true

2026-07-05 implementation note: e2e-only Tauri fault-injection commands and a
deterministic live-auth pilot scenario were added. The debug e2e desktop build
passed and `vslo-271-windows-idle-runtime-chain-recovery` passed with
`VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE=C:\Users\jajse\.veslo\den-auth.json`,
`E2E_MANAGED_AI_GATEWAY_FIXTURE=0`, automations disabled, real composer send,
and `sendPrompt:success`. The pilot now fails on send trace errors so a generic
green marker cannot hide an AI-gateway/provider-start failure.

Prove the full installed-app incident, not only unit slices.

Implementation scope:

- Add a Tauri-pilot scenario for shared unsandboxed Windows-style runtime chain
  recovery.
- Add only the minimum `#[cfg(all(debug_assertions, feature = "e2e"))]`
  Tauri fault-injection commands needed by the scenarios:
  `veslo_orchestrator_e2e_kill_daemon`, `shared_engine_e2e_kill_child`, and one
  deterministic live-process/dead-socket injector. Prefer a daemon-local
  e2e-only endpoint that closes the shared engine connection over OS-level
  suspend/resume.
- Scenario A: start app, create or attach a local workspace, kill only
  `veslo-orchestrator.exe`, then attempt send. Expected: chain recovery or
  structured degraded state, not generic `Send failed`.
- Scenario B: leave `veslo-server` running but remove/kill orchestrator and
  shared engine, relaunch app, and verify the app does not treat `/health OK` as
  full runtime readiness.
- Scenario C: simulate shared engine socket close while process still appears
  alive, then verify next non-GET send recovers/restarts the shared engine.
- Scenario D: trigger managed orchestrator shutdown and force a shared-engine
  cleanup failure. Verify the daemon state file no longer contains a live
  daemon base URL and the shutdown trace includes caller/reason.
- Scenario E: force a recoverable post-preflight send failure after the server
  has admitted the run. Verify retry does not duplicate the prompt.
- Scenario F: break only the `/opencode/event` or engine SSE path while
  `/health` still succeeds. Verify the app releases stale routing, recovers the
  chain, does not remain in a reconnect loop, and receives a visible assistant
  response after recovery.
- Capture debug spool and runtime trace handles in the pilot output when a
  scenario fails.
- Keep the pilot deterministic. Do not add a long idle soak requirement until
  the injected dead-daemon, dead-shared-engine, and admitted-run retry cases
  pass reliably.

Acceptance:

- New and existing chat send both pass after the injected idle/runtime-chain
  failure or show a precise structured recovery state.
- App restart clears or bypasses stale daemon state and rebuilds the chain.
- Shutdown reason is visible in the captured diagnostics.
- No lingering `veslo*`, `bun*`, or `tauri*` processes remain after the pilot.

## Validation

done: true

Focused validation while implementing:

```powershell
cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml orchestrator::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::orchestrator::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts src/tests/shared-opencode-engine.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-server exec bun test src/tests/server.health-status-routes.test.ts src/tests/conversation-run-lifecycle-controller.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/server.opencode-proxy-timeout.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-stale-local-runtime-recovery.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

When adding or renaming Rust test modules, treat `cargo test` output with
`0 tests` as a failed validation signal and fix the filter or module path before
marking the related task done.

Desktop acceptance before closing WIR06:

```powershell
pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario <windows-idle-runtime-chain-scenario>
```

2026-07-05 validation note: the focused Rust, orchestrator, server, app, i18n,
e2e runner, sidecar rebuild, debug e2e build, and live-auth VSLO-271 pilot gates
passed. The final pilot used the real Den auth snapshot and disabled the
managed-AI fixture. `pnpm release:review --strict` also passed with warnings
only for missing sidecar manifest and unset `SOURCE_DATE_EPOCH`.

Release confidence before shipping:

```powershell
pnpm release:review --strict
```

## Completion Bar

done: true

This issue is complete only when all of the following are true:

- Stale orchestrator state cannot be used for native commands.
- Orchestrator shutdown always saves not-running daemon state, even if engine
  cleanup fails, the daemon process exits, and diagnostics include shutdown
  caller/reason.
- Recovered `veslo-server` health cannot false-green the whole runtime chain.
- Shared unsandboxed engine socket failure causes restart or structured
  unhealthy state.
- Send retries once after bounded local runtime recovery when the target is
  still current and the retry is idempotent by `clientMessageId`.
- Windows installed-app pilot covers dead orchestrator, stale server recovery,
  shared engine socket failure, event-stream recovery, shutdown-state cleanup,
  and retry idempotence.
- A concise `docs/fixes/...` checkpoint records the final implementation,
  commands run, and observed process cleanup.
