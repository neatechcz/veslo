---
title: Event-Driven Conversation Run Lifecycle Implementation Plan
date: 2026-07-11
status: ready-for-implementation
done: false
repository_snapshot: veslo-main active working tree after server-owned transcript ingestion stabilization
depends_on:
  - docs/plans/2026-07-10-server-owned-transcript-ingestion-stability-implementation-plan.md
edl01_event_contract_done: false
edl02_orchestrator_event_bridge_done: false
edl03_server_terminal_handoff_done: false
edl04_watchdog_and_recovery_done: false
edl05_ui_boundary_and_observability_done: false
edl06_verification_and_docs_done: false
---

# Event-Driven Conversation Run Lifecycle Implementation Plan

## Canonical Status

done: false

Every phase begins with `done: false`. Mark a phase done only after its listed
codebase tests pass and its acceptance criteria are recorded. Desktop and E2E
tests are explicitly out of scope for this plan.

## Goal

Replace normal-path server lifecycle polling with an orchestrator-owned,
event-driven terminal handoff. A run terminal event must cause exactly one
durable lifecycle transition, canonical transcript ingest, cache invalidation,
and queue-drain decision without relying on the desktop app or inspecting a
partial UI transcript.

## Current Evidence And Problem

The current normal path is:

```text
server accepted run
  -> timer every 1 s
  -> server GET lifecycle status
  -> orchestrator run-registry probe
  -> GET OpenCode /session/status and /session/:id/message
  -> terminal detection, transcript ingest, queue drain
```

The last dev trace recorded 36 lifecycle reconciles in about 41 seconds:

- one completed run required 15 attempts while `assistant_message_open`;
- a second completed run required 3 attempts;
- an aborted run required 18 attempts, including active local-tool status.

The OpenCode `/event` stream already carries `session.idle`, `session.error`,
`message.updated`, and `message.part.updated`, but it is consumed by the
desktop app through the Tauri SSE bridge. The orchestrator owns the durable
run registry and engine identity, yet has no event consumer that terminalizes
the matching run. The server therefore polls the orchestrator status API. If a
successor is queued, it also schedules a second `queueDrainPollMs` loop while
the latest run remains active.

Latest runtime evidence, 2026-07-11 02:09 CEST:

- queued run `9267…` received 21 one-second lifecycle reconciles in about
  21 seconds with `waitReason: assistant_message_open`;
- the same conversation received 14 `queue-drain-scheduled` callbacks at
  1.5-second intervals during that active run;
- short normal runs still needed 3, 4, and 6 lifecycle status reads before
  their terminal state was observed.

The problem is therefore two normal-path polling loops, not just the
lifecycle reconcile timer.

## Target Architecture

```text
OpenCode /event (one orchestrator subscription per engine scope)
  -> normalized lifecycle-relevant event
  -> orchestrator run registry, matched by engine owner + OpenCode session
  -> durable terminal status transition
  -> server receives durable lifecycle terminal notification
  -> single-flight canonical transcript ingest
  -> transcript cache invalidation
  -> durable queue drain

desktop SSE
  -> render/cache only
```

The app is never a source for durable lifecycle state. The orchestrator is the
only component allowed to translate engine event state into a durable run
transition. The server remains the owner of transcript persistence and queue
drain.

## Hard Contracts

1. The event bridge is owned by the orchestrator, not the app and not a
   server-side proxy of an app SSE stream.
2. The bridge subscription identity is engine-owner scoped. In shared-engine
   topology it must multiplex sessions without creating one connection per
   run; in isolated topology it must stop when its engine owner stops.
3. A lifecycle event is matched only when `(engineOwner identity,
   workspaceId, normalized directory, OpenCode session id)` resolves to one
   active durable run. Ambiguous, stale-owner, or unknown-session events are
   recorded and ignored; they must never terminalize another run.
4. `session.idle` is a terminal candidate, not unconditional proof. The
   orchestrator must make one authoritative, run-scoped reconciliation before
   terminalizing when the event lacks an unambiguous terminal message/status.
5. Terminal transition is idempotent. Duplicate SSE frames, reconnect replay,
   and a simultaneous abort may emit at most one terminal notification and
   must preserve the first valid terminal outcome.
6. The terminal notification carries durable identifiers only:
   workspace id, conversation id, run id, normalized directory, OpenCode
   session id, terminal status, engine owner identity, and event sequence or
   generation. It carries no transcript payload.
7. The server reacts to a terminal notification by invoking the existing
   server-owned transcript ingest coordinator and queue drain exactly once per
   durable terminal transition. Queue drain does not wait for ingest retries.
8. The existing one-second lifecycle poll and `queueDrainPollMs` active-run
   retry remain unchanged until EDL04 switches both to watchdog behavior. Do
   not run old polling and the event bridge as parallel normal terminal paths.
9. A queued successor waits on the durable terminal transition for its
   conversation. It must not repeatedly poll `latest` while the active run is
   healthy; one bounded queue-recovery watchdog may be armed only when the
   bridge is degraded, the process recovered, or the terminal notification is
   missing past its silence deadline.
10. The watchdog is recovery-only: orchestrator event stream unavailable,
   restart recovery, missed-generation detection, or no lifecycle event within
   an explicit silence window. It is bounded, backoff-based, traceable, and
   cannot block queue drain forever.
11. Remote workspaces remain fail-closed unless their remote lifecycle owner
   implements the same terminal-notification contract.
12. No phase adds desktop/E2E tests. Use orchestrator, server, route, and
   source-owner tests.

## Implementation Order

### EDL01 — Define event and notification contracts

done: false

Files in scope:

- `packages/orchestrator/src/opencode-event-normalization.ts`
- `packages/orchestrator/src/run-registry.ts`
- `packages/orchestrator/src/run-store.ts`
- `packages/server/src/orchestrator-lifecycle-client.ts`
- new narrow orchestrator/server lifecycle-notification port and tests

Work:

1. Inventory real OpenCode event payload shapes already normalized by the
   app: `session.status`, `session.idle`, `session.error`, `message.updated`,
   and `message.part.updated`.
2. Define a versioned internal `RunLifecycleEngineEvent` and a separate
   `RunLifecycleTerminalNotification`; reject malformed values at the
   orchestrator boundary.
3. Add a run-registry method that accepts a matched event and returns either
   `ignored`, `reconcile-required`, or one idempotent terminal transition.
4. Persist enough monotonic event/generation state to reject reconnect replay
   without requiring global event ordering across different engine owners.
5. Define conflict precedence for `abort-requested`, engine loss, and engine
   terminal events. Document it beside the types.

Acceptance:

- Unknown, ambiguous, wrong-owner, and duplicate events cannot mutate a run.
- A terminal transition is distinguishable from a no-op in a typed result.
- Tests cover event shape validation, owner/session matching, replay, and
  abort-versus-terminal races.

### EDL02 — Add an orchestrator-owned OpenCode lifecycle event bridge

done: false

Files in scope:

- new `packages/orchestrator/src/run-lifecycle-event-bridge.ts`
- `packages/orchestrator/src/cli.ts`
- `packages/orchestrator/src/engine-pool.ts` and/or shared engine ownership
  seams as required
- `packages/orchestrator/src/router-proxy.ts` only if a shared stream helper
  can be safely reused
- focused orchestrator tests

Work:

1. Open one authenticated `/event?directory=...` subscription per normalized
   engine owner and directory scope; use the orchestrator's own proxy target,
   not the desktop Tauri command.
2. Parse SSE frames, normalize only lifecycle-relevant events, and dispatch
   them through EDL01. Do not relay transcript parts or UI events.
3. Implement explicit lifecycle states: connecting, connected, degraded,
   reconnecting, stopped. Reconnect must have bounded backoff and generation
   fencing.
4. Attach/detach bridge ownership with engine lifecycle. A stopped or replaced
   engine must cancel its subscription before a new generation begins.
5. On `session.idle` / `session.error`, perform at most one run-scoped probe
   when event data is insufficient; do not turn every message/part frame into
   a `/session/status` poll.
6. Emit structured trace events with workspace, run, OpenCode session, engine
   owner, event kind, generation, disposition, and probe cause. Never trace
   message text or part payloads.

Acceptance:

- One long tool run does not create repeated lifecycle status reads.
- One terminal engine event produces one terminal notification despite replay.
- Engine replacement cannot let the old subscription affect the new engine.

### EDL03 — Deliver durable terminal notification to the server

done: false

Files in scope:

- orchestrator lifecycle HTTP/control routes in `packages/orchestrator/src/cli.ts`
- `packages/server/src/orchestrator-lifecycle-client.ts`
- `packages/server/src/conversation-run-lifecycle-controller.ts`
- `packages/server/src/server.ts`
- focused server and route tests

Work:

1. Add an internal authenticated terminal-notification route or long-lived
   control channel from orchestrator to server. It must be idempotent by
   `(workspaceId, runId, terminal generation)`.
2. In the server lifecycle controller, add `handleTerminalNotification` that
   validates the durable run/session/directory binding before doing work.
3. Reuse one terminal-finalization function for current reconcile and the new
   notification path: unregister gateway context, request transcript ingest,
   invalidate through the ingest coordinator, and schedule queue drain.
4. Ensure duplicate notification, poll race, and abort race join the same
   finalization key and do not duplicate ingest or queue drain.
5. Keep terminal ingest asynchronous relative to queue drain, as in the
   current stable contract.

Acceptance:

- A notification produces one ingest request and one queue-drain schedule.
- Server rejects mismatched workspace/directory/OpenCode session identity.
- Existing recovery endpoint and normal conversation submit behavior remain
  compatible.

### EDL04 — Demote polling to bounded watchdog and startup recovery

done: false

Files in scope:

- `packages/server/src/conversation-run-lifecycle-controller.ts`
- `packages/server/src/server.ts`
- orchestrator bridge state/health seam from EDL02
- lifecycle controller tests

Work:

1. Remove accepted-run scheduling of the one-second normal reconcile loop once
   EDL02 and EDL03 are proven.
2. Remove `queueDrainPollMs` rescheduling while `latest` is healthy and active.
   Queue drain should instead subscribe to the terminal-finalization result for
   that conversation and run once when that result commits.
3. Replace both loops with watchdogs scheduled only for bridge-degraded,
   bridge-silent past a configured run deadline, or process-start recovery
   cases. Coalesce them by `(workspaceId, conversationId)` so a queued
   successor cannot create a second lifecycle-status loop for the active run.
4. Define fixed bounded retry policy, e.g. a small explicit delay array, max
   attempts, per-probe timeout, and terminal exhaustion disposition. Do not
   use a generic 600-attempt poll.
5. On watchdog exhaustion, preserve the durable active run unless stale/no
   progress policy proves it failed; record an actionable degraded state and
   leave future submit/queue decisions able to trigger one fresh reconciliation.
6. Retain direct abort reconciliation, but coalesce it with terminal events
   and use the same finalization key.
7. Remove obsolete environment variables or rename them to watchdog-specific
   names with migration tests and documented defaults.

Acceptance:

- A healthy active run and its queued successor have zero periodic lifecycle
  status or queue-drain polls after initial registration.
- An SSE outage has bounded recovery calls and no endless scheduler.
- Queue successor starts after event terminalization without waiting for the
  watchdog.

### EDL05 — Preserve UI boundary and add observability

done: false

Files in scope:

- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- server/orchestrator trace helpers
- targeted source-owner tests

Work:

1. Keep app SSE responsibilities limited to render state, local connection
   state, and explicit recovery request. It must not notify the server of
   terminal lifecycle events as authority.
2. Ensure app reconnect/recovery does not create a second terminal writer; it
   may request server recovery only through the existing idempotent route.
3. Add correlated trace vocabulary: bridge connected/disconnected, lifecycle
   event accepted/ignored, terminal transition, notification delivered/joined,
   watchdog scheduled/exhausted, terminal ingest requested, queue drain
   scheduled.
4. Add a diagnostic counter/snapshot for active bridge subscriptions and
   active watchdogs so runtime logs can distinguish engine restarts from UI
   rerenders.

Acceptance:

- No app production source calls a lifecycle terminalization API.
- One terminal run has a traceable chain from engine event to queue drain.
- A bridge reconnect does not remount or refresh right-sidebar resources.

### EDL06 — Verification and documentation

done: false

Required codebase verification:

1. `pnpm --filter veslo-orchestrator typecheck`
2. focused orchestrator bridge/run-registry tests
3. `pnpm --filter veslo-server typecheck`
4. focused lifecycle controller, orchestrator lifecycle client, transcript
   ingest coordinator, and conversation route tests
5. app targeted lifecycle recovery/event-stream source-owner tests
6. `git diff --check`
7. `rg` audit proving accepted runs no longer schedule the normal one-second
   reconcile loop, queued successors do not schedule active-run queue polling,
   and app has no durable terminal writer.

Completion checklist:

- [ ] Healthy terminal runs event-finalize exactly once.
- [ ] Duplicate/replayed events are harmless.
- [ ] Engine restart and abort races preserve durable ownership.
- [ ] Transcript ingest remains server-owned and queue drain is not blocked.
- [ ] Watchdog is recovery-only and bounded.
- [ ] Relevant tests and diff checks pass.

## Out Of Scope

- UI redesign, sidebar refresh refactors, and MCP refresh ownership.
- Mid-stream durable transcript checkpoints.
- Remote workspace lifecycle implementation.
- Desktop/Tauri pilots and E2E tests.
