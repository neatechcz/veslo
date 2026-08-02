---
title: P0/P1 Predictable Runtime Ownership Plan
status: in_progress
done: false
date: 2026-08-01
issue: unlinked
scope: server conversation lifecycle, workspace runtime evidence, native diagnostic delivery, and cross-boundary operation correlation
related:
  - docs/fixes/2026-08-01-fix-65-next-architecture-ownership-boundaries.md
  - docs/dev/conversation-workflow-contract.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/feedback-diagnostics.md
---

# P0/P1 Predictable Runtime Ownership Plan

## Decision

Strengthen the existing ownership model instead of introducing a new workflow
framework or a second lifecycle store.

- The local Veslo server remains the only durable command owner for accepted
  conversation admission and reservation release.
- The orchestrator remains the evidence owner for an exact run and the engine
  runtime it observed. It never authorizes a queue drain.
- The desktop app remains the owner of editable user intent and presentation.
  Its local queue is a pre-admission intent buffer, not an execution queue.
- The native desktop layer remains the command owner for a diagnostic
  attachment after it has been queued for delivery. Feedback UI is a
  projection, not an uploader.

The work has one P0 extraction and four P1 contracts. P1 may start only after
P0's ownership tests and runtime diagnostics make the existing decision path
observable.

## Implementation Progress

The first P1 safety slice and the P0.0 inventory are implemented. The existing
deterministic lifecycle tests remain the P0 behavioral baseline; no
reservation, queue, or lifecycle authority has moved yet.

- Engine-loss evidence received before owner persistence is now keyed,
  process-local, bounded by the configured OpenCode header wait plus five
  seconds, and discarded on expiry or controller stop. It cannot become a
  restart-replayed release signal.
- Internal engine tuples now have a separately tested safe runtime-evidence
  projection: a one-way generation fingerprint plus readiness, observed time,
  source, and reason code. It omits raw owner ids, PIDs, endpoint URLs, and
  local paths. The app-facing projection route remains deferred until there is
  a concrete consumer; this type does not create a second runtime owner.
- The existing app-owned SSE outage budget is now explicitly retained through
  replacement-stream setup. A fresh-runtime recovery budget clears only after
  the replacement stream proves liveness with `server.connected`; a second
  failure before that event enters degraded reconnect state rather than
  starting another runtime recovery.
- Feedback persistence accepts a client submission hint only as an idempotency
  key. Den assigns the canonical feedback ID after durable storage, rejects a
  changed canonical request under the same key, and exposes a scoped
  capture-link lookup. The feedback workflow retains that key, the canonical
  context/screenshot result, and a created capture id for an unchanged retry,
  rather than generating a conflicting or second feedback attempt after an
  outcome-unknown response.
- Native diagnostics retain the existing single unfinished attachment rule.
  After restart, one ready attachment is checked against that scoped lookup
  and is queued only when the same authenticated owner has a stored feedback
  record. A transient lookup failure uses bounded backoff; an explicitly
  unlinked attachment is retained without a polling loop. UI also uses the
  lookup to recover an outcome-unknown feedback POST before showing an error.

P0.1 is partially implemented: the controller's existing option ports remain
the effect boundary, while admission/reconciliation decisions now return small
pure classifications before the facade performs durable effects. The explicit
an initial correlation inventory is now implemented as a versioned,
allowlisted lifecycle diagnostic record over existing IDs; it remains
diagnostic metadata rather than another lifecycle state store. The fully
shared cross-boundary envelope remains P1 follow-up work.
P0.2 has its first pure policy extraction: exact engine-loss evidence is
classified as buffer, matching release, or stale/incomplete ignore before the
controller performs the durable effect. P0.3 now also classifies exact
lifecycle evidence and exhausted-poll outcomes before the facade reacts; a
stale terminal status remains unavailable evidence, never release authority.
P0.4 now has one small keyed scheduler for queue drain, reconciliation,
terminalization retry, provider-start recovery (through reconciliation),
starting-row recovery, and pre-attachment engine-loss expiry. It owns only
ephemeral timer coalescing/cancellation and safe callback error tracing; the
controller retains every durable mutation and lifecycle decision. Each fired
wake records only its namespace, key, planned delay, safe reason, and attempt;
existing trace paths retain the later result. Existing
restart reconstruction remains driven exclusively by the queue/reservation
store, satisfying the P0.5 boundary without a second registry.

## Why now

The current server lifecycle coordinator correctly centralizes durable
admission, but it also contains several independently scheduled policy paths:
queue drain, exact-run reconciliation, terminalization retry, provider-start
abort recovery, restart recovery, and engine-loss handling. The behavior is
safe only if every path preserves the same reservation and release rules.

Separately, a process/runtime fact, an accepted-run fact, a diagnostic-delivery
fact, and a UI status can look similar during an incident. They are not the
same authority. The plan makes their contracts explicit so a delayed poll,
stale process callback, or UI state can never make an irreversible decision.

## Outcomes

1. A reviewer can identify the sole command owner, evidence owner, durable
   record, idempotency key, and restart behavior of every lifecycle action.
2. Lifecycle policy becomes small, independently testable modules behind the
   same server controller API and SQLite records.
3. Engine generation/readiness facts have a narrow, typed contract that is not
   confused with run terminality.
4. Diagnostic attachment delivery has one native-owned state machine with a
   safe UI projection and no duplicate upload loop.
5. Run, recovery, feedback, and diagnostic events can be joined by safe causal
   identifiers without recording prompts, credentials, raw payloads, engine
   URLs, or local absolute paths.

## Explicit non-goals

- no orchestrator-owned queue admission or reservation release;
- no removal of the app-local draft queue;
- no distributed transaction, lease service, second durable queue, or release
  ledger;
- no generic actor/job/workflow framework;
- no automatic re-send of a user prompt after an outcome-unknown crash;
- no cloud execution redesign;
- no gradual background upload of the user's retrospective diagnostics before
  feedback attachment has been requested.

## Current baseline to retain

| Concern | Existing durable authority | Rule preserved by this plan |
| --- | --- | --- |
| Accepted conversation run | Server queue/reservation store | One active reservation per conversation; reserve before run registration. |
| Exact execution state | Orchestrator lifecycle registry | Exact run and message evidence only; stale/unavailable is not terminal. |
| Shared engine-control handoff | Server workspace gate | Serializes register-and-dispatch only; does not replace durable reservation. |
| Engine ownership | Runtime owner tuple on reservation | A stale/later generation cannot release an earlier reservation. |
| Transcript recovery | Server transcript-ingest coordinator | Bounded delivery/catch-up is not admission authority. |
| Diagnostic attachment | Native durable capture/delivery queue | Bound retention and upload state; UI waits for confirmed terminal status. |

## Ownership vocabulary

Every boundary introduced by this plan must declare one of these roles:

| Role | Can do | Cannot do |
| --- | --- | --- |
| Command owner | Persist an idempotent business decision | Infer the decision from a UI/projection signal |
| Evidence owner | Report a fact for an exact identity | Change admission/release policy |
| Projection owner | Render or export safe derived state | Mutate durable business state |
| Scheduler | Coalesce and wake a bounded attempt | Decide the semantic result of the attempt |

Each command must state: input identity, idempotency key, durable mutation,
allowed state transition, safe diagnostics, retry owner, cancellation rule, and
recovery after restart.

## Target ownership matrix

| Boundary | Type | State it owns | Commands it accepts | Explicitly forbidden |
| --- | --- | --- | --- | --- |
| Server lifecycle facade | Command facade | Public lifecycle API and composition only | submit, abort, reload-if-idle, engine-loss notification | Directly duplicating policy/timer logic |
| Admission policy | Command policy | Reservation claim/release ordering | direct and queued admission; committed release | Terminal inference from SSE/transcript/UI |
| Exact-run reconciliation policy | Evidence consumer | Reconcile attempt state and safe result classification | schedule/read exact lifecycle evidence | Queue drain or prompt replay |
| Terminalization policy | Command policy | terminalization-pending metadata | persist/retry terminal write | Re-submit original OpenCode request |
| Queue-drain policy | Scheduler plus command policy | keyed wake/in-flight guard | drain next committed pending item | Start while a reservation is active/pending terminalization |
| Runtime evidence contracts | Evidence owner | trusted owner tuple and separate safe projection | readiness query, process loss report | Mark a run terminal or release a reservation |
| Native diagnostic-delivery coordinator | Command owner | snapshot bounds, durable delivery state, retry | attach feedback capture, retry/abandon where allowed | Claim upload from a UI-only observation |
| Feedback UI state | Projection owner | modal/presentation state | request capture/attachment; read status | Run independent upload retry or mark attachment delivered |
| Correlation contract | Shared contract | links among existing durable IDs | propagate allowlisted IDs | Become a lifecycle or retry owner |

## P0 — Lifecycle policy extraction

### P0.0 Freeze the state and timer contract

Before moving code, write a complete inventory of each lifecycle mutation and
timer key. The inventory is a required review artifact and test input, not a
new runtime registry.

Classify every path that can:

- claim or release a reservation;
- mark a queue item starting, pending, submitted, or failed;
- register or unregister active gateway work;
- schedule/reconcile an exact run;
- persist or retry terminalization;
- start provider-timeout abort recovery;
- wake a queue drain;
- react to engine-loss and startup recovery.

For every path, record its exact key, durable record, owner, trigger, possible
outcome, and whether it may wake another run. No code move starts until two
independent reviewers can trace all release paths to the same admission policy.

### P0.0 inventory (2026-08-01 baseline)

This is the source-level inventory frozen before policy extraction. The local
timer handles and in-flight sets are only coalescing state; the queue and
reservation store remains the restart source of truth.

| Path | Exact key / guard | Durable record changed | Trigger and outcome | May wake successor? |
| --- | --- | --- | --- | --- |
| Direct admission | workspace execution gate; `workspaceId + runId` reservation | reserve starting, later activate | accepted submit reserves before lifecycle registration and OpenCode dispatch | only after terminal/release path |
| Queued admission | queue drain key `workspaceId + conversationId`; in-flight drain set | atomic queued item claim plus starting reservation; then submitted/failed/pending | queued item becomes the exact lifecycle run or is safely re-pended | no, it schedules the next drain only after its own outcome |
| Committed release | exact `workspaceId + runId` reservation | deletes reservation | authoritative terminal lifecycle write, trusted matching engine loss, or startup exact terminal recovery | yes, schedules conversation queue drain after release |
| Exact-run reconciliation | `workspaceId + conversationId + runId`; in-flight reconcile set | may mark lifecycle state; may create terminalization-pending row | lifecycle status/read failure/stale run/provider-abort recovery | only after a committed terminal/release outcome |
| Terminalization retry | `workspaceId + conversationId + runId` | terminalization reason, attempts, next attempt, deadline | terminal lifecycle write failed; retry writes terminal state only | yes, only after successful write and release |
| Provider-start abort recovery | same exact reconcile key plus provider-abort recovery map | provider-abort-pending reservation metadata | provider start timeout or retry after abort failure | no direct wake; later reconcile decides |
| Starting-row recovery | `workspaceId + queueItemId` | restores reservation or returns starting row to pending/submitted | controller restart observes an interrupted queue claim | yes, only after exact absent/terminal decision |
| Engine-loss pre-attachment buffer | `workspaceId + runId` | none; process-local only | loss arrives before owner persistence; expires after header wait plus margin | yes, only if later owner tuple matches before expiry and release commits |
| Diagnostics interval | one controller timer | none | optional periodic diagnostics emission | never |

The remaining extraction must keep this table aligned with tests. In
particular, the workspace gate serializes dispatch composition but is not a
reservation, scheduler key, or source of restart recovery.

### P0.1 Introduce internal ports and policy results

Keep the existing public lifecycle-controller methods and route payloads.
Introduce internal ports for:

- reservation store operations;
- exact lifecycle evidence reads;
- OpenCode dispatch/abort operations;
- transcript ingestion;
- clock/timer scheduling;
- safe tracing.

Define small serializable policy result types rather than allowing policies to
call each other through the controller closure. A result can request one of:

- retain reservation and schedule exact reconciliation;
- persist terminalization pending and schedule terminalization retry;
- commit release and request a keyed queue wake;
- mark queue work submitted/failed/pending only when its exact recovery rule
  allows it;
- emit a safe reason code.

Only the lifecycle facade executes effects in a fixed order. Policies do not
receive UI/SSE state or raw transcript payloads.

### P0.2 Extract admission and release policy first

Move direct admission, queued claim, reservation activation, engine-owner
attachment, committed release, and stale engine-loss filtering into one
admission policy module.

Required rules:

1. A reservation is durable before orchestrator registration or OpenCode
   dispatch.
2. A queued item claim and its reservation remain one SQLite transaction.
3. Release is idempotent and only follows a durable exact terminal decision or
   a matching, trusted engine-loss decision.
4. Release performs no dispatch itself; it merely returns a queue-wake request
   after the delete is committed.
5. An engine-loss callback must match the persisted owner generation tuple.
6. A missing or stale owner tuple fails closed and is reconciled, not released.

### P0.3 Extract reconciliation and terminalization policies

Split exact-run observation from the reaction to it.

The reconciliation policy converts the typed lifecycle response into one safe
classification: active, terminal, authoritative absence, unavailable, or
terminal-transcript-still-busy. It must preserve the current rule that a
terminal transcript with a busy exact session is not release authority.

The terminalization policy owns the persisted pending record, attempt counter,
next-attempt time, deadline, reason code, and safe error summary. It may retry
only the terminal lifecycle write. It must not repeat a prompt, abandon a
reservation because a timer fired, or convert `model_retry_no_output` into an
automatic terminal state.

### P0.4 Extract keyed scheduler adapters

Create a small internal scheduler adapter for queue drain, reconciliation,
terminalization retry, provider-start abort recovery, and startup recovery.
It is deliberately not a generic job engine.

Required scheduler properties:

- at most one in-flight attempt per exact key;
- a later request coalesces or brings the next permitted attempt forward, never
  stacks timers;
- cancellation is tied to a committed terminal/release decision or controller
  stop;
- timer handles are ephemeral, while restart reconstruction comes only from
  SQLite reservations/queue rows;
- each wake emits a reason code, key, planned delay, attempt, and result;
- callback failure cannot leak an in-flight marker or silently release work.

Use distinct key namespaces for conversation queue drain, exact run
reconciliation, terminalization, provider-start recovery, and workspace
startup scan. A shared workspace gate remains an execution-critical-section
tool, not a scheduler key.

### P0.5 Preserve recovery semantics through restart

At controller start, rebuild scheduled work exclusively from durable state:

| Persisted condition | Required action after restart | Never do |
| --- | --- | --- |
| Active reservation | Reconcile exact run | Admit successor first |
| Starting queue item | Treat as outcome-unknown; read exact run | Re-submit blindly |
| Terminalization pending | Retry only terminal write | Repeat original prompt |
| Reservation removed with pending queue item | Schedule keyed drain | Recreate previous run |
| Unmatched/stale engine-loss callback | Keep/reconcile reservation | Release by callback arrival alone |
| Model retry without output | One low-churn exact observation | Convert timeout into failure/release |

### P0 acceptance tests

Add deterministic contract tests before and during extraction. Test the public
controller behavior plus policy-level state tables; do not make an uncontrolled
real-engine race the primary proof.

Required cases:

1. Two rapid messages in one conversation produce one accepted reservation and
   one queued intent; the second starts exactly once after committed release.
2. A third message matching an already pending fingerprint is not admitted as a
   duplicate, including A → B → A while A is still handing off.
3. Terminal transcript plus busy exact runtime retains the reservation and does
   not wake a successor; exact idle/terminal evidence later releases it.
4. Lifecycle timeout, stale response, malformed response, wrong run id, and
   workspace-level absence all retain recoverability.
5. A trusted exact `run not found` is the only absence result allowed to reset
   an outcome-unknown starting row to a safe retry path.
6. Terminal lifecycle write failure persists pending terminalization, survives
   restart, retries the write, and never re-dispatches OpenCode.
7. A late engine-loss callback for a different generation cannot release a
   newer reservation.
8. Every scheduler callback is single-flight and clears its in-flight marker
   after success, failure, cancellation, and thrown exception.

## P1 — Runtime evidence contracts

### P1.0 Define the contracts before extracting any new owner

Do not create a new daemon, a new runtime supervisor process, or move process
ownership. Define two typed, versioned values at the existing desktop, server,
and orchestrator boundary:

```text
Trusted engine-owner tuple (internal only)
  workspace identity, engine slot/owner id, process identity, started-at,
  internal endpoint fingerprint, directory epoch, and configuration revisions

Runtime evidence projection (safe to expose in diagnostics/UI)
  workspace identity, generation fingerprint, readiness,
  observed-at, evidence source, and safe reason code
```

The trusted tuple remains available only on the local trusted boundary because
it is required to fence callbacks against the exact reservation. The safe
projection omits endpoint URLs, bearer tokens, local absolute paths, prompt
content, and raw provider errors. A later generation never modifies the
meaning of an earlier generation.

### P1.1 Establish the runtime-evidence boundary

Retain the desktop shell as owner of the local Veslo server process and retain
the orchestrator as owner of engine process selection/liveness. Introduce a
runtime-evidence boundary that composes their safe facts:

- desktop supplies local-server process generation/lifecycle facts;
- orchestrator supplies exact workspace-engine readiness and owner tuple;
- server binds a matching engine tuple to an existing reservation;
- app reads a safe projection only.

This boundary may report readiness, loss, replacement, and incompatibility. It
must never terminalize a run, release a reservation, dispatch a queued run, or
retry a user message. Those actions remain server lifecycle decisions that may
consume runtime evidence only when their existing policy permits it.

### P1.2 Generation and callback rules

1. Every readiness and loss callback carries workspace and full engine
   generation identity.
2. The server attaches generation only to an already durable reservation.
3. A callback received before attachment is retained only in a process-local,
   keyed pre-attachment buffer. Its lifetime is bounded by the configured
   upstream-header wait plus a documented small safety margin; it is never
   persisted.
4. On expiry, controller stop, or desktop/server restart, the pre-attachment
   buffer is discarded with a safe reason code. The durable reservation then
   resumes through exact-run lifecycle reconciliation; no callback is replayed
   across a restart.
5. A stale callback, different workspace, missing generation, or incompatible
   server generation is ignored with a safe diagnostic reason.
6. Process reachability never means run terminality. Exact-run lifecycle
   evidence remains mandatory for normal release.
7. Engine loss may feed the existing narrowly trusted terminal/release policy
   only when the persisted owner tuple matches exactly.

### P1.2a Runtime-evidence acceptance tests

- Concurrent readiness reads for one workspace join one native/orchestrator
  operation and later reads observe a new generation.
- Restarting the local server cannot reuse a lifecycle endpoint/token from an
  incompatible daemon generation.
- A lost old engine process cannot release a run bound to the replacement.
- A readiness failure surfaces as runtime unavailable while the exact run stays
  recoverable unless existing trustworthy terminal evidence says otherwise.
- A pre-attachment callback expires, process restarts, and durable exact-run
  reconciliation converges without replaying or retaining that callback.
- Desktop recovery scenario proves an owned child exits, replacement uses a new
  generation, and a subsequent run follows the same server-owned admission
  boundary.

### P1.3 Preserve the app-owned SSE outage budget

The app session event-stream remains the owner of an SSE outage episode and of
the already existing "at most one fresh runtime recovery per workspace outage"
budget. Runtime evidence must be consumed by that owner; the new server/runtime
contracts must not create a second fresh-runtime recovery path.

Rules:

1. The episode key is scoped to the workspace stream connection/generation, not
   the selected UI session.
2. Reconnects and stream replacement join the same episode while it is open.
3. One recovery may request a fresh runtime. A second recovery request for the
   same episode moves the UI to stable degraded state while ordinary reconnect
   backoff continues in the background.
4. A new proven live stream clears the episode. Navigation alone does not.
5. Send-time readiness recovery is a distinct, bounded operation and must not
   reset or consume an SSE outage budget without an explicit contract test.

Add a focused app test that repeats a recoverable SSE failure through stream
replacement and asserts one fresh runtime request, followed by degraded rather
than another recovery. This closes REC06 without moving its owner into P0.

## P1 — Native diagnostic-delivery coordinator

### P1.4 Formalize the existing single-attachment state machine

The current bounded spool and feedback capture APIs become an explicit native
state machine. Product policy for this phase is **one unfinished feedback
attachment per desktop profile**. A second feedback flow cannot create or reuse
another feedback's attachment; it must wait for the existing attachment to
settle or submit explicitly without diagnostics. It must not silently replace a
capture that could already be linked to stored feedback. Multiple concurrent
attachments require a later journal-map, retention, UI, and recovery design.

Keep the current persisted states and expose a small UI mapping rather than
renaming storage states prematurely:

```text
snapshotting -> ready | ready_with_truncation -> queued
queued -> uploaded | uploaded_with_truncation | undeliverable
ready | ready_with_truncation -> discarded (only after proven unlinked)
```

The durable desktop record contains capture id, identity binding, timestamps,
event/byte counts, truncation/drop counts, current attempt, next retry time,
safe failure class, and upload idempotency key. It contains no plaintext
feedback text. The canonical cloud feedback row links itself to the capture id;
the desktop journal does not need to mirror a feedback id merely for lookup.

The existing 50 MiB spool ceiling remains a retention limit, not a memory
budget. Snapshot assembly and transport must stream/read bounded batches so a
large capture does not freeze the desktop UI or require one large allocation.

### P1.5 Make UI a status projection

The feedback workflow can request a capture and queue it after feedback has a
durable id. It may render progress and prevent premature close, but it must not
run an independent delivery retry or infer upload success from a request start.

Keep the existing bounded native status read/poll as the KISS transport. It
must consume only native state and discard a late read whose capture id does
not match the tracked attachment. A push subscription is deferred until polling
is measured to cause a concrete UI or battery problem. The modal can close only
after a confirmed uploaded terminal state or a user-visible terminal
failure/discard decision.

### P1.5a Close feedback-store-to-queue crash recovery

There is a required recovery contract for this sequence:

```text
native snapshot is ready
  -> Den durably stores feedback row with diagnosticCaptureId
  -> desktop queues the same capture for upload
```

The middle-to-last crash window cannot be solved by assuming an in-memory UI
callback will run. Add an authenticated, org-scoped cloud lookup for one exact
capture id that returns only `linked` plus the safe feedback id when a durable
feedback row owned by the same user/org exists. It must not expose feedback by
arbitrary capture id or return feedback text.

At startup and before replacing an unfinished feedback snapshot, native
recovery does the following after a matching signed-in context is available:

| Local state | Cloud lookup | Required action |
| --- | --- | --- |
| ready / ready_with_truncation | linked | Persist/queue the existing capture id idempotently and upload it. |
| ready / ready_with_truncation | unlinked | Keep it local until explicit discard, replacement, or retention expiry. |
| queued | either result | Resume native batch delivery from the existing journal. |
| identity mismatch | unknown | Mark undeliverable; never upload under a different account. |
| lookup unavailable | unknown | Retain without upload; retry lookup with bounded backoff. |

The feedback submit request must remain idempotent for its stable client
submission key so a response-loss retry cannot create two rows for one capture.
The cloud feedback service is the authoritative owner for this key at the
durable row write; desktop values are correlation/idempotency hints only. The
same key with a different canonical request hash returns a conflict rather than
silently altering or duplicating the stored feedback.

### P1.6 Delivery/recovery rules

| Condition | Native coordinator action | UI behavior |
| --- | --- | --- |
| Feedback accepted, attachment queued | Persist linkage and schedule upload | Show preparing/uploading |
| Temporary network/server failure | Persist next retry and bounded backoff | Keep progress state; do not claim completion |
| Desktop restart | Reload pending attachment and resume from durable state | Reattach to current status on next feedback view |
| Oversize/retention truncation | Preserve safe count and upload bounded snapshot | Show that diagnostics are partial |
| Invalid/permanent rejection | Persist terminal failure class | Let user see failure and choose a new feedback attempt |
| Status read/event failure | Keep last nonterminal native state and retry observation | Never convert to uploaded |

### P1.7 Diagnostic-delivery acceptance tests

- A feedback submission produces one attachment id; repeated UI actions replay
  that idempotently rather than create duplicate uploads.
- A crash after feedback persistence but before native queueing is recovered by
  the authenticated capture-id lookup, then queues exactly the original
  capture.
- A lost feedback response retried with the same client submission key returns
  the original durable feedback row; a changed payload under that key conflicts.
- A second unfinished attachment cannot overwrite a ready capture whose cloud
  linkage is unknown.
- A 50 MiB retained spool is batched within configured byte/event maxima and
  does not require constructing one body in memory.
- Temporary upload/status failures retain the attachment and survive restart.
- The modal remains visibly uploading until native confirmed terminal status.
- A late status read for another capture cannot overwrite the tracked state.
- Redaction, size bounds, and diagnostic retention are verified before every
  transport attempt.

## P1 — Cross-boundary correlation contract

### P1.8 Map and normalize existing durable identities

Do not introduce a globally new client-generated operation identifier. First
define a versioned, allowlisted correlation record from existing identities:

```text
authoritative operation id: admitted run id or durable feedback id
causation: queue item/client-message/capture relation to that operation
client attempt id: untrusted correlation and idempotency hint only
trace id and request id: transport/diagnostic dimensions, not authority
attempt, origin, workspace/conversation/run/capture identity where applicable
engine generation, phase, reason code, and outcome
```

Rules:

- A conversation operation becomes authoritative only when the server durably
  accepts its exact run/reservation. Before that, client attempt and message
  identifiers are hints, not lifecycle authority.
- Queued execution retains causation to that intent and gains its exact run id
  only at admission.
- Feedback becomes authoritative when Den durably writes its feedback row.
  Capture id remains a desktop-generated attachment identity that Den validates
  and binds to authenticated user/org context.
- Retry increments attempt but retains the same authoritative operation and
  causation relation after it exists.
- All transport headers/fields are allowlisted and redacted. The envelope is
  correlation metadata, never a carrier for prompt/body text.
- A missing envelope is tolerated during migration, but a malformed envelope is
  discarded and recorded as a safe diagnostic instead of being guessed.

### P1.9 Correlation rollout

1. Inventory current trace, request, batch, run, queue, feedback, and capture
   identifiers and publish the mapping table.
2. Add shared types and test fixtures without changing external public APIs.
3. Emit the correlation record in server lifecycle diagnostics and native
   attachment delivery first.
4. Propagate only server-confirmed identities through orchestrator evidence and
   desktop projection using an allowlist of safe fields.
5. Update support export tooling to group by authoritative operation and
   causation relation while
   retaining legacy grouping during the transition.
6. Remove legacy heuristic grouping only after a release confirms coverage in
   real feedback exports.

Implementation status: step 1 has an initial inventory, and steps 3 and 5 have
their first rollout. The server emits a version-1 record at durable run
admission (before upstream submit); queued work records its queue/client-message
causation without promoting the reserved run. Native capture summaries record
attachment causation without inventing a feedback operation before Den's
durable write. The feedback export groups its durable feedback row and admitted
run records while retaining the existing bounded `runId` heuristic for legacy
captures, and counts malformed records without preserving them. Shared types
across Den/native/app and propagation through orchestrator and desktop
projection (steps 2 and 4) remain pending. Step 6 remains deferred until
production feedback exports prove the new coverage.

## Sequencing and rollback

1. P0.0–P0.1: inventory, contract tests, ports, and no behavior change.
2. P0.2: admission/release extraction, then deterministic recovery tests.
3. P0.3–P0.5: reconciliation, terminalization, and scheduler extraction with
   restart matrix proof.
4. P1.0–P1.3: runtime-evidence and app outage-budget contract tests.
5. P1.4–P1.7: single-attachment delivery, cloud-link recovery, and UI
   projection.
6. P1.8–P1.9: correlation mapping and support-export adoption.

Each extraction lands behind the same external behavior and existing durable
schema where possible. Roll back an extraction by restoring the former module
behind the lifecycle facade, never by deleting reservations, replaying prompts,
or weakening exact generation checks. Schema additions require backward reading
and restart migration tests before any writer relies on them.

## Required documentation updates

When each phase ships, update the canonical conversation workflow, runtime
architecture, diagnostics runbook, configuration reference, and testing
playbook. Keep this plan as implementation history; do not let it become the
only authoritative contract.

## Verification lanes

Every implementation slice must run the focused changed-surface tests first,
then the appropriate service/runtime gate:

1. server controller, queue-store, and lifecycle-client tests for P0;
2. orchestrator generation/liveness tests for P1 runtime evidence;
3. native Rust tests and app feedback workflow tests for diagnostics;
4. server binary rebuild after server-source changes;
5. `pnpm check` for normal source handoff;
6. a focused Tauri Pilot scenario for user-visible desktop behavior, using an
   isolated profile and deterministic fixture/fault control where needed.

Do not use WebDriverIO or a UI-only web server as proof. If a desktop test is
blocked by an existing Veslo process, follow the project preflight/retry policy
rather than attaching implicitly to a user runtime.

## Completion criteria

The plan is complete only when every listed owner has an executable contract
test and a documented restart rule. In a production incident, a support
engineer must be able to reconstruct one operation from safe identifiers and
answer: which owner made the durable decision, what exact evidence authorized
it, why any retry was scheduled, whether a restart changes the next action, and
whether the UI is showing a fact or a projection.
