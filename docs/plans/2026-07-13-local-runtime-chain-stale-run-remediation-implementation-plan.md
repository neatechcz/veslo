---
title: Local Runtime Chain And Stale Run Remediation Implementation Plan
date: 2026-07-13
status: decision-gated
done: false
repository_snapshot: veslo-main main after the 2026-07-13 source-owner audit
source_plan: docs/plans/2026-07-13-local-runtime-chain-stale-run-remediation-plan.md
related_plans:
  - docs/plans/2026-07-13-accepted-run-connectivity-and-transcript-recovery-plan.md
  - docs/plans/2026-07-11-event-driven-conversation-run-lifecycle-implementation-plan.md
scope: truthful local runtime readiness presentation and safe durable handling only of positively confirmed engine-owner loss
lri00_reproduction_and_engine_loss_gate_done: false
lri01_two_dimension_connection_state_done: false
lri02_queue_policy_and_confirmed_engine_loss_done: false
lri03_exact_durable_terminal_ui_handoff_done: false
lri04_desktop_regression_and_docs_done: false
---

# Local Runtime Chain And Stale Run Remediation Implementation Plan

## Canonical Status

done: false

This plan is intentionally decision-gated. LRI01 is independently ready to
implement. LRI02 may begin only when LRI00 finds a positive, run-correlated
engine-owner loss signal. A pair of failed lifecycle probes is not that signal.

The accepted-run path when the desktop app loses its Veslo server belongs to
the accepted-run connectivity plan. Terminal transcript retry belongs there as
well. This plan must not create a second app recovery owner.

## KISS Decision

Keep three concerns separate:

```text
reachable Veslo server + runtime chain not ready
  -> truthful app presentation only

positive engine-owner loss for an accepted local run
  -> one server-owned durable failure

accepted run + desktop cannot reach Veslo server
  -> accepted-run connectivity plan: one bounded foreground recovery,
     then non-terminal reconnect presentation
```

The first concern is a status-semantic defect. The second is a durable server
policy, but only after the loss is proven. The third is an app recovery state;
it is deliberately delegated rather than copied here.

## Why The Gate Exists

The current orchestrator activity probe collapses several conditions into
`engine_unreachable`: a missing engine, proxy or upstream `5xx`, any other
non-OK probe response, and thrown transport errors. The run registry exposes
that result as stale.

Therefore, changing the current policy from a 600-poll backstop to "fail after
two `engine_unreachable` observations" can terminate a healthy long-running
run during a short proxy or transport outage. It is not a safe KISS fix.

The existing queue-drain path has the opposite problem: it can fail a stale
active run immediately when a successor is queued. The plan must remove that
generic stale shortcut, but must not replace it with another generic fast-fail
rule.

## Scope And Ownership

| Concern | Owner | Result in this plan |
| --- | --- | --- |
| Veslo HTTP reachability and runtime-chain facts | existing server health response | Preserve payload; do not add a second endpoint. |
| Header/status presentation | app server-connection context and header consumer | Render reachability separately from runtime readiness. |
| Generic probe failure | orchestrator run registry and existing reconcile backstop | Remains non-terminal; never call it confirmed engine loss. |
| Positive engine-owner loss | server lifecycle controller | One idempotent durable failure, only after LRI00 proves a reliable signal. |
| Accepted-run server-loss UI and transcript retry | accepted-run connectivity plan | Out of scope here; do not duplicate its watcher, Retry, or presentation states. |

## Hard Contracts

1. A successful authenticated health request is server reachability even when
   the workspace runtime is warming or degraded.
2. The desktop app never makes a durable `failed`, `completed`, or `idle`
   decision from its own transport state or from the header indicator.
3. `engine_unreachable` is a probe result, not a terminal reason. Generic
   transport/proxy failures remain on the existing conservative path.
4. A fast durable failure requires a positive owner-loss fact tied to the
   exact `(workspaceId, conversationId, runId)` and engine owner generation.
   Examples are an authoritative owner/process exit or a fenced engine-owner
   replacement event; a timeout or HTTP `5xx` is insufficient.
5. Queue drain and accepted-run reconciliation share the same terminal policy.
   A queued successor must not cause a generic stale run to fail earlier than
   an otherwise identical run.
6. Private Chat and workspace chat retain one workspace-scoped conversation/run
   model. No slice changes scratch-workspace creation or creates a second
   session model.
7. Any normal durable terminal result continues through the existing exact-run
   UI handoff. This plan adds no app-side fallback timer, transcript poller, or
   non-terminal presentation state.

## Implementation Slices

### LRI00 - Reproduce and choose the engine-loss policy

done: false

Use the real Tauri desktop runtime and an isolated fresh profile. Do not use a
browser-only server.

Capture these cases with correlated ids and no prompt bodies:

1. cold New Chat, then one short prompt;
2. cold existing local workspace chat, then one short prompt;
3. an accepted run followed by controlled engine-owner/process loss;
4. an accepted run with a temporary proxy/transport failure but a still-live
   engine;
5. a normal long-running or tool-active control run.

For each case record workspace, conversation, run, OpenCode session, engine
owner generation, health/runtime-chain state, lifecycle probe disposition,
terminal outcome, queue state, and visible status.

Decision gate:

- If a positive owner-loss signal already exists and is correctly correlated to
  the active run, record it and proceed to LRI02.
- If it does not exist, do **not** infer it from two failed probes and do not
  implement a new broad probe classifier in this slice. Leave durable fast
  terminalization deferred and open a separate design task for the owner-loss
  signal.
- If the incident occurs before `submitted`, or is auth/workspace-registration
  failure, stop and route it to the applicable send-boundary incident instead.

Acceptance:

- The trace distinguishes actual owner loss from temporary probe transport
  failure.
- The test proves that a healthy long-running run survives the temporary
  failure control.
- The selected LRI02 condition is evidence-backed or explicitly deferred.

### LRI01 - Split server reachability from runtime readiness

done: false

Primary files:

- `packages/app/src/app/context/veslo-server-connection.ts`
- `packages/app/src/app/lib/veslo-server/types.ts`
- current header/status view model
- existing health-route and connection-context tests

Work:

1. Expose an app-facing connection snapshot with separate
   `serverReachability` and `runtimeReadiness`; retain the complete existing
   runtime-chain diagnostic for developer use.
2. Map the existing health payload without guessing from timeouts:
   - `runtime_chain_ready` -> `ready`;
   - local loopback `server_running` -> `starting`;
   - a pending shared engine -> `starting`, otherwise a non-ready shared engine
     -> `degraded`;
   - `orchestrator_unavailable` -> `unavailable` and
     `proxy_unreachable` -> `degraded`;
   - health/auth failure -> server `unreachable` or auth state, with no
     fabricated runtime readiness;
   - an external/remote server without the local runtime contract ->
     `not-applicable`, not `starting`.
3. Render the dimensions independently: only an unreachable/auth-failed server
   gets the server-failure treatment. A reachable non-ready runtime gets a
   distinct warming/degraded message.
4. Inventory current combined-status callers before changing them. Keep
   server-only operations usable from reachability; require runtime readiness
   only for callers that truly need the workspace runtime.
5. Keep server-only ensure/recovery server-only. Passive status and history
   reads must not start or restart a runtime chain.

Acceptance:

- Cold New Chat can say that its runtime is warming without claiming the
  server is down.
- Existing server-only operations retain their client behavior.
- No public health-response change is required.

### LRI02 - Normalize stale queue policy; terminalize only proven owner loss

done: false

Primary files:

- `packages/server/src/conversation-run-lifecycle-controller.ts`
- `packages/server/src/orchestrator-lifecycle-client.ts`
- the existing engine-owner lifecycle surface identified by LRI00
- focused lifecycle-controller and queue tests

Work:

1. Remove the queue-drain shortcut that calls `markFailed` merely because the
   latest active run is generic `stale`. Queue drain must coalesce with the
   normal lifecycle policy rather than changing terminal semantics because a
   successor exists.
2. Keep generic `engine_unreachable`, HTTP `5xx`, and probe transport errors
   on the existing conservative reconcile/backstop path. A temporary failure
   must not mutate the durable run or release the queue.
3. Only if LRI00 identified a positive owner-loss fact, route that fact through
   the server lifecycle controller. Fence it by exact run and engine-owner
   generation, then use the existing idempotent `markFailed`/gateway cleanup/
   queue-wake path once.
4. If LRI00 deferred the signal, implement only step 1 and leave the fast
   terminal path absent. Do not add an in-memory two-probe confirmation map as
   a substitute for evidence.
5. Trace the policy disposition: generic stale deferred, positive owner loss
   observed, terminalization joined, and terminalization failure. Trace ids and
   reason only; never prompt content.

Required focused tests:

1. A queued successor plus generic stale/`engine_unreachable` cannot call
   `markFailed` earlier than the normal policy.
2. A temporary probe `5xx` or transport error leaves the exact active run and
   queue intact.
3. A positive owner-loss signal, if LRI00 provides one, terminalizes exactly
   one matching run, wakes the queue once, and cannot affect a replacement,
   completed, or aborted run.
4. A long active/tool run remains active through the short transient-failure
   control.

Acceptance:

- Queue presence does not alter generic stale terminal semantics.
- No healthy run is fast-failed from generic probe unavailability.
- A proven owner loss, if implemented, has one durable terminal outcome.

### LRI03 - Consume only the exact durable terminal result

done: false

Execution rule: this slice always verifies the existing exact durable terminal
handoff with a controlled already-`failed` lifecycle result. It implements or
desktop-validates the LRI02-specific owner-loss path only when LRI00 passes its
positive-signal gate. If that gate is deferred, LRI03 remains a regression
proof for the existing terminal contract; it must not invent a failure path to
make this plan complete.

Primary files:

- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/context/session-event-stream.ts`
- existing session lifecycle tests

Work:

1. Verify that an exact durable `failed` result reaches the exact admitted run
   and produces one scoped retryable error turn and activity release. When
   LRI00 passes its gate, run this same assertion against the LRI02
   owner-loss result as an additional integration case.
2. Preserve the existing rule that `session.idle`/error SSE frames are deferred
   while the durable run is active. A header colour or probe failure cannot
   clear a spinner early.
3. Fence terminal handling by workspace, conversation, run, and UI-session
   aliases. A late terminal event cannot release a newer run or another
   workspace.
4. Keep all connection-unavailable, Retry/Reconnect, missing-transcript, and
   `run-not-found` presentation work in the accepted-run connectivity plan.
   This slice must not add an app recovery generation, server-start call, or
   sidebar override.

Acceptance:

- A durable terminal failure releases only its matching UI run.
- Normal completion continues through the ordinary transcript path.
- LRI03 is fully verified with the existing durable-failure fixture even when
  LRI02 correctly defers a new owner-loss terminalization path.
- This plan does not duplicate accepted-run recovery behavior.

### LRI04 - Desktop verification and documentation

done: false

Run repository desktop preflight, rebuild the server sidecar after server
changes, and use an isolated Tauri Pilot profile.

Required runtime cases:

1. cold New Chat and cold existing workspace chat: server reachability and
   runtime readiness are visibly distinct;
2. temporary engine-probe transport failure while the engine is live: no
   durable terminal failure and no lost queue item;
3. only if LRI00 passed its gate, positive engine-owner loss after accepted
   submit: one durable failure, one queue wake, and one exact UI error;
4. a normal long active/tool run: no false failure.

The accepted-run connectivity plan owns the separate desktop scenario where
the server itself vanishes after acceptance. Do not duplicate that E2E here.

Required verification:

```powershell
bun test packages/server/src/tests/conversation-run-lifecycle-controller.test.ts --timeout 30000
bun test packages/server/src/tests/server.health-status-routes.test.ts --timeout 30000
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/pages/session-run-presentation.test.ts src/app/tests/context/sidebar-session-activity-projection.test.ts

# Only after a server-source change:
pnpm --filter veslo-server build:bin
VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar

pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Completion checklist:

- [ ] LRI00 evidence either proves the positive owner-loss signal or defers
  fast terminalization.
- [ ] LRI01 separates server reachability from runtime readiness without
  regressing server-only callers.
- [ ] LRI02 removes queue-specific generic stale failure and never fast-fails
  from probe unavailability alone.
- [ ] LRI03 verifies exact durable terminal truth with the controlled existing
  failure fixture; when LRI00 passes, it also covers LRI02's owner-loss result.
- [ ] LRI04 passes the appropriate focused checks and real desktop scenarios.

## Explicitly Out Of Scope

- A foreground reconnect/retry state after an accepted run loses the server.
- Terminal transcript hydration retry and historical-session recovery.
- Generic `engine_unreachable` fast-fail or a new broad probe-classification
  system.
- Replacing normal lifecycle polling with the event-driven lifecycle plan.
- Changing scratch-workspace creation, login persistence, remote workspace
  lifecycle ownership, or the durable queue data model.
