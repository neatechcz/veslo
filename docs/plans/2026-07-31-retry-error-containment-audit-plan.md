---
title: Retry and Error Containment Audit
status: proposed
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
| OpenCode model retry | OpenCode `retry` status is observed as `model_retry_no_output`; after 10 minutes without output the registry reports `blocked`. | It is not terminal at that owner. The server lifecycle reconciler may finally mark it failed when its own poll budget expires. |
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

### REC01 — terminalization write failure can leave a reservation with no next action

Severity: high

The lifecycle controller has several branches that have already decided a run
is unrecoverable: reconciliation budget exhausted, startup orphan, and
unreachable engine after its grace window. Each calls the orchestrator's
`markFailed`, releases the local reservation only after success, and records a
trace if that write fails.

The catch path does not schedule another exact-run reconciliation or a bounded
terminalization retry. The method then returns. Consequently a transient
failure of the final lifecycle write can preserve the durable reservation until
an unrelated trigger occurs. A pending queue drain can happen to re-arm
reconciliation, and a restart reconstructs reservations and starts it again,
but neither is an owned retry of the failed terminal write. Runtime uptime must
not be the recovery mechanism.

This is the closest confirmed answer to "one early failure follows the program
for hours": the intended terminal transition has been chosen, but its failed
commit has no owner after the catch.

Required repair:

- Extract the three terminalization branches into one helper that owns
  `markFailed -> release -> queue wake`.
- Keep the reservation while the durable terminal write is uncertain; never
  release and resubmit merely because the write request failed.
- Schedule a bounded, backoff-based retry of the terminalization write using
  the same workspace/conversation/run identity and reason.
- On terminalization-budget exhaustion, retain an explicit
  `terminalization_pending` diagnostic state, surface a safe user-visible
  failure, and keep the queue blocked rather than silently polling or
  re-admitting work.
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

- Replace text-only recovery admission with a typed error classification at
  the compatibility/SSE boundary: local transport/routing failure, explicit
  stale local bearer, upstream accepted/unknown delivery, and terminal
  upstream response.
- Remove bare `opencode_request_failed` from the generic local-runtime
  classifier unless it carries proof that the local engine or route was lost.
- Make SSE recovery use the same typed local-runtime condition, not a message
  substring.
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

- Add an outage- and workspace-scoped recovery budget: one automatic fresh
  runtime recovery until a confirmed healthy stream or explicit user action
  starts a new episode.
- After that budget is spent, retain a stable degraded/reconnecting state and
  use normal reconnect backoff; do not keep forcing fresh runtimes.
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

- Define named lifecycle deadlines by purpose: short connection-observation
  budget, run-ownership/reconciliation budget, terminalization-write budget,
  and transcript-recovery budget.
- Publish the server's authoritative terminalization-pending/exhausted state
  in the lifecycle response. The app should present that state rather than
  continue a blind independent watch.
- Bound app connection-unavailable polling to a short foreground budget, then
  transition to a stable recoverable UI state that requires an explicit
  reconnect/retry action or a confirmed server reconnection event.
- Preserve app polling for normal active runs and do not let UI exhaustion
  abort a backend run.

### REC04 — model retry becomes blocked, not terminal, after the hard no-output limit

Severity: medium

The run registry records `model_retry_no_output` and changes the run from
`running` to `blocked` after ten minutes. `blocked` remains an active lifecycle
status, so final failure/release is delegated to the server controller's
reconciliation policy.

This is safe against prematurely discarding a model retry, but it splits the
terminal decision between owners and makes the observed duration depend on how
often reconciliation happens.

Required repair:

- Decide and document one of two contracts: either the orchestrator owns a
  terminal failure at the hard no-output deadline, or it emits an explicit
  `blocked_requires_user_action` state that the server treats as terminal for
  queue ownership without falsely claiming OpenCode completed.
- Do not use the UI error styling as the terminal signal; it is only
  presentation.
- Add a deterministic fake-clock test for the full sequence from retry state
  through queue release and the next queued run.

### REC05 — manual retry ignores an abort failure

Severity: medium

The composer Retry action tries to abort the visible run and deliberately
ignores an abort exception before submitting the previous prompt again. The
server's active-run gate usually turns the new request into a durable queued
item rather than a duplicate run, which protects OpenCode. However, the UI
semantics still promise "try again" while the original ownership may be
unknown, and a queue can accumulate behind an abort that never committed.

Required repair:

- Return a typed abort result that distinguishes terminally aborted,
  already-terminal, pending reconciliation, and unknown outcome.
- When abort is unknown, present "waiting for the previous run to settle" and
  offer an explicit queue choice instead of silently treating it as a retry.
- Keep the durable queue as the only automatic serialization mechanism; never
  force a second OpenCode submission from the app.

## Implementation order

1. **REC01 first — durable terminalization retry.** It removes the only
   confirmed same-process path where a decided terminal error can lose its
   recovery owner. Add traces and diagnostics before changing timeouts.
2. **REC02 — typed recovery classification.** This prevents deterministic
   upstream failures from creating runtime recovery noise and restart churn.
3. **REC06 — bound an SSE outage recovery.** Apply the typed condition before
   adding the per-outage budget, so a deterministic upstream failure cannot
   consume it.
4. **REC03 — one published lifecycle deadline contract.** Make UI observation
   consume server authority instead of maintaining a longer independent loop.
5. **REC04 — resolve model-retry ownership.** Choose terminal semantics with
   product input, then add the full queue handoff coverage.
6. **REC05 — truthful manual retry.** Align the user action with the durable
   abort/queue state after the lower-level ownership contracts are fixed.

## Acceptance tests

### Server lifecycle

1. Force `markFailed` to fail once for each terminalization cause, then
   succeed. Assert no OpenCode submit is repeated, the same run identity is
   retried, the reservation remains until success, and the next queue item is
   released exactly once.
2. Exhaust the terminalization-write budget. Assert a visible
   terminalization-pending diagnostic, no busy polling timer leak, no queue
   release, and a restart-safe recovery record.
3. Prove startup orphan, engine-unreachable, normal long-running tool, and
   assistant output are classified separately.
4. Advance a fake clock through model retry hard limit and assert the selected
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
5. With server status unavailable, the app reaches its short observation
   terminal presentation; it never aborts or duplicates the server run.
6. Retry after an abort failure either waits for lifecycle settlement or creates
   an explicit queued item; it never claims the old run was stopped.

### Real desktop validation

Use the Tauri Pilot lifecycle surface after unit coverage is green. Simulate:

1. upstream command failure returning a structured 500;
2. engine process loss while a prompt is active;
3. lifecycle terminalization endpoint unavailable for one attempt;
4. app-to-server connection loss while the server continues reconciling.

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
