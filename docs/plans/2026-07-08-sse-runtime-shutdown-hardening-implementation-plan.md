---
title: SSE Runtime Shutdown Hardening Implementation Plan
date: 2026-07-08
status: draft
done: false
source_audit: chat:2026-07-08-dev-runtime-shutdown-variants-5-6-7
primary_trace: dev-specific/tauri-pilot/manual-runtime-20260707-235515-pnpm-dev/runtime-trace.ndjson
send_trace_mirror: .tmp/send-workflow-trace.ndjson
opencode_health_trace: dev-specific/tauri-pilot/manual-runtime-20260707-235515-pnpm-dev/opencode-health.ndjson
srsh00_trace_exit_attribution_done: true
srsh01_sse_upstream_close_nonfatal_done: true
srsh02_event_stream_singleton_done: true
srsh03_runtime_recovery_scope_review_done: true
srsh04_targeted_tests_done: true
srsh05_runtime_smoke_done: false
srsh06_ui_reconnect_state_done: true
---

# SSE Runtime Shutdown Hardening Implementation Plan

## Goal

done: false

Prevent dev runtime sessions from collapsing when OpenCode event streams are
closed or multiplied during normal app activity.

This plan is intentionally KISS. It does not try to redesign the runtime
chain, the router proxy, or the session event model. It fixes the two most
likely causal mistakes found in the audit:

1. OpenCode `/event` socket close is treated like a general upstream engine
   failure in shared-unsandboxed mode.
2. The app can create enough parallel event streams for one workspace to hit
   OpenCode listener limits.
3. The app can classify transient SSE socket close text as local runtime
   failure and escalate from reconnect to route release/runtime recovery.

It also adds minimal exit attribution so the next incident can distinguish:

- app/window exit,
- explicit Tauri engine stop/restart,
- orchestrator `/shutdown`,
- OS/process signal,
- external dev cleanup,
- OpenCode/shared-engine degradation.

## Current Verdict

done: false

The latest inspected manual dev run does not prove an orchestrator `/shutdown`
or dev rebuild crash.

Confirmed evidence:

- OpenCode child logged `MaxListenersExceededWarning` at
  `2026-07-07T21:57:14.325Z`.
- OpenCode health was still OK at `2026-07-07T21:57:18.294Z`.
- Nine long-lived `GET /workspace/ws-8df10915b772/opencode/event` upstream
  streams failed together at `2026-07-07T21:57:23.270Z` through
  `2026-07-07T21:57:23.315Z`.
- The audit pass observed many `/opencode/event` upstream starts for the same
  workspace. The exact peak concurrency must be recomputed with a checked-in or
  documented parser before it is used as hard evidence in a fix note.
- The inspected traces did not contain `shutdown_request`,
  `signal:SIGINT`, `signal:SIGTERM`, `app_exit`, `engine_stop`, `host_stop`,
  or `engine_start_replace`.

Most likely causal chain:

1. Session/event routing creates too many `/event` streams.
2. OpenCode starts warning about listener pressure.
3. OpenCode closes event stream sockets.
4. The orchestrator classifies those event stream upstream errors as engine
   failures.
5. Shared OpenCode is marked unhealthy and killed.
6. The runtime chain degrades or disappears; if the Tauri app also exits, its
   cleanup stops the remaining sidecars.

## Implementation Progress

done: false

Source implementation completed for the first KISS slice:

- `SRSH01` done in source: shared-unsandboxed proxy errors now use a narrow
  upstream health policy. Transient `GET /event` socket close is traced as an
  upstream error with `eventStream: true` and `nonFatalEngineError: true`, but
  does not call `markUnhealthy("proxy-upstream-error", ...)`. Non-event and
  non-transient upstream errors remain fatal for the shared engine.
- `SRSH03` done in source: event-stream runtime recovery now requires both a
  text-matched local runtime error and scoped workspace runtime readiness being
  false. A plain SSE socket close with ready runtime schedules reconnect/catch-up
  instead of releasing the route.
- `SRSH02` done in source: the session event stream controller now has a
  per-workspace generation registry. Duplicate setup replaces the previous
  generation, aborts/cleans it up, and records `session-sse:replaced-existing`
  diagnostics.
- `SRSH06` done in source: reconnect state is now modeled as
  `live | reconnecting | catching-up | degraded | runtime-recovering`, wired
  through the session store and rendered as a compact session banner. The state
  explicitly does not block send readiness.
- `SRSH04` targeted source tests pass for the above contracts.

Not completed:

- `SRSH00` exit attribution is still not implemented.
- `SRSH05` manual runtime smoke is still not run. Do not mark the whole plan
  done until a fresh dev runtime confirms event stream concurrency, OpenCode
  health, reconnect/catch-up transcript behavior, and no unexpected app exit.

Verification run on 2026-07-08:

- `bun test packages/orchestrator/src/tests/proxy-upstream-health-policy.test.ts`
  -> 4 pass.
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-reconnect.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/pages/session-scroll-behavior.test.ts`
  -> 52 pass.
- `pnpm --filter @neatech/veslo-ui typecheck` -> pass.
- `pnpm --filter veslo-orchestrator typecheck` -> pass.

## Source Evidence

done: false

- App event streams are started for every ready routing entry in
  `packages/app/src/app/context/session-event-stream.ts`.
- `setupSseStream(...)` has abort/unsubscribe cleanup, but cleanup is
  asynchronous and the audit observed excessive or repeated concurrent stream
  activity for one workspace. Exact peak concurrency must be recomputed before
  being used as hard evidence.
- The Rust SSE bridge exposes `engine_sse_subscribe` /
  `engine_sse_unsubscribe` through `packages/app/src/app/lib/engine-sse.ts`.
- The router proxy reports true client aborts separately through
  `onClientAbort`, so the latest upstream errors were not classified as normal
  browser/client disconnects.
- The orchestrator `proxyToEngine(...)` caller marks the shared engine
  unhealthy on any upstream error in `packages/orchestrator/src/cli.ts`.
- `SharedOpenCodeEngine.markUnhealthy(...)` clears the engine and kills the
  OpenCode child if it is still alive.
- `session-event-stream.ts` can route SSE stream errors through
  `shouldRecoverLocalRuntimeFromHealthError(...)`, whose matcher includes
  broad socket-close and 404/502/503 text.
- The existing app test around event stream runtime errors currently expects
  recovery behavior and must be updated so transient SSE close is a reconnect
  case, not a route-release/runtime-recovery case.
- Tauri app exit cleanup calls `stop_managed_services(...)` in
  `packages/desktop/src-tauri/src/lib.rs`.
- `packages/desktop/scripts/tauri-dev.mjs` forwards SIGINT/SIGTERM to the
  Tauri child and exits with the child result, but does not currently log the
  child exit reason in a durable trace.
- Windows dev startup cleanup can force-kill stale `veslo*` and `opencode`
  processes through `packages/desktop/scripts/cleanup-dev-processes.mjs`.

## Non-Goals

done: false

- Do not rewrite the router proxy.
- Do not disable SSE.
- Do not hide real non-SSE upstream failures.
- Do not increase Node/OpenCode listener limits as the primary fix.
- Do not add a broad retry loop around every runtime error.
- Do not start a Tauri pilot smoke as part of the first implementation slice.
- Do not change managed AI gateway behavior unless fresh evidence ties it to
  this shutdown class.

## SRSH00: Add Minimal Exit Attribution

done: true

The current trace is good for orchestrator and OpenCode, but weak for "why did
the Tauri app/dev child exit?" Add small logging points before changing
behavior so the next run can be interpreted without guessing.

Implementation:

- In the Tauri app run loop, record a trace/log event before
  `stop_managed_services(...)` for:
  - `RunEvent::ExitRequested`,
  - `RunEvent::Exit`,
  - `WindowEvent::CloseRequested`.
- Include:
  - reason,
  - timestamp,
  - pids returned by `stop_managed_services(...)`,
  - whether this was debug/dev build.
- In `packages/desktop/scripts/tauri-dev.mjs`, log child `exit` code and
  signal before `process.exit(...)`.
- Keep this diagnostic-only. Do not change cleanup semantics in this step.

Acceptance:

- A normal window close leaves a visible app-exit attribution in dev logs.
- A Tauri child crash/exit leaves a visible wrapper exit line.
- No new long-running process is introduced.

## SRSH01: Treat OpenCode Event Stream Upstream Close As Non-Fatal

done: false

This is the highest-value causal fix. In shared-unsandboxed mode, a socket
close on `GET /event` should not immediately mark the whole shared OpenCode
engine unhealthy. Event streams are long-lived and can close during reloads,
workspace switches, renderer teardown, network interruptions, or upstream SSE
limits.

Implementation:

- In `packages/orchestrator/src/cli.ts`, classify proxy requests before
  `proxyToEngine(...)` calls `onError`.
- Add a narrow predicate such as:
  - method is `GET`,
  - target path is `/event` or request path ends with `/opencode/event`,
  - error text matches socket close/reset/aborted style failures.
- For this predicate:
  - still finish upstream trace as `orchestrator:proxy-upstream:error`,
  - add `eventStream: true` and `nonFatalEngineError: true`,
  - do not call `sharedOpenCodeEngine.markUnhealthy(...)`,
  - log at debug/info level instead of engine-unhealthy warn.
- Preserve the current behavior for:
  - non-SSE paths,
  - prompt/session submit failures,
  - health failures,
  - config/MCP/session non-event routes,
  - pooled per-workspace engine behavior unless explicitly covered by tests.

Acceptance:

- A simulated `/event` upstream socket close does not call
  `markUnhealthy("proxy-upstream-error", ...)`.
- A simulated `/session` or `/prompt_async` upstream socket close still marks
  shared OpenCode unhealthy.
- Trace output still records the event stream failure clearly.
- The test that proves this must run at the orchestrator CLI/wrapper layer
  where `sharedOpenCodeEngine.markUnhealthy(...)` is called. A
  `router-proxy.test.ts` case alone is not enough, because `router-proxy.ts`
  does not own shared-engine health policy.

## SRSH02: Make App Session Event Streams Singleton Per Workspace With Diagnostics

done: false

The app should not create multiple live event streams for the same workspace
inside one session controller generation. The latest trace and startup summary
show repeated event stream subscribe/unsubscribe activity for one workspace,
and the audit found enough concurrency risk to explain listener pressure. Exact
peak concurrency must be recomputed with the parser used for the fix note.

Implementation:

- In `packages/app/src/app/context/session-event-stream.ts`, add a
  per-controller registry keyed by workspace id.
- Track diagnostic fields:
  - `activeEventStreamsByWorkspace`,
  - generation id,
  - replacement count,
  - last replacement reason.
- Before starting a new stream for a workspace:
  - abort/close the previous cleanup for that workspace,
  - record a compact debug trace such as `session.sse.replaced-existing`,
  - include `workspaceId`, previous generation, next generation, and
    `reason: "replaced-existing"`.
- When a stream cleanup runs:
  - remove only the matching generation from the registry,
  - ignore stale async cleanup completion from older generations.
- Keep one stream per ready routing entry; do not change routing ownership or
  active-workspace semantics in this plan.
- Keep the existing Rust SSE fallback behavior.

Acceptance:

- Repeated routing updates for the same workspace do not leave more than one
  live stream in the app controller.
- Cleanup still calls `engine_sse_unsubscribe`.
- Trace/counters make a render or routing loop visible instead of silently
  hiding it by closing the previous stream.
- Existing event processing and reconnect behavior remain unchanged for one
  healthy stream.

## SRSH03: Gate Event Stream Runtime Recovery With Independent Runtime Evidence

done: false

Event stream errors currently can trigger route release and runtime recovery.
That can be useful when the local runtime is genuinely gone, but it must not
amplify normal SSE teardown into repeated runtime reattach/restart work.

This is not optional. A plain SSE socket close must be a reconnect/catch-up
case. Runtime recovery is allowed only when there is independent evidence that
the local runtime chain is unavailable.

Implementation:

- Review `shouldRecoverLocalRuntimeFromHealthError(...)` usage from
  `session-event-stream.ts`.
- Split the event-stream path from send/runtime preflight classification:
  - keep the broader matcher for explicit send recovery where appropriate,
  - use a narrower event-stream classifier for SSE errors.
- Keep recovery for clear local runtime-chain failures:
  - `engine_not_running`,
  - `engine_starting`,
  - orchestrator daemon not running,
  - workspace registry/mount mismatch,
  - failed `/status.runtimeChain` or equivalent scoped local status check.
- Avoid triggering runtime recovery for a plain `/event` socket close when
  there is no independent failing health/status signal.
- Add a lightweight health/status check before event-stream recovery performs
  `recoverWorkspaceRuntimeForEventStream(...)`.
- Do not release the workspace route on transient SSE close alone.

Acceptance:

- A plain SSE socket close schedules reconnect, not runtime recovery.
- A socket close plus failed runtime-chain health can still recover the local
  route.
- "Independent runtime evidence" means `/status.runtimeChain` or an equivalent
  scoped local status check for the affected workspace. Generic text-matched
  errors such as socket close, failed fetch, or `ECONNRESET` are not enough.
- Managed/cloud paths do not enter local runtime recovery from text-matched
  socket errors.
- The existing event-stream runtime-error test is rewritten to match this
  contract, and a negative test proves transient SSE close does not release the
  route.

## SRSH04: Targeted Tests

done: false

Add tests that cover behavior, not implementation trivia.

Suggested tests:

- Orchestrator CLI/wrapper-level test around the `/workspace/:id/opencode/*`
  proxy handler:
  - shared engine is not marked unhealthy for `/event` socket close,
  - shared engine is still marked unhealthy for non-event upstream socket
    failures,
  - `router-proxy.ts` `onClientAbort` remains non-fatal.
- `packages/orchestrator/src/tests/router-proxy.test.ts`
  - keep or add low-level coverage for client abort versus upstream error, but
    do not treat it as sufficient proof for shared-engine health policy.
- `packages/app/src/app/tests/context/session-event-stream.test.ts`
  - duplicate workspace stream setup replaces the previous stream,
  - cleanup unsubscribes the Rust SSE bridge once per generation,
  - plain stream socket close reconnects without runtime recovery unless
    health/status also fails.
- UI/reconnect-state tests around the existing `session-reconnect` and session
  page props path:
  - transient stream close transitions `live -> reconnecting`,
  - reconnect catch-up transitions `reconnecting -> catching-up -> live`,
  - failed scoped local runtime status transitions to `runtime-recovering` or
    `degraded`,
  - reconnect/degraded UI state does not block send readiness by itself.
- A source-level regression around `tauri-dev.mjs` child exit logging if there
  is an existing script-test pattern; otherwise leave it as manual verification.

Acceptance:

- Tests fail on the current broad `markUnhealthy` behavior.
- Tests fail on the current broad event-stream runtime recovery behavior.
- Tests cover the visible reconnect/catch-up/degraded state transitions.
- Tests pass after the KISS fixes.
- No old broad test should be changed only to satisfy the new behavior.

## SRSH05: Runtime Verification

done: false

After source tests pass, run a manual dev runtime without Tauri pilot smoke.

Manual verification:

1. Start `pnpm dev` from `veslo-main`.
2. Open an existing conversation and send at least two prompts.
3. Exercise:
   - flapping or slow network against event streams where practical,
   - long conversation with active streaming response,
   - reconnect during response streaming,
   - catch-up after reconnect.
4. Watch:
   - `.tmp/send-workflow-trace.ndjson`,
   - latest `runtime-trace.ndjson`,
   - latest `opencode-health.ndjson`,
   - dev terminal.
5. Summarize:
   - max concurrent `/opencode/event` streams,
   - any `MaxListenersExceededWarning`,
   - any `orchestrator:proxy-upstream:error` for `/event`,
   - whether OpenCode health remains OK,
   - whether the app/dev child exits.

Acceptance:

- Max concurrent event streams for one workspace stays at or near 1 during
  normal activity.
- `/event` socket close, if present, does not mark shared OpenCode unhealthy.
- No `MaxListenersExceededWarning` appears during the smoke.
- Successful first and existing sends are preserved.
- Transcript catch-up after reconnect does not lose or duplicate visible
  assistant/user turns.

## SRSH06: UI Reconnect, Catch-Up, And Degraded State

done: false

The current UI has a one-shot reconnect notice and a simple live header. That
is not enough for long work where SSE can reconnect, catch up, or degrade while
the session stays usable.

Implementation:

- Add a small session/workspace reconnect state model with states:
  - `live`,
  - `reconnecting`,
  - `catching-up`,
  - `degraded`,
  - `runtime-recovering`.
- Scope the state by workspace and selected session where possible.
- Include:
  - reconnect attempt,
  - backoff delay or next retry timestamp,
  - last error summary,
  - whether transcript/messages may be delayed.
- Wire the state from `session-event-stream.ts` into the existing reconnect
  store/UI props path.
- Keep visible text compact and operational. Do not add a marketing-style
  explanation panel.
- Add test coverage through the same state/props boundary used by the session
  page. The UI contract belongs in SRSH04 so runtime-only tests cannot mark
  this plan done.

Acceptance:

- During transient SSE close, UI shows reconnecting/catching-up instead of only
  a toast.
- During confirmed runtime recovery, UI shows runtime-recovering or degraded.
- When catch-up completes, UI returns to live.
- The UI state does not block prompt sending by itself; send readiness remains
  owned by the send/runtime preflight.

## Evaluation Questions

done: false

Use these questions when reviewing the plan:

1. Is SRSH01 narrow enough that real prompt/session submit failures still kill
   or recycle a bad shared engine?
2. Does SRSH03 use independent runtime-chain evidence before recovery, or does
   it still rely on broad text matching?
3. Is SRSH02 local enough, and do its diagnostics expose a deeper routing
   entry/render loop instead of hiding it?
4. Is SRSH06 enough for real long-running work, or does the session page need a
   more explicit per-session degraded indicator?
5. Is exit attribution in SRSH00 worth doing before behavior changes, or can it
   be merged with the first implementation patch?
6. Are there any production/release implications, or is this only dev-runtime
   risk because the current evidence is from manual `pnpm dev`?

## Recommended First Slice

done: false

Implement in this order:

1. SRSH01: make `/event` upstream socket close non-fatal for shared OpenCode.
2. SRSH03: transient SSE socket close is reconnect/catch-up; runtime recovery
   requires independent runtime-chain evidence.
3. SRSH02: enforce one session event stream per workspace per controller, with
   generation diagnostics.
4. SRSH04 targeted tests for the orchestrator wrapper and app event stream
   recovery contract.
5. SRSH06: visible reconnect/catching-up/degraded state for long-running work.
6. SRSH00 minimal exit attribution if the reviewer wants better evidence
   before manual runtime testing.

This order fixes the likely cause first and avoids broad runtime recovery
rewrites.
