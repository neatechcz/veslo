---
title: Narrow Run Delivery Snapshot and Router Correlation Plan
status: proposed
done: false
date: 2026-07-30
scope: prompt_async run diagnostics only; server, orchestrator router, existing app projection boundaries, and headless service-chain verification
runtime_code_changed: false
e2e_required: false
related:
  - docs/plans/2026-07-24-vslo-282-duplicate-transcript-premature-terminal-recovery-plan.md
  - docs/plans/2026-07-28-cold-runtime-readiness-single-engine-admission-plan.md
---

# Narrow Run Delivery Snapshot and Router Correlation Plan

## Decision

Implement only a small, server-owned **RunDeliverySnapshot** for a single
`prompt_async` run. Its purpose is evidence, not delivery reliability:

```text
accepted run
  -> engine/session binding
  -> router saw session-bearing events
  -> app accepted or rejected events
  -> app committed transcript mutations
  -> terminal canonical recovery / visible presentation outcome
```

The snapshot answers why an assistant run completed without visible output:
whether no upstream event was seen, the app rejected it, the store committed it,
or the presentation hid/replaced it. It is deliberately not a new transcript
store, generic event bus, replay protocol, or UI recovery mechanism.

A router relay/checkpoint is a separate Phase 2 design. It may be considered
only when this evidence proves that a live event was lost before the app/store
boundary and product considers that loss unacceptable.

## What this plan does not fix

The snapshot must keep the following fault families separate:

- A new conversation being sent to a previous OpenCode session is a
  pre-admission UI/navigation race. Its immediate displayed-session detachment
  remains an independent correctness fix.
- Missing workspace Skills in a sidebar is inventory/projection work. The
  snapshot can show the admitted Skill revision but must not refresh the
  sidebar or change Skills materialization.
- A progress step that the UI intentionally groups, filters, or collapses is a
  presentation decision, not a transport loss. The snapshot labels that result
  but does not change product visibility policy.

## Current model and confirmed gap

Veslo has two legitimate transcript paths:

```text
OpenCode live SSE -> native bridge -> app event stream -> in-memory UI store

OpenCode canonical transcript -> server host store -> terminal recovery -> UI hydration
```

The first is low-latency but has no Veslo-owned in-run event history. The
second is server-owned canonical recovery, not an event-by-event replacement.
The transcript ingest coordinator remains its sole persistence/retry owner.

On a cold workspace the desktop can expose the daemon-backed proxy descriptor
before an engine exists. `GET /event` is intentionally non-starting, while the
first write starts the engine. The app's current event readiness is therefore
best effort: it may attach before early events, but it receives no server-side
acknowledgement that an event stream was ready before the first OpenCode event.
This is an architectural delivery race. It does not prove the cause of any
specific past incident until a controlled run records it.

## Existing truth and correlation map

Phase 1 begins by joining existing facts rather than duplicating them.

| Existing source | Current owner | Existing fields/evidence | Missing edge this plan adds |
| --- | --- | --- | --- |
| Send workflow trace | app, server, orchestrator | `traceId`, workspace, conversation/run/session context, request phases, safe path digests | A stable per-run diagnostic read model; logs alone cannot answer one run after the fact. |
| Conversation/run state and queue | server | `workspaceId`, `conversationId`, `runId`, `reservedRunId`, `clientMessageId`, terminal status | A compact view that joins run lifecycle with router and renderer outcomes. |
| Run registry / engine owner | orchestrator | exact `engineOwnerId`, process generation, directory epoch, attached/lost state | The exact served generation beside the delivery result. |
| Router proxy trace | orchestrator | request ID, route family, method, status, duration, upstream start/end, binding envelope | Session-bearing event observation counts, kept separate from one shared stream connection. |
| App event stream/store diagnostics | app | binding validation, local session routing, store/projection/hydration behavior | Three bounded aggregate reports for the exact run. |
| Terminal ingest and lifecycle recovery | server and app lifecycle owners | recovery request/result, canonical snapshot adoption, terminal fence | Whether canonical recovery completed and what the renderer finally presented. |

The required first artifact is a checked-in field map that lists every snapshot
field, its existing source owner, and its privacy classification. A proposed
field without a source is not added merely because it would be convenient.

## Ownership and truth boundaries

| Question | Authority | Snapshot role |
| --- | --- | --- |
| What OpenCode actually executed and its canonical transcript | OpenCode | Not copied; terminal recovery remains the canonical read path. |
| Which Veslo run, session, workspace, authorization, and engine generation are valid | Veslo server and orchestrator | Root identity and exact binding. |
| Which session-bearing events the router observed | Orchestrator router | Aggregate observation only. |
| Whether the app accepted/rejected and committed a visible mutation | App | Aggregate best-effort report only. |
| What the user can currently see | App presentation | Terminal outcome only; it is not execution authority. |

One stream connection can carry many sessions and many runs. A
`streamConnectionId` is therefore stream-scoped diagnostic metadata and is
never owned by one `RunDeliverySnapshot`. Events without a trustworthy session
identity stay unbound. They are never attributed using the selected tab,
foreground workspace, or most recent run.

## RunDeliverySnapshot v1

The snapshot is one bounded row/object per admitted `prompt_async` run. It is
overwritten by idempotent stage updates, not appended as a per-event ledger.

```ts
type RunDeliverySnapshotV1 = {
  schemaVersion: 1
  workspaceId: string
  conversationId: string
  runId: string
  clientMessageId: string
  traceId: string | null // existing valid send correlation, not a new authority
  opencodeSessionId: string | null
  engineOwnerId: string | null
  directoryInstanceEpoch: number | null

  admission: { acceptedAt: string; dispatchObservedAt?: string }
  router: {
    sessionBoundEventCount: number
    firstObservedAt?: string
    lastObservedAt?: string
  }
  app?: {
    acceptedEventCount: number
    rejectedEventCount: number
    rejectedByReason: Record<DeliveryReasonCode, number>
    storeCommitCount: number
    firstObservedAt?: string
    lastObservedAt?: string
    reportedAt: string
  }
  terminal?: {
    lifecycle: "completed" | "failed" | "aborted" | "unresolved"
    canonicalRecovery: "not_requested" | "recovered" | "unavailable" | "failed"
    hydration: "not_attempted" | "adopted" | "skipped" | "failed"
    presentation: "visible_output" | "hidden_progress" | "no_visible_output" | "unknown"
    reportedAt: string
  }
  recording: "recorded" | "incomplete"
  recordedAt: string
}
```

`firstObservedAt` and `lastObservedAt` are local observation times. `reportedAt`
is when the desktop/app sent an aggregate. `recordedAt` is when the server
stored it. They are intentionally distinct: server receipt order is not a
global causal order across the router, desktop, and app.

The snapshot holds at most eight allowlisted rejection reason buckets. The
initial list is:

```text
missing_binding_envelope
binding_workspace_mismatch
unknown_session
stale_generation
background_workspace_policy
duplicate_event
invalid_event_shape
other_allowlisted_rejection
```

It never stores transcript text, prompts, tool arguments/output, raw OpenCode
event bodies, engine URLs, local paths, MCP URLs/headers, tokens, or raw config.
The existing engine/Skill/config correlation remains in its existing traces;
Phase 1 stores only exact run/session/generation identity needed to diagnose
delivery.

### Locked retention and failure policy

- Retain at most **64 terminal snapshots per workspace** and no snapshot longer
  than **7 days**. Evict oldest terminal snapshots first.
- Bound one serialized snapshot to **16 KiB**. Counters saturate safely and
  reason buckets are capped at the allowlist above.
- App reporting is at most **three best-effort aggregate writes per run**:
  event acceptance/rejection aggregate, store-commit aggregate, and terminal
  hydration/presentation aggregate. No per-part IPC and no retry loop.
- If the snapshot store or internal report route is unavailable, sending,
  routing, engine lifecycle, transcript ingest, and UI rendering continue
  unchanged. The writer drops that report, records one safe local warning when
  available, and does not retry. A surviving snapshot is marked `incomplete`;
  a missing one reads as `not_recorded`.
- The diagnostic read endpoint is bounded and read-only. It never waits for a
  run to finish and cannot make a workspace engine start.

## Narrow API

```text
GET /workspace/:workspaceId/conversations/:conversationId/runs/:runId/delivery
```

It returns either the one snapshot, `not_recorded` for legacy/no-diagnostic
work, or `incomplete` where an optional reporter was unavailable. It has no
cursor, no stream endpoint, no generic query language, and no transcript
payload.

There is one authenticated internal upsert contract. The server validates the
exact run/session/generation relationship, allowlists fields and reasons, and
performs the bounded merge. Router and app callers remain thin. An invalid,
late, or replacement-generation report is ignored or recorded only as the
allowlisted rejection count; it cannot change lifecycle state.

## Implementation slices

### RDS00 — existing-field map and snapshot store

State: proposed

1. Produce the field map described above from live source contracts and remove
   any proposed field already available through a stable existing trace/read.
2. Add the one bounded server snapshot store, retention policy, internal upsert
   validator, and diagnostic read endpoint.
3. Create the snapshot only after the server accepts a `prompt_async` run.
   Bind the existing run/session/client-message identities; legacy runs return
   `not_recorded`.
4. Add focused tests for authorization, cross-workspace rejection, redaction,
   cap/TTL eviction, idempotent merge, and unavailable-store fail-open behavior.

Exit: an accepted prompt run has one small queryable diagnostic object without
changing any OpenCode request, engine, configuration, or transcript write.

### RDS01 — router and app aggregates

State: proposed

1. Extend the existing safe router observer with an internal aggregate update
   when it sees a session-bearing SSE event that the server can bind to the
   exact active run. Preserve the existing `vesloBinding` authorization
   envelope; do not add a second public SSE envelope in this slice.
2. Record engine owner/session binding and dispatch observation from existing
   run-owner/proxy seams. A generic stream connection remains unowned by a run.
3. Add local counters in the existing app event-stream/projection owners. Flush
   the three bounded aggregate reports only at their established boundaries;
   do not report individual message or part events.
4. Keep unknown-session rejection fail-closed and report its reason. Do not add
   foreground fallback behavior to make a counter look healthier.
5. Let terminal lifecycle recovery add the final canonical/hydration/presentation
   aggregate. It remains a diagnostic report, not a second terminal owner.

Exit: one snapshot distinguishes router-observed, app-rejected, store-committed,
terminally recovered, and intentionally hidden output without claiming a total
order of all events.

### RDS02 — focused verification

State: proposed

Use the existing compiled server + orchestrator + fake-OpenCode integration
oracle. Extend the fake service to emit a deterministic cold-start sequence:

```text
1. start real compiled server and built orchestrator with no engine
2. request a non-starting event attachment; prove it does not create an engine
3. submit one prompt_async run; fake OpenCode emits session, tool, delta, and
   terminal events immediately after the write admits the engine
4. query the snapshot after terminal recovery
5. assert exact run/session/generation binding and router observed count
6. repeat with a missing/mismatched binding and assert an unbound/rejected,
   never foreground-attributed, outcome
7. kill the engine; assert the replacement generation cannot update the old run
```

Keep renderer verification focused and separate:

- an app event-stream test proves accepted/rejected and store-commit counters
  are aggregated once, not emitted per part;
- a presentation test proves `visible_output`, `hidden_progress`, and
  `no_visible_output` are classified from the existing projection policy;
- one real desktop manual acceptance run verifies "first message, early events,
  visible assistant output" before this plan may be marked done. It is not an
  automated Tauri Pilot deliverable in this plan.

<!-- Superseded malformed rendering kept only to make this text replacement
     non-destructive in the dirty worktree; remove with the next plan edit.
- one real desktop manual acceptance run verifies “first message, early events,
  visible assistant output” before this plan may be marked done. It is not an
  automated Tauri Pilot deliverable in this plan.

-->

The headless fixture is deliberately not a Skills/Soul/MCP omnibus test.
Existing configuration and runtime compatibility tests remain required gates;
the snapshot slice adds only a narrow regression assertion that it did not
trigger Skill discovery/publication, Soul materialization, MCP mutation/auth,
config reload, or engine replacement.

Exit: a cold headless service-chain artifact can classify a missing-output run
through router and server boundaries, while one real desktop check validates
the final visible-output claim.

### RDS03 — evidence review and Phase 2 decision

State: proposed

1. Compare cold and warm snapshots. Use local observation/report/record times,
   never server receipt order alone, to identify a possible gap.
2. Classify every incident as upstream absent, router not observing,
   app-rejected, store-committed-but-hidden, canonical-recovery-only, or
   incomplete diagnostics.
3. Keep the current design if no unacceptable pre-app/store loss is measured.
4. If loss is confirmed, write a **new** relay/checkpoint plan with its own
   retention, readiness acknowledgement, replay, crash, and backpressure
   contracts. Do not extend this snapshot plan opportunistically.

## Compatibility guardrail, not Phase 1 scope

Skills, Soul, MCP, Plugins, agents, commands, Managed AI, directory mapping,
and sandboxing remain execution-profile owners. Phase 1 must preserve their
current behavior but does not re-test or redesign every feature in its first
service-chain fixture.

The required narrow compatibility contract is:

```text
delivery snapshot work must not call or await:
  Skill candidate discovery/publication
  Soul materialization
  MCP auth, configuration mutation, or warm-up
  config synchronization/reload
  engine replacement
```

The existing runtime configuration gates remain the broader proof that Skills,
Soul instructions, MCP configuration, and allowed plugins/agents/commands
reach OpenCode correctly. When a later relay phase is proposed, it must add a
dedicated configuration-preservation matrix before implementation; it is not a
reason to block this small evidence slice.

## Acceptance criteria

1. A `prompt_async` run can be queried as one bounded snapshot using its
   existing workspace/conversation/run identity.
2. The snapshot has one unambiguous owner for every field and no duplicate raw
   tracing system.
3. A stream connection is never treated as belonging to a single run; unbound
   events are never associated using UI selection.
4. Router, app, and server times are explicitly separated; no field claims a
   false global event order.
5. Retention, size limits, report count, and unavailable-store behavior follow
   the locked policy above and cannot create retry/IPC pressure.
6. The headless real server + orchestrator test covers cold admission, early
   events, binding mismatch, terminal recovery, and generation loss.
7. Focused app tests cover aggregate acceptance/rejection, store commit, and
   presentation classification; one real desktop run verifies visible output.
8. The slice does not change transcript authority, event authorization,
   pre-admission navigation/session behavior, Skills/Soul/MCP ownership, or
   engine/configuration lifecycle.
9. No relay/replay code is introduced unless RDS03 supplies evidence and a new
   approved Phase 2 plan.

## Non-goals

- A generic event ledger, event bus, workflow engine, or second transcript
  database.
- Per-event or per-part renderer IPC/reporting.
- A new SSE envelope, Last-Event-ID replay contract, or snapshot stream API.
- Fixing previous-session send races, sidebar Skills projection, or intentional
  progress grouping as part of transcript transport diagnostics.
- Replacing canonical OpenCode transcript recovery.
- Changing engine topology, config policy, or feature refresh semantics.
