---
title: Terminal Runtime Owner Loss Root-Cause and Recovery Plan
status: in_progress
done: false
date: 2026-08-02
issue: unlinked
scope: safely unblock a durable successor only after the prior engine generation is durably proven gone; retain bounded, causal diagnostics when proof is unavailable
related:
  - docs/plans/2026-08-01-conversation-run-lifecycle-ownership-plan.md
  - docs/plans/2026-08-02-server-owned-runtime-operations-plan.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/conversation-workflow-contract.md
---

# Terminal Runtime Owner Loss Root-Cause and Recovery Plan

## Decision

This is a narrow lifecycle repair. It does not rewrite the queue, restart an
engine to clear a queue, or move lifecycle authority into the UI.

The defect is the missing durable bridge between a persisted run/reservation
and an engine pool that is deliberately only in memory. A new orchestrator
process not having an old engine in its pool is evidence of lost local
knowledge; it is **not** evidence that the old OS child process is dead.

Add a small orchestrator-owned `EngineGenerationAuthority`. It owns durable
identity and liveness evidence for one engine generation across orchestrator
restart. It is the only component allowed to answer whether the exact recorded
generation is `lost_proven`, `live_or_ambiguous`, or `unknown`. The authority
does not start, stop, or schedule engines; those remain responsibilities of
the existing pool.

The server remains the sole owner of durable queue admission, reservation
release, and successor dispatch. It may request a decision from the
orchestrator, but it must persist the decision process on the reservation and
must never infer owner loss from UI state, a terminal transcript, a timeout, a
PID, or pool absence.

`lost` means only: the exact engine generation recorded on the run is proven
unable to own the session any longer. It does not imply a replacement engine is
healthy, a queued prompt was delivered, or the user-visible transcript
succeeded.

## Codebase findings and corrected terminology

The inspected incident has a terminal `failed` run with an attached exact
engine owner. New orchestrator processes reported it as stale with successor
readiness unknown; server reconciliation correctly retained its reservation and
repeated the conservative reconcile path.

The previous wording "the old owner could not possibly still execute" was too
strong. The trace proves that a new in-memory pool did not know this engine. It
does not prove that a child surviving an unclean orchestrator termination was
dead. Existing clean shutdown attempts to stop pool children, but an unclean
crash bypasses that path.

The current recovery route is only a partial mitigation. It checks that a
terminal record is stale, has an attached exact tuple, has no active peer, and
has no current owner in the pool. It does not receive a structured probe reason
or durable owner-death proof. The server's one-request guard and reconcile
attempt counter are both process-local. Therefore neither can protect the
restart case by itself.

The existing service-chain integration kills a real OpenCode child and verifies
the normal in-process engine-loss callback. It does not restart the
orchestrator over preserved lifecycle and queue databases. That is a different
failure mode and needs its own test.

## Ownership contract

| Owner | Owns | Must not own |
| --- | --- | --- |
| Engine pool | Spawn, health, suspend, stop, child exit events, and current in-memory process handles. | Durable proof about a generation it no longer has in memory; reservation release. |
| `EngineGenerationAuthority` | Durable generation record, exact child identity, heartbeat/closure evidence, and the three-way owner-evidence decision. | Queue dispatch, run terminalization policy, UI presentation, or automatic replacement. |
| Run registry | Durable run state and the exact `attached -> lost` update after a `lost_proven` decision. | Deciding process death from its own record or a probe timeout. |
| Server lifecycle controller and queue store | Admission, durable reservation state, bounded handoff workflow, release, and FIFO wake-up. | Direct engine control or guessing generation liveness. |
| Runtime-operation owner | UI-originated control-plane and guarded reload operations. | Engine-generation death proof; it must consume, not duplicate, this authority. |
| UI | Intent and projection of queued, recovering, blocked, or degraded state. | Lifecycle mutation, retry budget, engine restart, or reservation release. |

This is not a second lifecycle owner. The authority fills one deliberately
missing fact: whether a named generation still exists after its original pool
vanished. The server-owned runtime-operation lease is not suitable for this
fact: it is workspace-scoped and expiring, while a handoff must identify one
specific run and engine generation.

## Evidence model and state machine

The authority stores one row per engine generation in the existing
orchestrator lifecycle SQLite database, not a new database. A row contains:

- random `generationId`/engine owner id and workspace slot;
- orchestrator instance id and its start time, for diagnosis and fencing;
- child PID plus an OS process birth identity captured at spawn (not only the
  PID);
- engine base URL only as a redacted/internal matching field, never in user or
  cloud diagnostics;
- `createdAt`, `lastHeartbeatAt`, `closedAt`, and a finite closure reason.

The durable state model is:

```text
creating -> live -> stopping -> exited_confirmed
    |        |            \
    +--------+-------------> unknown_after_orchestrator_loss
```

`creating` is written before a run can attach to the engine. `live` is written
after spawn; where the host supports it, the same activation captures the
exact process identity. A missing identity does not block ordinary execution,
but it disables automatic owner-loss recovery for that generation. A clean
stop writes `stopping`, waits for exact child exit, then writes
`exited_confirmed`. A failed stop or unclean orchestrator loss never
manufactures an exit record.

On restart, a stale heartbeat triggers a single evidence read through a
platform process-identity adapter:

| Evidence | Decision | Consequence |
| --- | --- | --- |
| Exact process identity is alive, or the current pool retains any record for the workspace (`spawning`, `ready`, `idle`, `suspended`, or `crashed`). | `live_or_ambiguous` | Do not mark the run lost or release its reservation. |
| Exact recorded process identity is absent and the durable generation record has a valid identity. | `lost_proven` | Atomically record confirmed closure and permit the exact run transition. |
| Identity cannot be read, generation record is incomplete, PID is reused, health/evidence disagrees, or the record is still `creating`. A `stopping` record is resolved only if its exact captured identity is observed absent. | `unknown` | Preserve the reservation in durable degraded state; do not retry destructively. |

Heartbeat expiry alone is never `lost_proven`. A PID liveness probe alone is
never `lost_proven`. If the platform cannot provide an exact process-birth
identity, automatic loss recovery is unavailable on that platform and must
return `unknown`; safety wins over queue throughput.

## Confirmed error inventory

| ID | Finding | Required disposition |
| --- | --- | --- |
| RCO-01 | Restart loses the pool but durable terminal runs retain an attached owner. Pool absence is not death proof. | Add durable generation evidence and make absence only a candidate for evidence resolution. |
| RCO-02 | Current pool event cleanup cannot observe a generation from a prior orchestrator process. | Route prior-generation resolution through `EngineGenerationAuthority`; do not fabricate a pool event. |
| RCO-03 | Probe collapses missing engine, HTTP/status failures, missing session, timeout, and transport errors into `unreachable`. | Preserve a finite redacted unavailable reason; only `no_current_engine` can start evidence resolution, never finish it. |
| RCO-04 | Current server stale-terminal recovery is guarded only by process memory and can request recovery again after restart. | Persist a per-reservation handoff decision before the request; deduplicate by exact run/owner/evidence fingerprint. |
| RCO-05 | The 600-poll limit is process-local and terminal stale exhaustion has no durable operational outcome. | Persist `terminal_handoff_unresolved`, stop one-second polling, and rehydrate it without replay. |
| RCO-06 | Current route treats a current pool owner as a generic blocker rather than a named engine state contract. | Return typed `live_or_ambiguous` evidence for starting, ready, idle, suspended, incomplete, and changed generation states. |
| RCO-07 | The inspected runtime used an older server binary and could not exercise the source recovery path. | Verification must build server and orchestrator binaries, refresh the desktop sidecar, and record the resulting runtime evidence. |

## Non-goals

- Do not auto-restart, stop, reload, or replace an engine to unblock a queue.
- Do not make a terminal transcript or a completed provider response release
  authority.
- Do not use the UI, a client operation ID, a raw PID, or a stale heartbeat as
  proof of owner death.
- Do not discard durable queued prompts on startup.
- Do not reuse the runtime-operation owner as a second queue or owner-death
  ledger.
- Do not send prompts, credentials, URLs, local paths, raw upstream bodies, or
  process output in diagnostics.

## P0 implementation plan

### 1. Freeze the unsafe current boundary with tests

Add failing focused tests before behavior changes:

1. A terminal stale record with a missing pool entry but a live exact old child
   remains attached and blocks release.
2. An old child proven absent by exact process identity allows only its exact
   terminal run to become `lost`.
3. The same PID with a different process-birth identity is `unknown`, never
   `lost_proven`.
4. An authority row in `creating`, `stopping`, or unknown state, and a current
   pool record in `spawning`, `ready`, `idle`, `suspended`, `crashed`, or a
   changed generation, cannot permit the transition.
5. Restarting the server between a handoff request and its answer does not send
   a duplicate request or release the queue.
6. Reaching the handoff budget stores a durable blocked outcome and creates no
   further one-second timer.

Use fake process-identity adapters in unit tests; do not rely on timing or an
actual PID reuse to prove the decision table.

### 2. Add `EngineGenerationAuthority` under the orchestrator

Create a small authority and store abstraction beside the run store. Add an
`engine_generations` table to the existing orchestrator lifecycle SQLite
database and migrate it with the existing store pattern.

Expose only these operations:

```ts
registerCreating(input) -> generation
activateGeneration(input) -> generation
beginStop(generationId, reason) -> generation
confirmExit(generationId, reason) -> generation
resolveOwnerEvidence(exactRunOwner) ->
  | { kind: "lost_proven"; evidenceId: string }
  | { kind: "live_or_ambiguous"; reason: FiniteReason }
  | { kind: "unknown"; reason: FiniteReason }
```

The authority owns the platform adapter which reads an exact process instance.
The adapter returns `alive`, `absent`, or `unknown`; it must compare PID and
birth identity. It is intentionally fail-closed. No route, registry, or server
controller may call a raw PID liveness probe to decide owner loss.

Replace the pool's observational `(workspaceId, event)` callback as the
critical loss handoff with an awaited lifecycle hook carrying an immutable
engine-owner tuple. The hook may coexist with the old callback for logging,
but no correctness path may reconstruct a crashed owner later through
`pool.get(workspaceId)`. Its minimal contract is:

```ts
beforeEngineSpawn(ownerSeed) -> Promise<void>
afterEngineSpawn(engine) -> Promise<void>
beforeEngineStop(engine, reason) -> Promise<void>
afterEngineExit(engine, reason) -> Promise<void>
```

The pool invokes `beforeEngineSpawn` after allocating the random owner id but
before it creates the child. It awaits `afterEngineSpawn` after exact child
identity capture and before returning an engine that can accept a run. On a
child exit, it awaits `afterEngineExit` with the original immutable engine
object before any run-loss cleanup. This prevents map deletion, a replacement
generation, or a changed workspace entry from changing the identity being
closed.

Wire the pool and authority in this strict order:

1. Allocate the random owner id, then persist `creating` through
   `beforeEngineSpawn` before creating a child.
2. After spawn, capture exact process identity and persist `live` through
   `afterEngineSpawn` before any run can attach to this owner.
3. On pool child exit/crash, invoke `afterEngineExit` with the original tuple;
   it persists `exited_confirmed` before existing run-loss cleanup begins.
4. On intentional stop, invoke `beforeEngineStop` to persist `stopping`;
   persist confirmed exit only after the child has actually exited. A stop
   error yields `unknown`, not loss.
5. On orchestrator startup, retain old rows. Resolve an old row lazily only
   when its attached run blocks a reservation; do not add a broad startup sweep
   in P0.

The existing persisted engine snapshot remains diagnostic state only. It must
not be restored as a live lease or used as proof.

### 3. Make probe unavailability causal but bounded

Replace boolean-only `unreachable` with a closed, redacted reason:

```ts
type RunProbeUnavailableReason =
  | "no_current_engine"
  | "session_status_http"
  | "session_messages_missing"
  | "session_messages_http"
  | "request_timeout"
  | "request_transport_error";
```

The probe returns only this reason and an optional safe HTTP status. The run
registry forwards it on stale lifecycle responses. `no_current_engine` means
only that the in-memory pool lacks a current entry; it tells the recovery route
to ask the authority for evidence. It never bypasses the authority.

Add one test for every reason and tests proving that a timeout, status error,
or missing session cannot call `resolveOwnerEvidence`.

### 4. Replace the handoff route with a proof-gated transition

The server-to-orchestrator terminal-handoff route must:

1. Read the exact terminal run and require a complete attached owner tuple.
2. Reconcile it and require `stale` with probe reason `no_current_engine`.
3. Reject active peers for that exact owner.
4. Call `resolveOwnerEvidence`.
5. Only for `lost_proven`, update the exact run from `attached` to `lost` and
   return the evidence identifier plus fresh lifecycle state.
6. For `live_or_ambiguous` or `unknown`, return a typed non-mutating result.

The registry remains responsible for validating the exact tuple on the write.
The authority result is an additional required precondition, not a replacement
for the tuple fence. The route never calls `suspend` or any pool mutation for a
terminal handoff.

### 5. Persist server handoff workflow on the reservation

Extend the durable workspace-run reservation with a distinct
`terminal_handoff_unresolved` state and fields for:

- finite probe reason and authority result;
- owner/evidence fingerprint and last authoritative read time;
- requested/decided timestamps and a bounded attempt count;
- safe diagnostic reason and an explicit `resolvedAt` when applicable.

Before the server sends a recovery request, it persists the exact handoff
fingerprint as requested. If it restarts, it reads this state first and must not
repeat the same request. A new request is permitted only after a new
authoritative evidence fingerprint or an explicit server-owned retry policy;
it must not be caused merely by process restart or a timer.

Outcomes are:

| Orchestrator result | Durable reservation action | Queue action |
| --- | --- | --- |
| `lost_proven` | Re-read lifecycle. Mark resolved only after terminal readiness is true. | Release exactly this reservation, then wake one FIFO successor. |
| `live_or_ambiguous` | Persist `terminal_handoff_unresolved` with safe reason. | Keep intent durable; no release or dispatch. |
| `unknown`, route failure, or any other unavailable reason | Persist `terminal_handoff_unresolved` with safe reason. | Stop the one-second loop; no release, dispatch, or runtime mutation. |

The controller rehydrates unresolved reservations at startup, emits one
deduplicated decision trace, and projects them as blocked/degraded through the
run-status contract. It never restarts the old polling loop or replays a
recovery request because of restart, polling, or reconnect. The app may submit
one explicit retry-verification intent; the server atomically reopens only the
matching unresolved reservation and performs one new fenced evidence read.
The UI never decides loss, releases a reservation, or controls an engine.

### 6. Keep observability useful and private

Add finite, deduplicated events for:

- authority evidence decision and its safe reason;
- reservation handoff request, resolution, and unresolved persistence;
- startup classification, queue age bucket, and whether a retry was suppressed
  because the evidence fingerprint was unchanged.

Do not log message bodies, raw URLs, headers, tokens, absolute local paths,
raw provider responses, or process output. A terminal stale state emits an
initial decision and a state change, not an event every second.

### 7. Verification: prove the actual restart boundary

Run focused unit tests for the authority, probe, registry, route, queue store,
and lifecycle controller. Then add a deterministic full service-chain test
using the compiled server, compiled orchestrator, real OpenCode sidecar, and
preserved orchestrator/server data directories.

The service-chain test must cover all of these cases:

1. Start orchestrator generation A, admit a run, retain a queued successor,
   then terminate A without running its graceful shutdown.
2. Confirm the old child still exists. Start orchestrator generation B over the
   same durable data. Assert no `lost` transition, no reservation release, and
   no successor dispatch.
3. Terminate the exact old child, verify its recorded process identity is
   absent, then request handoff. Assert one `lost_proven` transition, one
   reservation release, and exactly one FIFO successor.
4. Restart the server before and after the request. Assert the persisted
   fingerprint prevents duplicate recovery and does not reset the retry budget.
5. Simulate PID reuse and unavailable process-identity inspection through the
   adapter. Assert both produce `unknown` and no release.

For desktop proof, follow the documented single-tenant preflight, build server
and orchestrator binaries, refresh the desktop sidecar, and add a focused
WebDriverIO scenario. It must send through visible controls, use an isolated
workspace and only loopback E2E fault control where required, visibly show the
blocked/degraded handoff state, and verify continuation after a proven owner
loss. The scenario must retain a redacted artifact under the existing
WebDriverIO diagnostics convention. Legacy Tauri Pilot scenarios are not
acceptable evidence.

## P1 follow-up

After P0 proves the on-demand blocked-handoff path, evaluate a rate-limited
startup sweep over persisted attached generations. It must call the same
authority, retain the same fail-closed semantics, and never release a
reservation solely because a pool is empty. Do not add it before P0: on-demand
resolution is smaller, observable, and materially safer.

## Acceptance criteria

1. An old terminal owner is marked `lost` only after an exact durable
   generation proof; new-pool absence, heartbeat expiry, and a raw PID never
   suffice.
2. A live orphaned engine cannot be interrupted or bypassed by a new
   orchestrator/server generation.
3. An unprovable old owner becomes a durable visible degraded state, not an
   infinite one-second reconcile loop or a silent deadlock.
4. Server restart does not repeat an identical handoff request or reset its
   outcome.
5. The server remains the sole owner of reservation release and successor
   dispatch; UI never becomes a lifecycle authority.
6. Diagnostics distinguish finite causal categories without sensitive data.
7. Focused tests and a real WebDriverIO desktop scenario prove the preserved
   datastore/restart boundary using rebuilt binaries.
