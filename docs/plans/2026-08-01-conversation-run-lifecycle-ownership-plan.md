---
title: Conversation Run Lifecycle Ownership Consolidation
status: implemented
done: true
date: 2026-08-01
issue: unlinked
scope: local desktop server-owned conversation submission, durable queue, orchestrator run lifecycle, and app lifecycle projection
related:
  - docs/dev/conversation-workflow-contract.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/plans/2026-07-31-retry-error-containment-audit-plan.md
---

# Conversation Run Lifecycle Ownership Consolidation

## Decision

Veslo will not merge the server queue and the orchestrator run database into a
single storage system. They represent different durable concerns. It will,
however, establish one command owner for the lifecycle of a conversation run:
the server-side conversation lifecycle coordinator.

The coordinator owns admission, durable queue state, server reservation
release, abort workflow, reconciliation scheduling, and user-visible lifecycle
projection. It asks the orchestrator for evidence about an exact run; it must
not independently infer that evidence from a transcript, SSE, a successful
`prompt_async` response, or a timeout. The orchestrator owns the engine-facing
evidence and its own durable execution state transition. It does not own, and
cannot report, that the server has released a reservation or that a queued
successor may be admitted.

The desktop app owns user intent, its scoped local draft queue, and
presentation. Once a submit is accepted, it neither releases a server queue
nor declares an engine run terminal.

```text
desktop app
  -> submit / abort intent and presentation
server conversation lifecycle coordinator
  -> admission, queue, release ordering, retries, safe projection
orchestrator execution authority
  -> exact-run activity evidence and durable execution transition
OpenCode
  -> engine status and transcript evidence
```

This is an ownership consolidation, not a rewrite of the send stack and not a
new generic workflow engine.

## Problem

The current architecture has sensible components but an implicit boundary:
the orchestrator registry can reconcile transcript and OpenCode session status,
while the server controller reacts by draining the next queued item. If the
meaning of a state is not explicit at that boundary, one layer can treat a
terminal assistant transcript as permission to admit the next prompt while
OpenCode still reports that the exact session is busy.

That race can accept a successor request but leave it undispatched. The
subsequent provider-start timeout is a later symptom, not the primary cause.

The desired long-term property is:

> A successor is admitted only by the server coordinator, after it has
> consumed trustworthy terminal evidence for the exact active run and durably
> released the server reservation. Every other signal is evidence or
> presentation, never admission permission.

## Ownership model

| Concern | Owner | May decide | Must not decide |
| --- | --- | --- | --- |
| Exact OpenCode state and durable run transition | Orchestrator execution authority | Evidence that the admitted run is active, terminal, or unavailable; exact execution transition | Queue release, admission permission, user retry policy, or UI presentation |
| Conversation admission and durable queue | Server lifecycle coordinator | Whether a next queued item may start; ordering of terminal write, release, and queue wake | Terminality from a raw SSE event or a locally guessed transcript state |
| Abort and timeout workflow | Server lifecycle coordinator | Bounded recovery, terminalization retry, and safe queue retention | Repeating the original OpenCode submit without an explicit user intent |
| UI local draft queue, drafts, local echo, and status display | Desktop app | What the user sees, which explicit intent is retained locally, and when it is submitted to the server | Queue release, terminal transition, or engine admission |
| Engine facts | OpenCode | Session status and message/transcript data | Veslo queue or user-facing policy |

The source of truth is split by responsibility, but the command path is not:
server coordination is the only place that can advance a conversation from one
durably queued run to the next. Orchestrator terminality is necessary evidence
for that action, not a parallel admission state.

## Non-negotiable invariants

1. The server holds at most one exact active reservation for a conversation.
   A later user intent becomes a durable queued item or an idempotent replay;
   it does not become a second engine submit.
2. Server reservation release follows consumed exact terminal evidence and a
   committed server release decision. If a required terminalization transition
   fails, the reservation is retained and recovery is retried; it never falls
   through to a queue drain.
3. The orchestrator evaluates the exact admitted message/run identity. Older
   transcript messages and app-local state cannot terminalize a newer run.
4. A terminal transcript while the exact OpenCode session is still `busy` is
   useful delivery evidence but blocks successor admission.
5. `retry`, unreachable, missing transcript, and no-output diagnostics are
   distinct states. None is silently converted into an admission permission.
6. App polling and transcript catch-up are read-only with respect to durable
   run ownership and queue state.
7. Every terminalization attempt and queue-admission decision records an
   exact run id, reason code, and safe evidence summary in diagnostics.
8. The workspace execution gate protects only explicitly documented shared
   workspace critical sections. It never silently changes the
   per-conversation queue ordering policy.

## Target lifecycle contract

Do not introduce a second lifecycle transport type. The existing lifecycle
status payload already carries the exact run id, terminal/active status,
`stale`, activity kind, wait reason, engine ownership, and admitted message
identity. LFO01 formalizes that existing payload as *execution evidence* at
the server/orchestrator boundary and adds a field only if a specific missing
decision cannot otherwise be represented.

```text
Existing lifecycle status payload
  runId and admitted message identity
  status: submitted | running | blocked | completed | failed | aborted
  stale: exact execution state could not be freshly confirmed
  activityKind and waitReason
  safe timing and engine-owner metadata
```

Rules for the evidence contract:

- A terminal status means the orchestrator has durably committed the exact
  execution transition. It says nothing about a server reservation or queue
  release.
- `busy` with terminal transcript remains an active status until explicit idle
  evidence confirms that the engine has released the session.
- `stale` or an unavailable lifecycle request is not terminal. The server's
  bounded recovery policy decides whether it later commands failure.
- The payload contains no prompt text, raw transcript, credentials, local
  absolute paths, or engine URL.

The existing registry remains the implementation behind this contract. New
callers must not combine raw OpenCode status and transcript data outside it;
only the server converts lifecycle evidence into an admission or release
decision.

## Serialization policy and state-transition matrix

Current behavior combines two different scopes. This plan must preserve that
distinction rather than accidentally replacing one with the other:

| Scope | Existing role to preserve | Owner | Policy to make explicit before implementation |
| --- | --- | --- | --- |
| Conversation | Durable queue plus run reservation | Server lifecycle coordinator | The target is at most one starting/active/terminalization-pending reservation per conversation. The current reservation key is workspace/run, so LFO02 must enforce this server invariant instead of assuming it. |
| Workspace | In-process execution gate around server-owned lifecycle work | Server lifecycle coordinator | Direct submit and queue drain both hold it through local registration and upstream dispatch. It coordinates shared engine-control handoff only; it is not durable state and does not replace the per-conversation reservation. |
| Exact run | OpenCode status, admitted message identity, transcript, and durable run transition | Orchestrator execution authority | Evidence always identifies the exact run; it cannot release a different conversation's reservation. |
| UI session | Scoped local draft queue, intent scheduling, and presentation | Desktop app | It may react to local idle state by making a server submit attempt, but never represents an accepted engine run, decides terminality, or makes a server release decision. |

LFO00 decision: the local server serializes the direct and queued
register-and-dispatch critical section through the in-process workspace gate.
That gate protects shared engine-control handoff only; it is not durable and
does not serialize the later runtime of distinct conversations after dispatch
has returned. The durable constraint is one active reservation per
conversation. Exact-run lifecycle `null` is authoritative absence only when
the lifecycle client received the exact endpoint's `404` with `run not found`;
timeout, a workspace-level `404`, stale, and other unavailable results are
errors/evidence and keep the item recoverable.

The server decision table is:

| Server reservation | Orchestrator evidence | Server transition | May start successor? |
| --- | --- | --- | --- |
| active | active | retain reservation; reconcile later | No |
| active | unavailable | retain reservation; use bounded recovery or terminalization-pending | No |
| active | terminal | delete the existing durable reservation, then request queue drain | Not until release is committed |
| starting | active | retain the reservation and reconcile; the run may already have been submitted | No |
| starting | unavailable | retain the outcome-unknown state and retry exact reconciliation | No |
| starting | terminal | mark the queued item accepted when present, delete the reservation, then request drain | Not until release is committed |
| terminalization-pending | any non-terminal evidence | retain pending terminalization/recovery state | No |
| terminalization-pending | terminal | delete the existing durable reservation, then request queue drain | Not until release is committed |
| no reservation with pending queue work | latest evidence is terminal or absent for the prior run | claim the oldest pending item through normal admission | Yes, subject to workspace gate and exact-run registration |

The server must fail closed if an impossible split state is observed, but it
does not need a new durable `released` state merely to describe a reservation
that is already deleted.

## Recorded decision gates

LFO00 recorded these decisions from live behavior and product intent before
LFO02 was implemented:

1. Whether different conversations in one workspace may execute concurrently
   after admission. The current direct and queued paths use the workspace gate
   differently, so current code cannot be treated as a deliberate answer.
2. Which exact lifecycle result proves authoritative absence for a recovered
   `starting` item. A request timeout, `stale` result, or unavailable engine
   is never absence and must not trigger replay.

The per-conversation server constraint and the reservation-before-registration
order are implementation requirements once these decisions are recorded; they
are not optional optimizations.

## Crash-safe handoff

There is no cross-store transaction between the orchestrator execution record
and the server queue/reservation record. The design therefore uses idempotent,
recoverable handoff steps rather than pretending the two writes are atomic.
The queue row and reservation already share one server database; extend that
existing store rather than adding a third lifecycle ledger.

```text
server transaction claims queue item (if queued) and persists starting reservation
  -> orchestrator registers the exact run
  -> server submits the stable run/message identity once to OpenCode
  -> queue row records submitted outcome
  -> orchestrator commits exact terminal execution state
  -> server reconcile deletes the durable reservation
  -> timer or startup scan drains the next pending item
```

The timer that wakes a drain is only a performance hint. The durable server
state must be sufficient to resume each incomplete step after restart. A
direct submit follows the same reservation-before-registration order, even
though it has no queue row.

| Crash window | Required restart/reconcile behavior |
| --- | --- |
| Execution terminal before server observed it | Startup or scheduled reconcile reads the exact active reservation, consumes terminal evidence, deletes the reservation, and lets the pending-queue scan wake a drain. |
| Reservation deleted but drain has not run | Startup pending-queue scan schedules/executes the drain. The deleted reservation is already the durable release decision; no `released` row is required. |
| Direct run registered in orchestrator but server reservation was not persisted | Prevent this window by persisting the starting reservation before registration. For legacy rows, active-run discovery must create/recover the reservation before any reload or successor admission. |
| Queue item claimed or starting but OpenCode outcome unknown | Do not reset it blindly to pending. Query its exact reserved run first: active or terminal evidence resolves it as accepted; unavailable evidence remains recoverable; only authoritative absence may return it to a safe retry path using the same stable ids. |
| Server observes an impossible active run without a matching reservation | Fail closed, emit a split-state diagnostic, and repair/recreate the reservation before queue release or workspace reload. |
| Terminalization write is pending | Resume only its bounded terminalization retry; neither repeat the original prompt nor release the queue. |

The minimal addition to the existing server store is an atomic admission claim
for a queue item and its reservation, plus recovery metadata for `starting`
items whose OpenCode outcome is unknown. It uses the existing workspace,
conversation, run, client-message, and OpenCode-message identities. It does
not require a new lease system, a release ledger, or a distributed
transaction.

## Implementation phases

### LFO00 — Freeze the contract and map all writers

State: implemented

1. Add the ownership table and invariants above to the canonical conversation
   workflow and OpenCode runtime documentation when the behavior is shipped.
2. Inventory every caller that can register, reconcile, terminalize, abort,
   release a reservation, claim a queue item, or schedule a queue drain.
3. Classify each caller as execution evidence, server command, UI local draft
   scheduling, UI projection, or legacy compatibility.
   Remove no behavior in this phase.
4. Record the supported workspace/conversation concurrency matrix, including
   the shared direct-submit and queue-drain workspace-gate boundary.
5. Record the direct and queued crash handoff order, including the
   reservation-before-registration order and `starting` queue-item recovery.
6. Add a review guard: a new lifecycle path must name its command owner and
   must not use a UI/SSE observation as terminal authority.

Acceptance evidence:

- Every durable lifecycle mutation and queue wake has an identified server or
  orchestrator owner.
- No undocumented alternate path can drain a conversation queue.
- The workspace gate and per-conversation reservation have separate documented
  purposes and neither is assumed to replace the other.
- The server-store constraint that enforces one active reservation per
  conversation has a deterministic concurrency test.

### LFO01 — Formalize exact-run execution evidence

State: implemented

Owner: orchestrator execution authority

1. Document the existing lifecycle status payload as the typed execution
   evidence contract at the orchestrator/server boundary. Do not add a second
   route or payload type without a proven missing field.
2. Make the existing status-and-message probe preserve that evidence for an
   exact admitted run. Keep current durable registry transitions behind the
   same owner.
3. Encode the busy-after-terminal-transcript rule in this boundary, together
   with exact message identity and pre-admission guards.
4. Preserve distinct retry, local-tool, unreachable, and missing-transcript
   results instead of reducing them to a boolean `active` flag.
5. Deprecate raw status/transcript interpretation by other lifecycle callers.

Acceptance evidence:

- A deterministic test proves that terminal transcript plus `busy` remains
  active; explicit idle produces terminal evidence but not an admission
  decision.
- Tests cover older terminal messages, missing exact messages, retry, local
  tool work, and unreachable engine results.

### LFO02 — Centralize server admission and crash-safe handoff

State: implemented

Owner: server conversation lifecycle coordinator

1. Extract one internal server admission operation used by direct submit and
   durable queue drain. It atomically creates the server-side starting
   reservation before orchestrator registration, consumes lifecycle evidence,
   and makes the only admission decision.
2. Enforce the target one-active-reservation-per-conversation rule in the
   server store, not only through an in-process workspace gate or the
   orchestrator's separate active-run index.
3. When evidence is active or stale/unavailable, retain the queue item and
   server reservation and schedule normal reconciliation; do not issue a new
   `prompt_async`.
4. Replace blind `starting` recovery with exact-run outcome recovery. A
   restart may requeue only after authoritative absence; it otherwise resumes
   reconciliation or records the already accepted item as submitted.
5. Route all terminal outcomes through the existing server order: consume
   exact terminal evidence, delete the durable reservation, then request a
   queue wake. Startup pending-queue scanning remains the recovery for a
   missed wake.
6. Keep timeout-abort recovery as a server command. It may request an
   orchestrator transition, but cannot independently release the queue.
7. Make guarded engine reload use the same coordinator-owned active-run view
   as submit and queue drain.

Acceptance evidence:

- Direct submit, queue drain, abort, provider-start timeout, engine loss, and
  restart recovery cannot bypass the server admission operation.
- A queued successor is never submitted while the server holds the active or
  terminalization-pending reservation, regardless of a UI observation.
- Each crash window in the handoff table resumes without duplicate OpenCode
  submit, unowned active run, or early release.

### LFO03 — Preserve the UI intent buffer after acceptance

State: implemented

Owner: desktop app

1. Keep draft ownership, local echo, explicit Retry, Stop, and the scoped
   local draft queue in the app. It schedules server submit attempts from UI
   state, but is not a durable execution queue and must not be removed by this
   plan.
2. After acceptance, consume the server lifecycle projection for queued,
   running, finalizing, terminal, and unavailable presentation.
3. Remove or fence any app-side path that clears a run or advances a local
   queue from SSE, transcript hydration, or poll exhaustion.
4. Ensure explicit retry after an uncertain abort presents the durable queued
   or settling state rather than issuing another immediate submit.

Acceptance evidence:

- App tests prove that a visible terminal answer alone cannot enable a second
  engine submission while server state remains active.
- Navigation, reconnect, and transcript catch-up cannot change durable
  lifecycle ownership.

### LFO04 — Minimal lifecycle diagnostics

State: implemented

1. Reuse existing lifecycle trace records and add only the narrow transitions
   needed to diagnose admission claim, `starting` outcome recovery,
   reservation creation/deletion, and split-state fail-closed handling.
2. Correlate queue events, lifecycle evidence, abort attempts, and terminal
   writes by the existing exact run id.
3. Retain existing redaction rules. Diagnostics must never contain prompt
   bodies, raw transcript, credentials, absolute paths, or engine URLs.

Acceptance evidence:

- A captured incident can identify whether it was admission-blocked,
  `starting`-outcome-unknown, terminalization-pending, or presentation-only
  without adding a dashboard or a new logging pipeline.

### LFO05 — Retire duplicate interpretation and promote the contract

State: implemented

1. Remove compatibility helpers only after all call sites use the shared
   evidence contract and central server admission operation.
2. Promote the shipped ownership contract into durable developer and feature
   documentation; retain this plan as implementation history.
3. Do not merge storage, add a second queue, add leases, or turn every
   lifecycle action into a generic state-machine framework unless measured
   evidence requires it.

## Verification strategy

The critical defect is a timing-sensitive engine boundary, so deterministic
owner-level tests are primary. They must use controlled status and transcript
evidence rather than depend on naturally reproducing an OpenCode release race.

| Layer | Required proof |
| --- | --- |
| Orchestrator | Exact run with terminal transcript plus `busy` stays active; explicit idle produces exact terminal evidence; retry and unavailable stay distinct. |
| Server | Direct submit and queued drain create a server reservation before registration; competing reservations for one conversation are rejected; only a committed release wakes a successor. |
| Restart/recovery | A direct registration-before-reservation crash and every queued `starting` outcome resolve without duplicate submit, unowned active run, or early release. |
| App | The local draft scheduler and server projection are presented faithfully; local idle may request a submit but cannot mutate durable ownership. |
| Desktop smoke | When a deterministic runtime fixture is available, two rapid user messages produce one active run and one queued successor, then both complete in order. |

No broad E2E matrix is required for the first extraction: an uncontrolled
timing test would be flaky and weaker than the deterministic exact-run tests.
A real desktop smoke remains a release confidence check when a controlled
fixture exists.

## Rollout and safety

1. Ship LFO01 and LFO02 behind unchanged external API shapes; formalize the
   existing lifecycle payload contract before adding any field or route.
2. Keep legacy diagnostic fields while adding reason codes, then remove old
   fields only after exports and incident tooling consume the new vocabulary.
3. Measure blocked-admission duration, terminalization-pending count, queue
   age, and duplicate-submit prevention. Treat a rise in blocked duration as
   an engine-release or reconciliation signal, not an excuse to bypass safety.
4. Roll back only the new admission interpretation if it proves incompatible;
   never roll back by releasing active reservations or replaying prompts.

## Explicit non-goals

- no cloud execution redesign;
- no unbounded automatic retry;
- no second durable queue or queue lease system;
- no UI-owned lifecycle mutation;
- no generic actor/workflow framework;
- no logging of user prompts or raw OpenCode payloads;
- no change to the current single-tenant local desktop execution model.
