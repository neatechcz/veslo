---
title: SSE Runtime Shutdown Hardening Implementation Plan
date: 2026-07-08
status: draft
done: false
source_audit: chat:2026-07-08-dev-runtime-shutdown-variants-5-6-7
primary_trace: dev-specific/tauri-pilot/manual-runtime-20260707-235515-pnpm-dev/runtime-trace.ndjson
send_trace_mirror: .tmp/send-workflow-trace.ndjson
opencode_health_trace: dev-specific/tauri-pilot/manual-runtime-20260707-235515-pnpm-dev/opencode-health.ndjson
srsh00_trace_exit_attribution_done: false
srsh01_sse_upstream_close_nonfatal_done: false
srsh02_event_stream_singleton_done: false
srsh03_runtime_recovery_scope_review_done: false
srsh04_targeted_tests_done: false
srsh05_runtime_smoke_done: false
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
- The global send trace showed 22 `/opencode/event` upstream starts and a peak
  of 13 concurrent event streams for the same workspace.
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

## Source Evidence

done: false

- App event streams are started for every ready routing entry in
  `packages/app/src/app/context/session-event-stream.ts`.
- `setupSseStream(...)` has abort/unsubscribe cleanup, but cleanup is
  asynchronous and the latest trace still reached 13 concurrent event streams.
- The Rust SSE bridge exposes `engine_sse_subscribe` /
  `engine_sse_unsubscribe` through `packages/app/src/app/lib/engine-sse.ts`.
- The router proxy reports true client aborts separately through
  `onClientAbort`, so the latest upstream errors were not classified as normal
  browser/client disconnects.
- The orchestrator `proxyToEngine(...)` caller marks the shared engine
  unhealthy on any upstream error in `packages/orchestrator/src/cli.ts`.
- `SharedOpenCodeEngine.markUnhealthy(...)` clears the engine and kills the
  OpenCode child if it is still alive.
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

done: false

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

## SRSH02: Make App Session Event Streams Singleton Per Workspace

done: false

The app should not create multiple live event streams for the same workspace
inside one session controller generation. The latest trace showed peak 13
concurrent streams for one workspace, which is enough to hit default listener
limits.

Implementation:

- In `packages/app/src/app/context/session-event-stream.ts`, add a
  per-controller registry keyed by workspace id.
- Before starting a new stream for a workspace:
  - abort/close the previous cleanup for that workspace,
  - record a compact debug trace such as `session.sse.replaced-existing`.
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
- Existing event processing and reconnect behavior remain unchanged for one
  healthy stream.

## SRSH03: Review Runtime Recovery Scope For Event Streams

done: false

Event stream errors currently can trigger route release and runtime recovery.
That can be useful when the local runtime is genuinely gone, but it must not
amplify normal SSE teardown into repeated runtime reattach/restart work.

Implementation:

- Review `shouldRecoverLocalRuntimeFromHealthError(...)` usage from
  `session-event-stream.ts`.
- Keep recovery for clear local runtime-chain failures:
  - `engine_not_running`,
  - `engine_starting`,
  - orchestrator daemon not running,
  - workspace registry/mount mismatch,
  - non-event request 404/502/503 during send/recovery.
- Avoid triggering runtime recovery for a plain `/event` socket close when
  there is no independent failing health/status signal.
- If needed, add a lightweight health/status check before event-stream recovery
  performs `recoverWorkspaceRuntimeForEventStream(...)`.

Acceptance:

- A plain SSE socket close schedules reconnect, not runtime recovery.
- A socket close plus failed runtime-chain health can still recover the local
  route.
- Managed/cloud paths do not enter local runtime recovery from text-matched
  socket errors.

## SRSH04: Targeted Tests

done: false

Add tests that cover behavior, not implementation trivia.

Suggested tests:

- `packages/orchestrator/src/tests/router-proxy.test.ts`
  - shared engine is not marked unhealthy for `/event` socket close,
  - shared engine is still marked unhealthy for non-event upstream socket
    failures,
  - `onClientAbort` remains non-fatal.
- `packages/app/src/app/tests/context/session-event-stream.test.ts`
  - duplicate workspace stream setup replaces the previous stream,
  - cleanup unsubscribes the Rust SSE bridge once per generation,
  - plain stream socket close reconnects without runtime recovery unless
    health/status also fails.
- A source-level regression around `tauri-dev.mjs` child exit logging if there
  is an existing script-test pattern; otherwise leave it as manual verification.

Acceptance:

- Tests fail on the current broad `markUnhealthy` behavior.
- Tests pass after the KISS fixes.
- No old broad test should be changed only to satisfy the new behavior.

## SRSH05: Runtime Verification

done: false

After source tests pass, run a manual dev runtime without Tauri pilot smoke.

Manual verification:

1. Start `pnpm dev` from `veslo-main`.
2. Open an existing conversation and send at least two prompts.
3. Watch:
   - `.tmp/send-workflow-trace.ndjson`,
   - latest `runtime-trace.ndjson`,
   - latest `opencode-health.ndjson`,
   - dev terminal.
4. Summarize:
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

## Evaluation Questions

done: false

Use these questions when reviewing the plan:

1. Is SRSH01 narrow enough that real prompt/session submit failures still kill
   or recycle a bad shared engine?
2. Is SRSH02 local enough, or does it hide a deeper routing entry leak?
3. Should SRSH03 be part of the first patch, or should it wait until SRSH01 and
   SRSH02 produce a cleaner runtime trace?
4. Is exit attribution in SRSH00 worth doing before behavior changes, or can it
   be merged with the first implementation patch?
5. Are there any production/release implications, or is this only dev-runtime
   risk because the current evidence is from manual `pnpm dev`?

## Recommended First Slice

done: false

Implement in this order:

1. SRSH01: make `/event` upstream socket close non-fatal for shared OpenCode.
2. SRSH02: enforce one session event stream per workspace per controller.
3. SRSH04 targeted tests for both changes.
4. SRSH00 minimal exit attribution if the reviewer wants better evidence
   before manual runtime testing.
5. SRSH03 only if traces still show event-stream socket close triggering
   runtime recovery.

This order fixes the likely cause first and avoids broad runtime recovery
rewrites.
