---
title: Durable Terminal Handoff Barrier Implementation Plan
status: implemented
done: true
date: 2026-08-02
issue: unlinked
scope: unblock a durable queued successor only after the existing orchestrator evidence owner proves the exact previous engine generation gone; accurately project the result in an old conversation without moving lifecycle authority into the UI
related:
  - docs/dev/conversation-workflow-contract.md
  - docs/dev/conversation-history-resume.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/server-owned-composer-submit.md
  - docs/plans/2026-08-01-conversation-run-lifecycle-ownership-plan.md
---

# Durable Terminal Handoff Barrier Implementation Plan

## Implementation decision

Fix the stale-old-run queue deadlock in the Veslo server. Do not rewrite
conversation history, the desktop queue, OpenCode, or the orchestrator engine
pool.

The server will add one small durable record named a **terminal handoff
barrier**. It represents one fact only: a queued intent for one conversation is
waiting for one exact terminal stale predecessor to be proven safe for a
successor. The record is separate from a run reservation because a predecessor
can legitimately predate, or survive independently of, the reservation that
would otherwise store this state.

The orchestrator continues to own exact engine-generation evidence. The server
continues to own admission, reservation release, FIFO dispatch, and barrier
state. The app continues to own editable intent and projection only.

## Implementation result (2026-08-03)

Implemented in the server queue store and lifecycle controller. The durable
barrier is persisted independently of reservations, has the planned
`observed -> evidence_requested -> resolved|unresolved` transitions, and is
recovered as `unresolved` after a process restart if a recovery result was not
durably confirmed. A confirmed terminal idle/lost result resolves it; normal
FIFO claim removes resolved barriers atomically. Existing status responses now
project the barrier (including the blocking predecessor run) for both that run
and a queued successor, and the existing explicit retry route reopens the
matching barrier without creating a replacement reservation.

Focused SQLite and lifecycle-controller regression tests cover the original
reservationless predecessor, ambiguous evidence, restart recovery, explicit
retry scope, and normal release. The orchestrator generation-proof boundary
was deliberately reused unchanged.

## Verified codebase starting point

The following is already implemented and is deliberately retained:

| Existing capability | Current Veslo owner | Implementation decision |
| --- | --- | --- |
| Typed unavailable evidence, including `no_current_engine` | Orchestrator run probe and run registry | Reuse unchanged. Only this reason can start a handoff check. |
| Durable engine-generation identity with Windows process-birth inspection | `EngineGenerationAuthority` | Reuse unchanged. It already persists creating/live/stopping/confirmed-exit state and fails closed on an ambiguous process. |
| Proof-gated terminal-handoff route | Orchestrator lifecycle route | Reuse unchanged. It already requires a terminal stale exact run, no active peer, no current engine, then `lost_proven` before the exact run becomes lost. |
| Reservation-before-registration and FIFO queue claim | Server queue store and lifecycle controller | Reuse unchanged. A barrier is not a reservation and may not dispatch work itself. |
| Typed terminal-handoff status, retry intent, and selected-session presentation | Server status route and app lifecycle presentation | Preserve the DTO and UI flow; change only where the server obtains its handoff state. |

The remaining defect is entirely on the server side:

1. The controller observes a terminal stale predecessor with
   `no_current_engine`.
2. It tries to persist terminal-handoff state on that predecessor's reservation.
3. In the reproduced old-conversation case that reservation does not exist,
   while a later user intent is safely present as a durable queue item.
4. Persistence returns nothing, the controller records `reservation_missing`,
   and it suppresses recovery. The queued intent can then wait indefinitely.

Do not make the newer queued item's reservation stand in for the old run. The
two runs have different identities and conflating them would create a second,
ambiguous release authority.

## Concrete implementation map

| Target | Change in this plan |
| --- | --- |
| `packages/server/src/conversation-run-queue-store.ts` | Add the barrier schema, typed store contract, atomic transitions, and resolved/unresolved cleanup. |
| `packages/server/src/conversation-run-lifecycle-controller.ts` | Replace the `reservation_missing` suppression path with barrier-driven handoff and deterministic restart handling. |
| `packages/server/src/routes/conversations.ts` | Project barrier state in existing run-status responses and validate/reopen a matching barrier through the existing retry route. |
| `packages/server/src/tests/conversation-run-queue-store.test.ts` | Prove SQLite identity, atomicity, restart, and cleanup semantics. |
| `packages/server/src/tests/conversation-run-lifecycle-controller.test.ts` | Reproduce the no-predecessor-reservation deadlock and prove exactly-once recovery/dispatch. |
| `packages/server/src/tests/server-conversations.test.ts` | Prove status and explicit-retry API behavior for a queued successor. |
| `packages/orchestrator/src/tests/engine-generation-authority.test.ts` and lifecycle route tests | Retain the existing proof boundary; add only missing server-to-orchestrator integration cases. |
| `packages/app/src/app/pages/session-run-presentation.ts` and `packages/app/src/app/context/session-lifecycle-recovery.ts` | Retain the existing typed projection/retry path; change only if tests expose a missing barrier status or scope fence. |
| App projection and selection tests | Prove a late old-session status/history result cannot alter the newly selected conversation. |

## Target ownership and state contract

| Component | It may do | It must not do |
| --- | --- | --- |
| Engine generation authority | Prove `lost_proven`, `live_or_ambiguous`, or `unknown` for one attached owner tuple. | Release a reservation, start a successor, or decide UI state. |
| Orchestrator run registry | Perform the exact fenced `attached -> lost` transition after `lost_proven`. | Infer death from pool absence, PID alone, transcript, or timeout. |
| Terminal handoff barrier store | Persist and deduplicate one blocked-handoff decision for a conversation. | Create/delete a run reservation, submit a prompt, or decide engine liveness. |
| Server lifecycle controller | Create/advance the barrier, consume orchestrator evidence, release only a matching reservation, and wake normal FIFO draining. | Infer owner loss itself or make a direct engine-control call. |
| Desktop app | Render history, durable queued intent, and typed handoff state; send explicit retry intent. | Retry automatically, release a queue item, decide terminality, or restart runtime. |

The durable state machine is intentionally small:

```text
observed -> evidence_requested -> resolved
                            \-> unresolved
```

- `observed`: the server saw a durable waiting item blocked by an exact stale
  terminal predecessor.
- `evidence_requested`: request identity was durably fenced before the
  orchestrator call.
- `resolved`: owner loss was proven and the server's fresh lifecycle read says
  the predecessor is ready for normal release/drain handling.
- `unresolved`: owner evidence was live, ambiguous, unavailable, or the
  request outcome is unknown. It is an admission fence and stops automatic
  polling.

The active barrier key is the exact tuple:

```text
workspaceId + conversationId + blockingRunId + engineOwnerFingerprint
```

Only one active barrier is permitted for a workspace/conversation. Existing
admission already ensures there cannot be two independently blocking runs for
one conversation.

## Action-taking implementation sequence

### 1. Freeze the present bug with failing tests

Change no production behavior before these tests fail for the current source.

1. In the server lifecycle-controller test suite, construct a terminal stale
   run `old-run` that has a complete attached engine tuple but **no** server
   reservation. Add one durable pending queue item `new-run` for the same
   workspace/conversation.
2. Make lifecycle status return `stale: true`, terminal status,
   `runtimeReadyForSuccessor: null`, and `unavailableReason:
   no_current_engine` for `old-run`.
3. Assert the desired contract: one barrier is persisted, the handoff endpoint
   is called once, and `new-run` remains pending until a fresh `lost_proven`
   result is followed by runtime-ready evidence. This test fails against the
   current `reservation_missing` path and remains unchanged after the fix.
4. In the queue-store test suite, add empty tests for barrier identity,
   idempotent request claiming, unresolved reopening, and removal after a
   successful queue claim. They define the storage API before controller code
   uses it.
5. Keep the existing orchestrator authority tests as the proof for exact
   process evidence. Add only missing integration coverage for the route's
   `lost_proven`, live, unknown, and PID-reuse results; do not reimplement the
   authority in the server.

### 2. Add the barrier to the existing server queue store

Modify the existing server queue SQLite store; do not create a new database or
another generic lifecycle service.

1. Add a `conversation_terminal_handoff_barrier` migration. Its columns are:

   ```text
   workspace_id, conversation_id, blocking_run_id, owner_fingerprint,
   state, probe_reason, evidence_fingerprint, evidence_id,
   safe_outcome_reason, first_waiting_queue_item_id,
   requested_at, decided_at, resolved_at, attempt_count,
   created_at, updated_at
   ```

2. Add a partial unique index that permits one active (`observed`,
   `evidence_requested`, or `unresolved`) barrier per
   `(workspace_id, conversation_id)`. Keep a unique exact barrier identity as
   well. Store only opaque ids and finite reason codes; never store prompt
   text, transcript content, URL, PID, process-birth token, headers, or raw
   upstream error bodies.
3. Add a small `ConversationTerminalHandoffBarrier` type and these store
   operations:

   ```text
   getActiveTerminalHandoffBarrier(workspaceId, conversationId)
   observeTerminalHandoffBarrier(input) -> barrier
   claimTerminalHandoffEvidence(input) -> { barrier, requestRequired }
   resolveTerminalHandoffBarrier(input) -> barrier
   markTerminalHandoffBarrierUnresolved(input) -> barrier
   reopenTerminalHandoffBarrier(workspaceId, conversationId, runId) -> barrier | null
   consumeResolvedTerminalHandoffBarrierForQueueClaim(queueItemId) -> boolean
   clearTerminalHandoffBarrierIfNoWaitingItem(workspaceId, conversationId)
   ```

4. Make `observe`, `claim`, `resolve`, `unresolve`, and queue-claim consumption
   compare the exact owner/evidence fingerprint in SQL. A repeated timer,
   reconnect, or server restart returns the existing row and never grants a
   second recovery call.
5. Retain `resolved` only until the normal queue store has atomically claimed
   one successor as `starting`; then remove it in the same transaction. Retain
   `unresolved` only while a queue item remains blocked; cancellation of the
   last waiting item removes it. Traces, not an ever-growing table, hold the
   diagnostic history.
6. Leave the existing `terminal_handoff_*` reservation columns readable during
   migration, but stop using them as a handoff decision source. They may become
   a compatibility mirror temporarily; they must not race the barrier to decide
   release.

### 3. Move stale-terminal recovery in the server controller onto the barrier

Change the existing lifecycle-controller branch that currently suppresses
recovery when `persistTerminalHandoffPending` returns no predecessor
reservation.

1. At the queue-drain boundary, after selecting the oldest pending item, read
   latest lifecycle state for that conversation as it already does.
2. Only when the latest run is terminal, stale, not ready for a successor, and
   has `no_current_engine`, call `observeTerminalHandoffBarrier` with:

   - the selected waiting queue item;
   - the blocking run id;
   - the immutable owner fingerprint from lifecycle evidence; and
   - the exact finite probe reason.

   All other active, terminal-ready, timeout, HTTP, transport, or missing
   session states retain their existing reconciliation behavior.
3. Call `claimTerminalHandoffEvidence` before invoking the existing
   `recoverTerminalRuntimeHandoff` client method. Call the orchestrator only
   when `requestRequired` is true.
4. Remove the process-local stale-handoff attempt map from this correctness
   path. A keyed scheduler may still coalesce callbacks, but durable barrier
   state is the only retry/restart authority.
5. On `lost_proven`, immediately read the exact lifecycle result again. Mark
   the barrier `resolved` only when it now reports terminal and
   `runtimeReadyForSuccessor: true`.
6. After that resolution commits:

   - release the predecessor reservation only if an exact matching reservation
     really exists;
   - otherwise release nothing;
   - wake the existing FIFO drain path once; do not submit a prompt directly
     from barrier code.

7. On an ambiguous/live/unknown result, request error, or outcome-unknown crash
   window, mark the barrier `unresolved`, emit one finite reason, and cancel
   the automatic reconcile loop for that handoff. Do not restart, suspend, or
   replace an engine.

### 4. Make restart recovery deterministic

Use the barrier state during existing queue/startup recovery; do not add a
background sweep in this change.

| Restart point | Required server action |
| --- | --- |
| Before evidence claim | Re-read queue/lifecycle; observe or claim normally. |
| After evidence claim, before HTTP response | Re-read exact lifecycle once. If it is already lost/ready, resolve; otherwise mark the barrier unresolved. Do not resend the request automatically. |
| After `lost_proven`, before barrier resolution | Re-read lifecycle and resolve only if ready. |
| After resolution, before queue claim | Existing queue recovery sees the resolved barrier and performs one normal claim. |
| After queue claim | Consume/delete the resolved barrier with that claim; existing starting-row recovery remains responsible for the claimed item. |

An explicit retry operates only on an `unresolved` barrier for the same
workspace/conversation and matching blocking run. It performs one fresh fenced
evidence request. A run id from the client is a target hint and validation key,
not the authority that selects a barrier or proves owner loss.

### 5. Rewire the existing server status and retry projection

The app already has `terminalHandoff` DTOs, presentation states, and an
explicit retry button. Preserve them instead of adding another UI controller.

1. Change the server's run-status serialization to obtain terminal-handoff
   state from the active barrier for the scoped conversation, rather than only
   from the reservation whose run id was requested.
2. Return the existing `pending`/`unresolved` DTO to both the blocking run and
   the currently queued successor for that conversation. This lets the pending
   user row show its real server-owned wait state even when the predecessor has
   no reservation.
3. Change the retry route and controller method to look up and reopen the
   matching barrier. Keep the existing scoped URL/client surface if practical,
   but reject a request when its conversation/run does not match the barrier.
4. Keep app retry behavior explicit. It may render the returned status and
   restart its normal status watch; it must not retry because of polling,
   remount, stream reconnect, opening an old conversation, or a local idle
   observation.
5. Keep the current selected-scope guards in the queue projection and lifecycle
   recovery paths. Add tests proving that a late status or history response for
   an old session cannot update the transcript, spinner, recovery action, or
   queue panel of a newly selected conversation.

### 6. Add bounded, causal diagnostics

Use the existing send-workflow trace infrastructure. Add one event for each
state transition, not one event per poll:

```text
terminal-handoff-barrier-observed
terminal-handoff-barrier-evidence-requested
terminal-handoff-barrier-resolved
terminal-handoff-barrier-unresolved
terminal-handoff-barrier-request-suppressed
terminal-handoff-barrier-cleared
```

Each event includes only workspace/conversation/run/queue opaque ids, a finite
reason, whether a predecessor reservation existed, barrier state, and attempt
number. It excludes message bodies, transcript, raw URL, local path,
credentials, process output, PID, process-birth token, and raw provider body.

### 7. Update canonical behavior documentation after code lands

Update the current workflow and runtime architecture documentation, not this
plan alone, to state:

- historical transcript is display/recovery data and never runtime-ready
  evidence;
- the server barrier is the durable owner of an unresolved stale-terminal
  handoff, including the no-predecessor-reservation case;
- the orchestrator authority supplies proof only;
- the UI projects state and sends one explicit retry-verification intent.

## Required verification

### Focused regression coverage

1. Barrier store: unique active barrier, idempotent claim, no duplicate request
   after reopen/restart, resolve-to-queue-claim cleanup, and cancellation
   cleanup.
2. Lifecycle controller: the exact `old-run` without reservation plus queued
   `new-run` reproduction now creates one barrier, calls recovery once, and
   dispatches `new-run` once only after `lost_proven` and fresh ready evidence.
3. Lifecycle controller: live process, PID reuse, unknown inspection, active
   peer, timeout, HTTP failure, and missing session never release or dispatch.
4. Restart: preserve the queue/store database across every row in the restart
   table; assert no duplicate orchestrator recovery call and no duplicate
   provider submit.
5. Route/client/app: queued successor receives the barrier projection; retry is
   explicit and scoped; stale old-session responses cannot alter a new selected
   session.
6. Orchestrator: retain and run the existing generation-authority and
   proof-gated-route tests. Add only missing cross-module proof that the server
   consumes `lost_proven` rather than replacing it with pool absence.

### Service and desktop proof

1. Build the Veslo server binary and orchestrator binary.
2. Add a deterministic service-chain scenario using preserved server and
   orchestrator data, an actual OpenCode child, and a durable queued successor.
   It must reproduce the missing-predecessor-reservation case, restart both
   services across the defined crash windows, then verify one successor submit
   after the exact old child is proven absent.
3. Add a focused WebDriverIO desktop scenario after the documented single
   tenant preflight. It opens an old conversation, sends a successor, shows
   the server-owned waiting/unresolved state, navigates away and back, verifies
   no cross-conversation spinner/projection leak, then completes after the
   deterministic owner-loss proof. Keep a redacted diagnostic artifact.
4. Run the normal server build, the relevant focused tests, the workspace
   engine/service gates selected by the testing playbook, and `pnpm check` for
   the final source-code handoff.

## Acceptance criteria

1. The exact current `reservation_missing` reproduction no longer suppresses
   recovery: it creates one durable barrier and retains the queued intent.
2. Pool absence, a stale heartbeat, a timeout, a PID, UI state, or transcript
   never releases a reservation or starts a successor.
3. Only the existing generation authority's `lost_proven` result can permit
   the exact old run to transition to lost.
4. A server or orchestrator restart at any handoff step cannot duplicate a
   recovery request or provider submit.
5. An ambiguous or unavailable proof produces a durable visible unresolved
   state and stops automatic polling; only explicit retry verification can
   request another evidence read.
6. The server remains the only queue/admission/release owner. The barrier is a
   narrow server record, not a second queue or lifecycle framework.
7. An old transcript remains visible as history, while active/waiting UI state
   comes only from a server-scoped run or barrier projection for that same
   selected conversation.
