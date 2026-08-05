---
title: Runtime Authorization Continuity Across Server Worker Replacement Implementation Plan
date: 2026-08-04
updated: 2026-08-05
status: in_progress
done: false
scope: preserve managed-AI authorization across local Veslo server worker replacement without persisting bearer credentials; make the recovered state observable and verify it in the real desktop runtime
related:
  - docs/plans/2026-08-04-queued-transcript-turn-continuity-and-reconnect-ordering-plan.md
  - docs/plans/2026-08-04-runtime-degraded-state-ownership-and-diagnostics-plan.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/veslo-application-logs.md
---

# Runtime Authorization Continuity Across Server Worker Replacement Implementation Plan

## Outcome

When the local Veslo server worker is replaced while a managed-AI OpenCode run
is still live, the new worker restores only the proven run correlation. The
desktop then supplies a fresh authorization through the normal authenticated
access-prime request. The run resumes only when that authorization matches the
durable run identity. If it cannot be proved before a short recovery deadline,
the exact run is deliberately terminalized and fenced before a successor can
start.

The implementation must work for both direct submits and server-queued submits.
It must not persist a gateway bearer, caller bearer, refresh token, or an
equivalent replay credential.

## Runtime contract

```text
accepted managed-AI run
  -> lifecycle store writes run + recovery descriptor atomically
  -> worker owns in-memory gateway authorization and active-run correlation

worker replacement
  -> new worker hydrates active descriptors before accepting gateway traffic
  -> it restores correlation only and marks the run auth-recovery-pending
  -> desktop sees a new worker generation and re-primes current authorization
  -> exact identity match releases the pending gateway request

missing / expired / mismatched proof
  -> request one exact owner-fenced handoff through the normal lifecycle path
  -> mark the run terminal only after its engine exit is observed
  -> otherwise keep it fenced and reject a successor rather than asserting death
  -> no generic late authorization 401 and no replay
```

## Non-negotiable invariants

1. The engine never authorizes itself. A session header, placeholder, workspace
   ID, or engine claim may locate a request only after server-owned durable
   evidence restored its exact run correlation.
2. A recovery authorization must match the run's actor-token hash,
   organization scope, workspace, run ID, engine session ID, and current engine
   owner tuple.
3. The descriptor is non-secret. It may identify an authorization subject but
   never stores a bearer or data sufficient to recreate one.
4. Ambiguity, expiry, actor mismatch, organization mismatch, stale owner, or
   missing desktop proof always fails closed. A terminal state is recorded only
   after the owner-fenced handoff proves the engine exited; an unconfirmed
   handoff remains explicitly fenced and blocks a successor.
5. An authorization recovery wait is bounded and shorter than the gateway
   proxy header timeout. It is not a longer model timeout or an automatic
   submit retry.
6. Worker generation, not PID, defines a worker replacement boundary. A PID is
   diagnostic metadata only.
7. A run that is already terminal, whose engine owner changed, or whose
   descriptor was removed is never rehydrated, authorized, or stopped by this
   protocol.

## Data model and ownership

### Lifecycle store owns the recovery descriptor

Add a `conversation_run_gateway_recovery` record in the lifecycle database,
keyed by `(workspace_id, run_id)`. Keep it beside the durable conversation run,
not in queue-body JSON and not in the server process map.

The record contains:

- `workspace_id`, `conversation_id`, `run_id`, and `engine_session_id`;
- `expects_managed_ai_gateway`;
- `actor_token_hash` and normalized organization scope;
- `issued_at`, `expires_at`, and recovery state; and
- the engine owner tuple: slot, owner ID, PID, started-at value, and base URL.

The lifecycle registration request receives this descriptor only for a run that
expects the managed-AI gateway. The lifecycle service writes the run and
descriptor in one transaction. It exposes the descriptor only on its local
authenticated lifecycle API; public conversation status responses never expose
the actor hash or organization scope.

On every terminal state the lifecycle service marks the descriptor terminal in
the same transaction as the run status. A periodic cleanup may remove terminal
descriptors later, but no active descriptor is removed during worker restart.

### Server worker owns temporary authorization

The server retains bearer material only in its existing in-memory runtime
authorization owner. It gains two explicit transient structures:

- hydrated active-run contexts reconstructed from lifecycle descriptors; and
- a run-keyed authorization-recovery gate with `pending`, `authorized`, and
  `terminalizing` states.

Hydration does not authorize a run. It only restores enough trusted correlation
to map a future placeholder session request to the exact active run.

### Desktop owns re-prime

The desktop remains the source of current user credentials. It already has the
authenticated access-prime path; reuse that path rather than adding a bearer
store to the server.

Expose `workerGeneration` in the local server status/descriptor. Include it in
the desktop authorization-prime cache key. A changed generation invalidates a
successful cache entry immediately and triggers a fresh prime for an active
managed-AI workspace. This happens on normal server reconnect/descriptor
refresh; it does not depend on a submit button being pressed again.

## Slice 1 -- durable descriptor and lifecycle contract

**Owner:** lifecycle run persistence and server-to-lifecycle registration.

1. Add the recovery descriptor schema and migration to the lifecycle store.
2. Extend lifecycle run registration with an optional managed-AI recovery
   descriptor. The server derives it from the authenticated submit context
   before it submits the run to OpenCode.
3. Require a valid actor-token hash and normalized organization scope before a
   managed-AI run is admitted. Reject an incomplete descriptor before any
   engine work begins.
4. Persist the exact engine session and update the owner tuple when the engine
   owner is attached. Reject a later conflicting tuple instead of overwriting
   it.
5. Extend the internal lifecycle status/bootstrap response with active recovery
   descriptors. Keep the existing client-facing run response redacted.
6. Mark the descriptor terminal atomically on completed, failed, and aborted
   runs.

**Acceptance criteria:** a newly created direct run and a queue-drained run
have equivalent active descriptors; restarting the lifecycle reader preserves
the exact descriptor; a terminal run has no recoverable descriptor.

## Slice 2 -- worker bootstrap and gateway recovery gate

**Owner:** server startup, gateway runtime owner, and lifecycle controller.

1. Generate a fresh `workerGeneration` at server boot before the worker reports
   readiness or serves proxy traffic.
2. During startup, load active recovery descriptors from the lifecycle owner.
   For each descriptor, reread the lifecycle status and restore it only if the
   run is active and its current engine tuple exactly matches the descriptor.
3. Install the restored session-to-run contexts before the gateway proxy starts
   accepting managed-AI requests. A request carrying
   `${OPENCODE_SESSION_ID}` must resolve through this restored context, never
   through a workspace-only fallback.
4. Mark each restored run `authorization_recovery_pending`. Gateway requests
   for that exact run wait on its gate rather than entering generic runtime
   authorization lookup.
5. Let the normal authenticated access-prime request satisfy a gate only when
   its actor hash, organization scope, and workspace match exactly. Register
   the received bearer only in memory, mark the gate authorized, and release
   its pending request.
6. If the descriptor is stale, a matching prime cannot arrive before the
   recovery deadline, or the authorization is expired, transition the gate once
   to `terminalizing`. Stop only the matching OpenCode session through the
   existing owner-fenced lifecycle handoff. Write a terminal run state only if
   that handoff observes process exit. If exit cannot be observed, retain a
   durable owner fence and reject a successor; never manufacture
   `exited_confirmed` from a timeout or an ignored stop result.
7. Return a dedicated safe recovery outcome for that request path, never
   `gateway_runtime_authorization_required`. Do not replay the original prompt
   and do not release a queued successor until terminal handoff is proven.
8. Remove the hydrated context and gate after terminalization or normal run
   completion.

**Acceptance criteria:** a restored run can process a later placeholder-session
gateway request only after a matching fresh prime. A missing or mismatched
prime produces one deliberate fenced outcome. A successor is admitted only
after the owner-fenced handoff proves the old engine exited; otherwise neither
run is authorized.

## Slice 3 -- desktop generation-aware re-prime

**Owner:** local server descriptor handling and managed-AI runtime config.

1. Add `workerGeneration` to the local server status returned to the desktop.
2. Add it to the runtime-authorization-prime success-cache key and clear the
   cache whenever the connected server generation changes.
3. On a successful server descriptor refresh with a new generation, start one
   single-flight access prime for each active managed-AI workspace that has a
   pending recovered run. Reuse the existing authenticated access request and
   existing user-facing sign-in errors.
4. Keep normal reconnect presentation separate from an outage. This internal
   re-prime must not create a misleading "connection lost" banner.
5. If the user is signed out, access has been revoked, or the prime fails, let
   Slice 2 own the finite terminal outcome; do not retry the original submit.

**Acceptance criteria:** a worker replacement inside the previous prime-cache
window still sends a real fresh prime to the new worker. A stale cache entry
never reports authorization readiness for a different generation.

## Slice 4 -- replacement attribution

**Owner:** server trace envelope and native server supervisor.

1. Add `workerGeneration` to every server trace envelope and startup/shutdown
   event.
2. Record replacement boundaries in the native supervisor with previous and
   next generation/PID, requested initiator, observed exit status, and stderr
   when available.
3. Use only these classifications: `explicit_control_plane_rebind`,
   `watch_reload`, `desktop_shutdown`, `unexpected_child_exit`, or `unknown`.
   Lack of evidence stays `unknown`.
4. Surface the latest replacement record through diagnostics without exposing
   credentials.

**Acceptance criteria:** a later worker replacement has a unique generation
boundary and either an evidence-backed initiator or an explicit `unknown`.

## Slice 5 -- failure-reason projection

**Owner:** lifecycle status route and workflow trace serializer.

1. Map durable failed-run errors to a small safe classification, including
   `runtime_authorization_recovery_unavailable` and
   `runtime_authorization_recovery_mismatch`.
2. Add that classification to terminal workflow trace events and diagnostic
   mirrors when `status` is `failed`.
3. Preserve the existing raw durable error for local lifecycle handling, but
   never copy bearer material, request bodies, or unbounded upstream text into
   traces.
4. Do not require an error reason for `completed` runs.

**Acceptance criteria:** a failed managed-AI run is diagnosable from the
workflow trace without revealing a credential; a completed run remains a valid
reason-less terminal result.

## Verification

The primary proof is a real Tauri desktop WebDriverIO scenario with a controlled
managed-AI provider and preserved durable data. Add a narrow test-only worker
replacement control; do not use a UI-only server or a map reset as the primary
proof.

1. Start a direct managed-AI run, let its first model request succeed, hold the
   next request, replace only the server worker, and release the request after
   desktop re-prime. Assert one run, one user turn, no duplicate provider
   request, and successful completion without a generic 401.
2. Repeat while the desktop cannot re-prime. Assert one controlled fenced
   outcome and an exact engine handoff. Admit a successor only after observed
   old-engine exit; if the stop result is ambiguous, assert that the successor
   remains blocked rather than treating the run as terminal.
3. Repeat with two active managed-AI contexts using different workspace and/or
   organization bindings. Prime one and prove that the other remains pending
   until its own matching prime arrives.
4. Replace the worker during the former authorization-prime cache interval and
   assert that the desktop performs a new access-prime request.
5. Run the equivalent gateway-recovery gate cases in focused lifecycle/server
   tests: direct versus queued admission, descriptor migration, owner-tuple
   mismatch, descriptor cleanup, gateway expiration, and diagnostic redaction.
6. Run the normal changed-surface quality gate after the desktop scenario.

## Explicit non-goals

- Persisting bearer credentials or adding a server-side credential vault.
- Replaying a prompt, widening model timeouts, or adding automatic submit
  retries.
- Authorizing from an engine-provided identifier or from a workspace-only
  active-run fallback.
- Treating an expected re-prime during worker replacement as a user-visible
  network outage.
- Combining this implementation with the independent orphan-assistant or
  missing-terminalization investigations.

## Implementation sequence

This is the execution order. Each item has one owner, one concrete output, and
one completion condition; it is not an investigation checklist.

| Step | Owner | Implementation output | Done when |
| --- | --- | --- | --- |
| 1 | Lifecycle persistence | Non-secret recovery descriptor, migration, atomic registration and terminal cleanup, plus a redacted internal bootstrap response. | Direct and queue-drained runs persist the same exact descriptor; completed/failed/aborted runs are not recoverable. |
| 2 | Server recovery boundary | Fresh worker generation, pre-proxy hydration, exact session-to-run correlation, and one recovery gate per durable run. | A recovered placeholder request cannot fall through to workspace-only or generic authorization. |
| 3 | Server failure path | Matching-prime release and one owner-fenced deadline path with safe recovery outcomes and trace classification. | A matching fresh prime releases only its own run; a missing/mismatched prime neither replays nor authorizes a run, and an unobserved stop blocks successors. |
| 4 | Desktop runtime config | Generation-aware authorization-prime cache and one re-prime per active affected workspace. | A changed worker generation produces a new authenticated prime even inside the old cache interval and does not present as a connection outage. |
| 5 | Native supervisor and diagnostics | Replacement record and worker generation on server trace/health surfaces. | Diagnostics identify the replacement boundary and evidence-backed initiator without credentials. |
| 6 | Focused support tests | Lifecycle, server, orchestrator, and isolated daemon replacement tests for direct/queued descriptors, mismatch, expiry, redaction, and cross-workspace isolation. | All focused tests pass, including the no-prime fence and two-context isolation cases. |
| 7 | Desktop WebDriverIO | An isolated, controlled-provider Tauri runtime that holds a provider request across server-worker replacement. It must use native WebDriverIO, not Tauri Pilot and not a UI-only server. | It proves one direct run/turn/request, fresh re-prime after replacement, successful release after a matching prime, and a no-prime case that keeps a successor fenced until observed exit. |
| 8 | Regression gate | Standard changed-surface type, lint, Rust, server, app, orchestrator, and WebDriver checks. | All selected gates are green; the desktop proof is reported separately, not inferred from support tests. |

### Current implementation boundary

Steps 1--6 are implemented and have focused automated coverage. Step 7 is the
remaining release-blocking proof: the current live WebDriver scenario exercises
a real signed-in desktop runtime and worker restart, but cannot deterministically
hold or count provider requests. Implement its isolated controlled-provider
runtime before marking this plan complete. Do not substitute a headless daemon
test, a trace counter, or a successful later submit for that proof.

Step 8 may run in parallel with Step 7, but it does not turn Step 7 into an
optional check. No slice is claimed complete merely because its support tests
are green.
