# Fix 65: Next Architecture Ownership Boundaries

Date: 2026-08-01

## Status

Architecture checkpoint. This document records the next ownership boundaries to
introduce deliberately; it does not claim that they have been extracted into
new runtime components yet.

## Baseline to preserve

The server-side conversation lifecycle coordinator remains the sole durable
admission and reservation-release owner after a submission is accepted. The
orchestrator supplies exact execution evidence, and the desktop app keeps a
local pre-admission buffer of user intent plus presentation. No follow-up may
create a parallel lifecycle truth, make the UI release a reservation, or make
the orchestrator authorize a queued successor.

## Decision vocabulary

Each new boundary must be classified before implementation:

| Boundary type | Responsibility | May not do |
| --- | --- | --- |
| Command owner | Makes an idempotent, durable decision | Infer state from a projection |
| Evidence owner | Reports facts for an exact identity | Change queue/admission policy |
| Projection owner | Produces a UI or support-facing view | Mutate durable lifecycle state |
| Scheduler | Wakes a bounded retry/reconciliation attempt | Decide the business outcome |

Every command owner must document its durable record, idempotency key,
recovery after restart, emitted safe diagnostics, and the decisions it is
explicitly forbidden to make.

## Recommended next boundaries

### 1. Lifecycle policy modules behind the server coordinator

Priority: P0

Keep one public server coordinator, but separate its internal policy families:

- admission and reservation claim/release;
- exact-run reconciliation;
- terminalization and its retry;
- provider-start timeout and recovery;
- queue wake/drain scheduling.

This is an extraction of decision rules, not new sources of truth. The server
store remains authoritative for admission and release. It makes the current
many timer and recovery paths reviewable without giving the orchestrator or UI
new lifecycle powers.

### 2. Workspace runtime supervisor contract

Priority: P1

Define a narrow owner for process generation, engine readiness, restart, and
connectivity facts across desktop shell, local server, and orchestrator. Its
output is immutable runtime evidence such as an engine generation and readiness
state. It must not terminalize a run, release a reservation, or decide that a
successor can start.

This separates "the runtime is reachable" from "this exact accepted run is
terminal", which are currently easy to conflate during failure recovery.

### 3. Native diagnostic-delivery coordinator

Priority: P1

The durable native queue should be the only owner of a diagnostic snapshot's
retention, byte/event bounds, batching, upload retries, and terminal delivery
state. Feedback UI is a projection: it starts a capture/attachment and renders
the confirmed status, but does not own a second upload timer or claim success.

The coordinator should expose one safe status contract and optionally publish
status changes to the UI. It also owns redaction, retention, and attachment
linkage after feedback is stored.

### 4. Cross-boundary operation envelope

Priority: P1

This is a shared contract, not a new service. Standardize a safe operation
envelope for submit, recovery, feedback attachment, and external upload:

- operation id and causation id;
- attempt number and stable idempotency key;
- workspace, conversation, run, and engine-generation identity where present;
- origin and redacted reason code;
- terminal outcome classification.

It gives diagnostics a single causal chain without logging prompts, raw
payloads, credentials, or local absolute paths. Support exports can then join
events deterministically instead of reconstructing a run from heuristics.

### 5. Run-delivery projection boundary

Priority: P2

Keep bounded transcript ingestion and exact-run lifecycle evidence separate,
but publish one server-owned read model for delivery: queued, accepted,
running, finalizing, terminal, or unavailable. The app can combine this with
local editor intent, yet must not derive completion from SSE quietness,
transcript presence, or a polling timeout.

This makes a terminal transcript while the engine is still busy visibly
understandable without permitting early successor admission.

### 6. Retry scheduling discipline

Priority: P2

Introduce a small keyed scheduling utility or local convention, not a generic
workflow engine. It should provide one in-flight attempt per key, bounded
backoff, cancellation, restart reconciliation from durable state, and a
diagnostic reason for every scheduled wake. Lifecycle, diagnostics, and
transcript code retain their own business decisions; the scheduler only runs
them predictably.

## Explicit non-goals

- Do not move conversation admission into the orchestrator.
- Do not remove the app-local draft queue; it is a pre-admission user-intent
  buffer, not a competing lifecycle owner.
- Do not centralize all retries in a generic actor or job framework.
- Do not add a distributed transaction, a second durable queue, or a separate
  release ledger where idempotent recovery from the existing durable records is
  sufficient.

## Safe implementation sequence

1. Add an ownership matrix and contract tests for existing mutations, evidence,
   projections, and timer keys.
2. Extract lifecycle policy modules behind the existing server coordinator with
   no external API or persistence change.
3. Adopt the operation envelope at diagnostics boundaries first, then extend it
   to submit/recovery paths.
4. Make native diagnostic-delivery status a single UI-consumable projection.
5. Add the runtime-supervisor contract only after its inputs and forbidden
   lifecycle decisions are explicitly tested.

## Success criteria

For any incident, a reviewer can answer without guesswork: who made the durable
decision, which exact evidence authorized it, what will happen after restart,
and which UI state is merely a projection. A missing observation or delayed
timer must never by itself admit another run, discard user intent, or declare a
diagnostic attachment delivered.
