---
title: Retry and Error Containment Audit
status: in_progress
done: false
date: 2026-07-31
issue: unlinked
scope: local desktop conversation send, lifecycle, queue, and runtime recovery
related:
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/conversation-workflow-contract.md
  - docs/plans/2026-07-28-adjacent-runtime-lifecycle-cache-findings-plan.md
  - docs/plans/2026-07-28-server-owned-submit-missing-live-binding-recovery-kiss-plan.md
---

# Retry and Error Containment Audit

## Decision

Veslo must not have one generic retry mechanism. A retry is safe only when its
owner knows which side effects may already exist and has a bounded outcome.

The target contract is therefore:

```text
pre-commit failure       -> one typed recovery, then terminal result
unknown delivery outcome -> one idempotent replay of the same intent
observability failure    -> bounded observation only; never changes run ownership
lost runtime ownership   -> durable terminalization before queue release
terminalization failure  -> retry the terminalization itself; do not silently stop
```

This plan is an audit and implementation plan. It does not authorize a broad
rewrite of every `try/catch` in the repository. It covers only paths that can
retain or replay a local conversation run. Update-download retries, telemetry
delivery, skill publication, and unrelated cloud calls have independent
ownership and are explicitly out of scope.

## Evidence boundary

The audit was performed against the current local checkout on 2026-07-31,
including the current send-path change that makes ordinary composer text a
prompt and the lifecycle changes that close startup assistant-message orphans
and one-minute unreachable-engine runs.

The following facts are code-path confirmed, not inferred from UI labels:

| Area | Current bounded behavior | Current terminal behavior |
| --- | --- | --- |
| Existing local server-owned submit | Exact pre-HTTP missing-live-binding failure performs one fresh runtime preparation and one resubmit. | Any other typed preflight error is returned without recovery. |
| Submit transport uncertainty | One replay uses the same `clientMessageId`; server idempotency coalesces the same request. | Known 4xx server responses do not enter transport replay; a second transport error becomes `outcome_unknown`. |
| Server submit attempt store | Completed/materialized/queued results are replayable. | Blocked and failed results are deliberately re-evaluated on an explicit repeat, retaining the prior materialized target. |
| OpenCode model retry | OpenCode `retry` status is observed as `model_retry_no_output`; after 10 minutes it retains a durable diagnostic but remains the same active exact run. | It never becomes an automatic failure or queue-release signal. After the normal server poll budget, one 30-second exact-run background observation continues until transcript or lifecycle evidence becomes terminal. |
| Server lifecycle polling | One-second polling, maximum 600 attempts. | An unresolved active run is marked failed and the queue is released after the budget, provided the terminal write succeeds. |
| App lifecycle watching | Five-second polling after an initial five-second delay, maximum 600 attempts (about 50 minutes). | It presents `recoveryState: exhausted`; it does not change server lifecycle ownership. |
| Transcript recovery | Server ingest tries at most three reads with 0/2/8 second delays; app terminal hydration has one automatic retry. | Exhaustion is presentation/recovery state only, never a queue or lifecycle transition. |
| Engine crash recovery | The pool restarts at most three times with 1/2/4 second backoff; engine-loss notifications retry at most three times. | The run registry marks runs for the exact lost engine generation terminal before the best-effort server callback. |
| Desktop orchestrator startup | A child that exits before health succeeds may be started once more. | A healthy-but-unreachable or second failed start returns a terminal startup error. |

## Current causal graph

```text
user submit
  -> app preflight
     -> exact missing binding: one runtime recovery
     -> transport exception: one idempotent replay
  -> server attempt record + run admission
     -> OpenCode accepted: lifecycle reservation + observation
     -> OpenCode submit error: fail/release path
  -> orchestrator run registry
     -> active / retry / idle / terminal evidence
  -> server lifecycle controller
     -> terminal durable write
     -> release reservation
     -> wake next queued request
  -> app watch
     -> presentation and transcript hydration only
```

The invariant that prevents a cascading error is not "retry until it works".
It is that an accepted run has exactly one durable owner, and the next queued
request is admitted only after that owner has reached a trustworthy terminal
state.

## Confirmed protections

### Idempotent send replay is scoped correctly

The app keeps the same `clientMessageId` for its one transport replay. The
server hashes the request and either joins an in-flight attempt, returns a
stored replayable result, or rejects a different payload as an idempotency
conflict. This prevents a lost response from becoming two distinct OpenCode
submits.

The server intentionally does not replay stored failed or blocked results.
That is an explicit user retry decision, not an automatic loop: the request is
re-evaluated using the existing materialized conversation/session target.

### Observation does not decide ownership

Both transcript-recovery layers are bounded and explicitly avoid lifecycle or
queue transitions. A missing transcript can make the UI say unavailable, but
cannot make a still-active run fail or admit the next queued prompt.

Likewise, app lifecycle polling only reports status. Once it exhausts, it
stops rather than attempting to manufacture a terminal server result.

### Known engine loss is generation-fenced

The orchestrator associates an active run with the exact engine owner tuple.
When that engine exits, only matching runs are terminalized. The callback to
the server is a convergence hint, not the source of truth, and has its own
small retry budget. This avoids a new engine being mistaken for the failed
one.

### Newly added containment

Two previously long-lived states now have short explicit bounds:

1. On startup, an unknown assistant-message reservation with no useful
   progress for one minute is failed and released instead of entering the
   ten-minute polling loop.
2. During normal reconciliation, an active run whose engine has been
   unreachable for one minute since its last useful progress is failed and
   released.

These rules are intentionally narrower than a generic inactivity timeout, so
they do not abort a legitimate long-running tool or model response.

## Findings

### REC01 — every terminalization path must keep ownership until its durable write succeeds

Severity: high

The lifecycle controller has several branches that have already decided a run
is unrecoverable: reconciliation budget exhausted, startup orphan, and
unreachable engine after its grace window. Those branches call the
orchestrator's `markFailed`, release the local reservation only after success,
and record a trace if that write fails.

The upstream-submit-error branch is worse: its `markFailed` helper catches and
only traces an error, then the caller schedules reconciliation, unregisters
the gateway context, and releases the reservation unconditionally. A failed
terminal write can therefore admit a successor while the durable run remains
active. This directly violates the target ordering: durable terminalization
must precede queue release.

None of these catch paths owns a bounded durable terminalization retry. In the
reconciliation branches, a transient failure can preserve the durable
reservation until an unrelated queue drain or restart happens to re-arm it. In
the submit-error branch, the opposite happens: the reservation is released
despite the uncertain durable transition. Both outcomes are invalid; runtime
uptime and accidental queue activity must not be recovery mechanisms.

This is the closest confirmed answer to "one early failure follows the program
for hours": the intended terminal transition has been chosen, but its failed
commit has no owner after the catch.

Required repair:

- Extract every terminalization source into one helper: submit error,
  reconciliation exhaustion, startup orphan, unreachable engine, and any
  future explicit terminal handoff. That helper alone owns
  `markFailed -> release -> queue wake`.
- Keep the reservation while the durable terminal write is uncertain; never
  release and resubmit merely because the write request failed.
- Persist `terminalization_pending` on the reservation row with terminal
  reason, attempt count, last error, next-attempt time, and a soft escalation
  deadline. Startup scans these rows and schedules their exact retry without a
  new submit, queue drain, or user action.
- Use retries of 1, 2, 4, 8, and 15 seconds, then retain one capped 60-second
  exact-run retry. The soft deadline is five minutes: it changes the server
  projection and UI to "finalizing previous run", but never auto-releases the
  queue. This is one timer per exact run, not a new polling loop.
- Add a server lifecycle `terminalization` projection from the durable
  reservation: `{ state: "pending", reasonCode, attempts, nextAttemptAt,
  deadlineAt }`. Keep the orchestrator's existing run `status` separate and
  never expose the raw last error to the UI. The app shows the projection as a
  blocking/recovering state; it must not call it completed, failed, or retry
  the prompt.
- Retry only the state transition. Do not repeat OpenCode submit, runtime
  preparation, or transcript ingest from this path.

### REC02 — compatibility and SSE recovery still admit a broad upstream-error string

Severity: medium

The app's runtime-health classifier treats the string
`opencode_request_failed` as recoverable, along with connection failures and
several 404/502/503 forms. That classifier remains in the compatibility
conversation-run bridge and in SSE route recovery.

This is not the normal server-owned composer path. In that path, the server
turns a post-materialization upstream exception into an HTTP-200 structured
`failed` result; the app consumes it as terminal. The server's own
orchestrator fallback also excludes an upstream HTTP 500 from its
stale-route retry predicate. The old `ahoj` incident therefore does not prove
that a current ordinary prompt will restart its runtime after a structured 500.

The risk remains in the fallback bridge and SSE: a deterministic upstream
failure represented only by that generic string can be treated as local route
loss and cause a fresh runtime attempt. The bridge limits this to one attempt
per send; SSE has the separate per-outage gap in REC06. This is incorrect
classification and recovery noise, not a confirmed primary send-path loop.

Required repair:

- Define a server-client `recoveryCategory` contract, carried by the typed
  submit/route response rather than parsed from an error message:
  `local_route_unavailable`, `stale_local_bearer`,
  `delivery_outcome_unknown`, and `upstream_terminal`. The compatibility
  bridge consumes this union directly. `local_route_unavailable` must include
  the workspace and runtime-route epoch that established it.
- Remove bare `opencode_request_failed` from the generic local-runtime
  classifier unless it carries proof that the local engine or route was lost.
- SSE may recover only from a typed local route result or an exact local-bearer
  response with a matching route epoch. A generic OpenCode `session.error` is
  presentation/lifecycle evidence, never runtime-recovery evidence.
- Preserve the current main-path contract: one recovery for exact pre-HTTP
  missing binding and one idempotent replay for uncertain transport delivery;
  neither applies to a structured terminal upstream result.

### REC06 -- SSE runtime recovery has no outage-level attempt budget

Severity: medium

The event-stream reconnect path serializes concurrent recovery for a workspace
through a fresh-runtime single-flight key, but that is a concurrency guard, not
an attempt budget. Both a stream connection error and a `session.error` with a
local stale-bearer signal can release the route and request a forced fresh
runtime. Neither path records that recovery was already attempted for the
current outage episode.

This is not a duplicate OpenCode submit path: the recovery only rebinds the
runtime route. It can nevertheless turn one persistent local-runtime symptom
into repeated expensive fresh-runtime preparation whenever a new stream/error
cycle is created. The generic text classification in REC02 widens that entry
condition.

Required repair:

- Add a `RuntimeRecoveryEpisode` registry owned by the event-stream controller,
  not by an individual SSE subscription. Its key is workspace plus the runtime
  route epoch; it records whether fresh recovery was consumed.
- An episode starts at the first recovery-eligible typed route failure and
  survives ordinary SSE reconnects, replacement subscriptions, and route
  release/reacquisition. It ends only after the recovered route has attached a
  stream and that stream completes its normal reconnect catch-up successfully;
  explicit user retry, workspace disposal, or a confirmed new runtime route
  epoch also starts a new episode.
- Permit one automatic fresh runtime recovery per episode. After it is spent,
  retain a stable degraded/reconnecting state and use normal reconnect backoff;
  do not keep forcing fresh runtimes.
- Share the typed local-runtime classification from REC02 between stream
  connection errors and `session.error` handling.
- Keep the existing single-flight gate for concurrent callers; it solves a
  different problem and remains necessary.

### REC03 — app watch and server lifecycle use independent long budgets

Severity: medium

The server polls an exact run every second up to 600 times. The app polls the
same lifecycle surface every five seconds up to 600 times. They have different
purposes, but their budgets are not derived from a shared contract.

If the app cannot read the server while the server is still alive, the app can
retain a "watching"/connection-unavailable state for roughly 50 minutes. If
the server itself is unable to resolve the active run, it can use its ten-minute
budget independently. The UI loop does not mutate ownership, but it prolongs
the appearance of an unresolved failure and makes incident traces hard to
interpret.

Required repair:

- Keep separate named deadlines by purpose; do not collapse them into one
  timeout: server ownership reconciliation remains 600 x 1 second,
  terminalization uses REC01's exact-run backoff, and transcript recovery keeps
  its existing bound.
- Publish the server's authoritative terminalization projection in the
  lifecycle response. The app should present that state rather than
  continue a blind independent watch.
- On status-unavailable only, allow one server-only foreground ensure and then
  at most 12 five-second UI observations (one minute after the initial
  delay). Transition to a stable `connection-unavailable` presentation that
  resumes only on an explicit reconnect/retry action or confirmed server
  reconnection event.
- Preserve app polling for normal active runs and do not let UI exhaustion
  abort a backend run.

### REC04 — model retry remains one background run after the no-output limit

Severity: medium

The run registry records `model_retry_no_output`. The old hard limit changed
the run to `blocked`; because `blocked` was still active, a later server poll
budget could convert it into an unrelated terminal failure and release.

This is safe against prematurely discarding a model retry, but it can still
turn an output-delivery or observation problem into an unrelated terminal
failure and makes the observed duration depend on reconciliation churn.

Required repair:

- **Recorded decision:** elapsed no-output time is diagnostic only. It does
  not terminate or release an exact OpenCode run, because the answer can
  already exist in the canonical transcript while delivery/UI observation is
  degraded.
- Keep the registry status active and retain the durable queue reservation.
  Once the normal server poll budget is spent, replace one-second polling with
  one 30-second exact-run background observation. Never admit a successor
  until an explicit stop or a trustworthy terminal lifecycle/transcript result.
- Do not use UI error styling as a terminal signal. Present retry as background
  activity with an explicit Stop action; transcript evidence clears the
  diagnostic and returns to normal lifecycle convergence.
- Add deterministic tests proving the hard diagnostic remains active, preserves
  queue exclusion, performs one low-churn follow-up, and clears when useful
  assistant progress arrives.

### REC05 — manual retry has no abort outcome to base its queue semantics on

Severity: medium

The composer Retry action conditionally calls abort when the run indicator is
visible, then invokes `retryLastPrompt`. It does not reliably receive an abort
outcome: the lower abort method catches request errors and returns `void`, and
the caller also deliberately proceeds after an exception. The practical
behavior is therefore fail-open retry/queue admission, not a proven abort.

The server active-run gate usually turns the new request into a durable queued
item rather than a duplicate OpenCode run. That protects OpenCode, but the UI
still promises "try again" while the previous ownership may be unknown and a
queue can accumulate behind an abort that never committed.

Required repair:

- Return a typed abort result that distinguishes terminally aborted,
  already-terminal, pending reconciliation, and unknown outcome.
- When abort is unknown, present "waiting for the previous run to settle" and
  offer an explicit queue choice instead of silently treating it as a retry.
- Keep the durable queue as the only automatic serialization mechanism; never
  force a second OpenCode submission from the app.

## Implementation order

0. **REC04 decision gate.** Select and record the hard model-retry terminal
   authority before implementing any blocked-state queue semantics.
1. **REC01 first — durable terminalization state machine.** It repairs both
   confirmed violations: abandoned reservations after a failed final write and
   premature release after a submit-error final-write failure. Add durable
   state, restart recovery, and diagnostics before changing timeouts.
2. **REC02 — typed recovery classification.** This prevents deterministic
   upstream failures from creating runtime recovery noise and restart churn.
3. **REC06 — bound an SSE outage recovery.** Apply the typed condition before
   adding the per-outage budget, so a deterministic upstream failure cannot
   consume it.
4. **REC03 — one published lifecycle deadline contract.** Make UI observation
   consume server authority instead of maintaining a longer independent loop.
5. **REC04 — implement the recorded model-retry contract.** Add the selected
   terminal semantics and the full queue handoff coverage.
6. **REC05 — truthful manual retry.** Align the user action with the durable
   abort/queue state after the lower-level ownership contracts are fixed.

## Implementation checkpoint (2026-07-31)

Implemented before the REC04 decision gate:

- **REC01:** every existing terminal `markFailed` path, including submit failure, retains its reservation until durable success. A SQLite-backed `terminalization_pending` state retains the reason code, attempts, last internal error, next retry, and soft deadline. Startup restores the same exact-run retry; the app receives a safe `terminalization` projection and blocks new local presentation while finalization is pending.
- **REC02:** local automatic recovery is selected from typed `VesloServerError.code` categories first. The compatibility text path is limited to engine/workspace/bearer/transport evidence; raw OpenCode upstream failure text and bare upstream HTTP status no longer trigger a rebuild.
- **REC06:** the event-stream controller owns runtime recovery per workspace outage rather than per subscription. A replacement or reconnect cannot spend another fresh-runtime recovery; a successful attached stream clears the episode. The UI switches to stable degraded state after one minute while reconnect backoff remains transport-only.
- **REC03:** accepted runs that cannot read lifecycle status perform one server-only ensure and at most 12 five-second UI observations. They then retain `connection-unavailable` as a resumable presentation and never alter backend ownership.
- **REC05:** abort now returns `pending_reconciliation`, `already_terminal`, or `unknown`. Retry stops on `unknown` rather than fail-open submitting a new prompt.
- **Fault controls:** E2E-only controls now arm a bounded number of failed local-server `markFailed` writes and repeated shared-engine proxy failures. They are unavailable without `VESLO_E2E_FAULT_INJECTION=1`; the desktop/Pilot convergence scenario remains to be added.
- **REC04:** the selected contract keeps `model_retry_no_output` as the same active exact run, even after the long no-output diagnostic threshold. It never auto-fails or releases the queue; after the normal reconcile budget the server owns one 30-second exact-run background observation. Useful assistant transcript progress clears the diagnostic, and the UI presents retry as background work rather than an error.

The remaining desktop/Pilot scenario must prove this state converges through a
real transcript/SSE recovery without admitting a duplicate run.

## Acceptance tests

### Server lifecycle

1. Force `markFailed` to fail once for every terminalization source, including
   upstream submit failure, reconciliation exhaustion, startup orphan, and
   unreachable engine. Assert no OpenCode submit is repeated, the same run
   identity is retried, the reservation remains until success, and the next
   queue item is released exactly once.
2. Force the upstream-submit-error path to fail its terminal write. Assert the
   reservation is not released, no successor is admitted, and a restart without
   a new submit retries the persisted pending record and then releases exactly
   once.
3. Advance through the quick retry budget and soft deadline. Assert the row
   stores terminal reason, attempts, redacted last error, next-attempt time,
   and deadline; the server lifecycle response projects
   `terminalization: { state: "pending", ... }`; only one capped exact-run
   timer remains.
4. Prove startup orphan, engine-unreachable, normal long-running tool, and
   assistant output are classified separately.
5. Advance a fake clock through model retry hard limit and assert the selected
   owner produces the terminal/blocked state and one queue outcome.

### App send and SSE

1. A structured OpenCode 500 response is terminal and performs neither runtime
   rebuild nor send replay.
2. A pre-HTTP missing live binding performs exactly one runtime recovery and
   one resubmit using the same `clientMessageId`.
3. A genuine transport exception performs one idempotent replay; a second
   exception becomes unknown outcome without another recovery.
4. An SSE text error without typed local-runtime evidence cannot restart an
   engine. Stale bearer and confirmed local route loss perform at most one
   scoped recovery per outage, then use reconnect backoff until a healthy stream
   starts a new episode.
5. Repeated SSE disconnect, subscription replacement, and reconnect cycles in
   one workspace/route epoch consume one fresh-runtime recovery. Only a
   completed catch-up, explicit retry, workspace disposal, or confirmed new
   route epoch starts another episode.
6. With server status unavailable, the app reaches its short observation
   terminal presentation; it never aborts or duplicates the server run.
7. Retry after an abort failure either waits for lifecycle settlement or creates
   an explicit queued item; it never claims the old run was stopped.

### Real desktop validation

Use the Tauri Pilot lifecycle surface after unit coverage is green. Add two
test-only fault controls, enabled only by `VESLO_E2E_FAULT_INJECTION=1`:

- a Veslo-server `fail-next-lifecycle-mark-failed(count)` control that makes
  the lifecycle client fail before its `markFailed` POST; and
- an orchestrator shared-proxy `fail-next-proxy(count)` control, extending the
  existing one-shot proxy fault to create repeated route-error cycles.

Then simulate:

1. upstream command failure returning a structured 500;
2. engine process loss while a prompt is active;
3. lifecycle terminalization endpoint unavailable for one attempt and across a
   server restart; and
4. repeated app-to-server/SSE route failures while the server continues
   reconciling.

For every scenario, capture the same `conversationId` and `runId` through the
app, server, and orchestrator traces. Pass only when there is one final owner,
no duplicate OpenCode submit, no unbounded timer, and a deterministic queue
outcome.

## Non-goals

- Do not lower all timeouts globally.
- Do not auto-release a reservation when durable terminalization is uncertain.
- Do not retry a command/prompt merely because its upstream result is 500.
- Do not use transcript recovery, SSE state, or UI labels as lifecycle
  authority.
- Do not merge skill, update, telemetry, or unrelated cloud retry policies into
  the conversation-run state machine.
