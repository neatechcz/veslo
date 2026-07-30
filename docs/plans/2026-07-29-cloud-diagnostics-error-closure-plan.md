---
title: Cloud Diagnostics Error Closure Plan
status: proposed
done: false
date: 2026-07-29
issue: unlinked
scope: evidence-led closure of cloud diagnostic findings observed on 2026-07-29
related:
  - docs/plans/2026-07-28-production-runtime-remediation-implementation-plan.md
  - docs/plans/2026-07-19-user-controlled-diagnostic-capture.md
---

# Cloud Diagnostics Error Closure Plan

## Purpose

Turn the cloud diagnostic findings from the Prague local day 2026-07-29 into
small, owner-separated changes. This is an evidence-led roadmap, not a claim
that prompt failures, transcript latency, and logging losses have one cause.

The evidence comes from the Den user-diagnostic-capture store. It does not
cover GlitchTip, hosted service logs, or arbitrary local files. Raw prompts,
credentials, URLs, filesystem paths, and upstream bodies are excluded.

## Evidence boundary

The read-only diagnostic query covered:

```text
2026-07-28T22:00:00.000Z through 2026-07-29T22:00:00.000Z
```

It contained 510 encrypted events. The relevant capture had 468 captured
events, two capture summaries, no delivery/budget drops, and ended at the
configured time limit.

## Confirmed findings

### CDE01 - Prompt submission failed below the conversation boundary

**Confidence:** production evidence observed; exact upstream class unknown.

Five `prompt_async` operations failed in roughly 32-37 ms after target
resolution, lifecycle registration, and workspace reservation had completed.
Cleanup then marked the lifecycle run failed successfully. The same capture
also shows engine reuse, healthy server checks, and successful AI access.

The outer submit route returned HTTP 200. That is not proof of a submitted
prompt: the current conversation-submit contract can return HTTP 200 with an
application result of `failed`, preserving materialization/idempotency. The
capture does not retain the safe application result for these sends.

The code already has safe failure codes and status in parts of the submit
boundary, but the cloud-visible run trace mainly has a redacted message and
error name. The missing work is a single canonical typed evidence path, not a
new API response contract.

### CDE02 - Existing submit disposition is not correlated in cloud evidence

**Confidence:** code-path confirmed and production evidence observed.

The existing result contract distinguishes `dry_run`, `materialized`,
`submitted`, `queued`, `blocked`, and `failed`; it also carries the draft
disposition. The app already handles deterministic server failures without
blind replay and releases provisional ownership.

The gap is that the existing final result is absent from the correlated cloud
evidence. Do not add a second disposition field or an `accepted` API result.

### CDE03 - Normal router output loses attributes

**Confidence:** code-path confirmed and production evidence observed.

The router owns method, raw path, status, duration, and active engine state,
but its pretty info-level output drops attributes. It does not automatically
have a propagated send correlation, a safe route family, or a safe identity
digest. Logging all attributes would risk paths and engine URLs.

### CDE04 - Cloud severity is nullable because capture receives text streams

**Confidence:** code-path confirmed and production evidence observed.

Den can store and filter nullable level values. The desktop capture path
currently forwards source, stream, and text for supervised process output, so
it cannot safely infer a level from arbitrary stdout, stderr, or message text.

### CDE05 - Transcript recovery can legitimately consume 20-34 seconds

**Confidence:** production evidence observed; dominant phase unknown.

Two transcript recoveries took about 20 and 30 seconds. The coordinator
coalesces same-target work and performs up to three host-owned canonical
transcript reads with an 8-second timeout and 0/2/8-second retry schedule.
That schedule can explain the observed duration without an HTTP or engine
write failure.

The relevant operation is SQLite discovery/open/schema validation, query,
parse, persistence, and cache invalidation. Route duration alone cannot say
which phase dominated.

### CDE06 - Durable conversation binding can outlive executable runtime session

**Confidence:** code-path confirmed; production correlation strong; exact
upstream refusal unknown.

The capture has one successful submit and five failed submits in the same
healthy workspace/engine window. The failures target three historical
conversations, with three retries against one conversation. This is
session-specific rather than workspace-wide.

Continuation obtains the OpenCode session id from a durable binding and sends
to that id without first proving it exists in the current runtime. Host-first
listing deliberately permits historical rows to open without a runtime read.
Transcript recovery can preserve/read transcript history, but it does not
create a runtime session or retarget the binding.

This explains a readable historical chat that cannot be continued after an
install or runtime-data discontinuity. It does not prove `session_not_found`
or identify the installation/data change that removed the runtime session.

## Non-findings

- No cloud HTTP 4xx/5xx access response was observed in the interval.
- No diagnostic event was dropped by the capture.
- `time_limit` was normal capture completion.
- Lifecycle `mark-failed` succeeded; it is cleanup, not the outage.
- Skills, Managed AI authorization, engine crash, updater, and server
  reachability are not supported as direct explanations of CDE01.
- A transcript-recover HTTP 200 is not proof that a chat is executable again;
  the recovery state and its non-rehydrating contract matter.

## Shared invariants

1. One canonical cloud-safe submit event family carries existing typed failure
   code, safe upstream status, physical-attempt ordinal, route, and existing
   final submit result. No parallel diagnostic/API result contract is added.
2. Never retain prompts, message parts, headers, credentials, raw URLs,
   filesystem paths, raw upstream bodies, or free-form exception text.
3. Better diagnostics never weaken engine/view admission or revision-aware
   reuse.
4. Reads, sidebar rendering, browsing, and diagnostics do not start engines,
   create sessions, or retry writes.
5. A durable history/binding is not proof that its runtime session is
   executable. A missing session is never silently replaced with an empty one
   followed by automatic prompt replay.

## Workstreams

### CDE01a - Canonical submit evidence

state: implemented
done: true

Owner: local Veslo server conversation-write boundary

#### Required implementation

1. Define one server-owned event family for a logical conversation submit.
   Reuse existing failure codes, submit status, and `draftDisposition`.
2. Emit `attempt_failed` for each physical upstream attempt and exactly one
   `final` event for the logical submit. A physical attempt includes direct,
   orchestrator fallback, or bounded transport replay.
3. Emit only this safe shape:

   ```text
   traceId
   attemptOrdinal: positive integer
   executionRoute: direct | orchestrator
   transportReplayOrdinal: 0 | 1
   failureCode: existing safe code | null
   upstreamStatus: number | null
   failureStage: upstream_response | transport | timeout | admission | unknown
   firstFailureAttemptOrdinal: number | null (final only)
   submitStatus: existing result status | null (final only)
   draftDisposition: existing disposition | null (final only)
   lifecycleStatus: admitted | submitted | failed | null (final only)
   ```

4. Preserve the first physical failure and exactly one final event under the
   same trace. Retain existing safe engine binding evidence only when it is
   already available; otherwise write `engineOwnerObserved=false`.

#### Acceptance evidence

1. Focused server tests cover upstream HTTP refusal, transport failure,
   currently reachable timeout/admission failure, orchestrator fallback, and
   bounded transport replay.
2. Tests prove physical attempts have correct ordinal/route; a logical submit
   has at most one first-failure reference and exactly one final event.
3. Tests prove sanitizer survival of safe fields and absence of sensitive or
   free-form values.
4. Invalid JSON is not a required branch unless a separate decision makes
   submit-response parsing strict.
5. Server typecheck and binary rebuild pass before runtime verification.

#### Implementation record

Implemented locally on 2026-07-29. The server emits one safe start/failure
event for every physical direct, orchestrator-fallback, or bounded transport
replay attempt, plus one final result event for the logical submit. Focused
tests cover upstream refusal, admission refusal, direct-to-orchestrator
fallback, a bounded timeout, and exactly one transport replay without
retaining upstream body or prompt text. The final event explicitly says
whether a safe engine-owner tuple was observed; an observed tuple excludes
engine URL. Production classification remains CDE01b.

### CDE01b - Classify the production failure

state: pending
done: false

Owner: diagnostics/operator, after CDE01a

1. Obtain one controlled or installed-app capture with CDE01a fields.
2. Classify the first failure from its actual typed code/status/stage.
3. Correlate engine/view evidence only when present under the same trace.
4. Create remediation only for the proven class. If unreproduced, use
   `not-reproduced` or `tracked-separately`; the original incident is not
   disproved.

#### Current evidence status

Re-examination on 2026-07-30 confirms that the available Peter capture is the
pre-CDE01a capture: it retains all five `opencode-submit` failures (31-37 ms),
but only a redacted error name/message and no typed attempt or final evidence.
It therefore cannot distinguish a missing runtime session from transport,
admission, or another upstream refusal. The next installed-app capture must
run the rebuilt server and desktop sidecars before this workstream changes
state.

### CDE02 - Close out existing result-contract observability

state: implemented
done: true

Owner: server conversation contract and app presentation audit

1. Audit the existing result and `draftDisposition` contract after
   materialization; it remains authoritative.
2. Make CDE01a final evidence carry that existing result. Do not change HTTP
   status or add a new disposition field by default.
3. Prove the app clears provisional/busy ownership and does not replay a
   deterministic `failed` or `blocked` server result.

#### Acceptance evidence

1. Focused server/app test covers materialization followed by failed submit
   and asserts response result, draft disposition, lifecycle, and UI agree.
2. Cloud evidence has the CDE01a final event for the same trace.

#### Implementation record

Implemented locally on 2026-07-29. CDE01a's sole final event carries the
existing `submitStatus` and `draftDisposition`; no HTTP or application result
contract was added. Focused app tests cover a materialized first session whose
server submit fails, deterministic failed-result handling, busy/provisional
cleanup, and no blind replay. Installed-app capture is deferred production
verification of the same existing fields.

### CDE03 - Safe router correlation

state: implemented
done: true

Owner: orchestrator diagnostics boundary

1. Explicitly propagate any correlation id the router needs.
2. Convert raw paths to an allowlisted route family and use safe identity
   digests for workspace/engine fields.
3. Emit a bounded safe summary only where the active output format loses
   info-level attributes.
4. Do not change routing, admission, retries, or lifecycle to add logging.

#### Acceptance evidence

1. Focused router/logger test proves plain capture remains correlatable.
2. Test proves raw path, engine URL, request body, authorization, and
   free-form error text are absent.

#### Implementation record

Implemented locally on 2026-07-29. Router output now has a bounded route
family, validated send-trace correlation, and a short workspace identity
digest in its message as well as structured attributes. Focused tests reject
unsafe correlation input and prove the raw route and identity are absent.

### CDE04 - Structured severity transport

state: implemented
done: true

Owner: desktop diagnostic forwarder and Den ingest contract

1. Define a structured severity envelope for known logger events and preserve
   `info`, `warn`, or `error` through supervision, desktop forwarding, and
   capture ingestion.
2. Keep arbitrary stdout/stderr and unknown records at null severity. Never
   infer severity from a stream or free-form text.

#### Acceptance evidence

1. Native/Den boundary tests store and filter each known severity.
2. A redacted send failure is queryable as `error`; legacy null-level events
   remain readable.

#### Implementation record

Implemented locally on 2026-07-29. Desktop-owned sidecars use structured JSON
logging and the native capture forwarder preserves only valid structured
`info`, `warn`, and `error` values. Unknown text and stdout/stderr stream
identity remain null-level. Server-owned send-flow records use the same
structured envelope in JSON-log mode, so an evidence attempt failure is
captured as `error` rather than inferred from text. Native and focused server
tests cover known levels, null fallback, failure severity, and capture-queue
serialization. Queryability in the deployed Den store is deferred production
verification, not a new ingest contract.

### CDE05 - Coordinator-level transcript recovery timing

state: implemented
done: true

Owner: server conversation-read boundary

1. Add a safe timing ladder inside the transcript recovery coordinator:

   ```text
   trigger -> flight new/join -> retry delay -> SQLite discovery/open/schema
   validation -> query -> JSON parse/normalize -> persistence/cache -> outcome
   ```

2. Retain only duration, phase, retry ordinal, new/join ownership, safe
   identity, and final recovery state.
3. Do not change retry policy or performance until a capture attributes the
   delay to one phase.

#### Acceptance evidence

1. Focused tests cover slow read, joined flight, cache outcome, and bounded
   retry timing.
2. Tests prove no read-triggered engine start or duplicate same-target work.

#### Implementation record

Implemented locally on 2026-07-29. The existing coordinator now records
new/join ownership, retry delay, whole-read outcome, SQLite open/query/JSON
normalize phases, persistence/cache result, and final settlement with only
durations and safe identity. Retry policy and read-only engine behavior were
not changed. Focused coordinator and read-store tests cover the bounded ladder
and coalesced work.

### CDE06a - Classify historical-session continuation

state: pending-production-classification
done: false

Owner: local Veslo server conversation-write boundary, after CDE01a

1. Use CDE01a evidence to determine whether affected continuation is a
   missing-session/refusal, transport, admission, or another failure class.
2. Add a focused server test with durable binding to a session absent from the
   serving runtime. Prove its safe error and final result.
3. Prove readable durable transcript does not make that write executable and
   no list/read path starts an engine.
4. Mark `disproved` only if classified evidence proves the binding remains live
   and another mechanism caused failure. Otherwise use `not-reproduced` or
   `tracked-separately` where appropriate.

#### Local evidence added

A focused server regression test now proves the missing-session-equivalent
case: a durable binding directed to an absent upstream session returns the
existing typed failed result, restores the draft, does not materialize a new
session, and preserves no raw upstream body in submit evidence. This does not
classify the observed installed-app incident; that still requires CDE01b.

### CDE06b - Continuation contract for missing runtime session

state: conditional-pending-production-classification
done: false

Owner: product/runtime conversation ownership, only if CDE06a confirms a
missing-session-equivalent class

1. Decide between a precise non-continuable/recoverable UI result and a
   server-owned rehydration/migration contract.
2. For the first option, use the existing failed-result shape with a typed
   code; no automatic replay, synthetic success, or stuck busy/provisional
   state.
3. For rehydration, specify a supported OpenCode restore primitive, binding
   transition, idempotency, and context fidelity before implementation.
   Creating an unrelated empty session is not rehydration.
4. Preserve host-first list/read behavior and strict engine/view admission.

#### Acceptance evidence

1. Focused write-path test contrasts missing and existing runtime session.
2. Test proves one client message id, no blind replay, and no duplicate prompt.
3. Focused app test proves cleanup even if user changes selected chat before
   the result returns.
4. Installed-app validation is deferred production verification; it does not
   substitute for focused tests or binary rebuild.

### CDE07 - Terminal OpenCode state is not always visibly projected

state: local-reproduction-pending
done: false

Owner: desktop transcript/event projection and orchestrator run reconciliation

#### Reported symptom

During a live conversation the UI can omit one or more OpenCode tool steps,
and in some cases a terminal run does not show the assistant response. The
visible result can remain in the equivalent of an answering/running state even
after later work in the same conversation succeeds.

This is not yet evidence that OpenCode failed to execute the tool or produce
the response. It is a delivery/projection incident until one correlated run
shows which of these boundaries lost the data:

```text
OpenCode event -> routed event stream -> app transcript store -> message-list projection
OpenCode terminal state -> run-activity probe -> app run-state settlement
```

#### Known adjacent evidence

The run-activity probe already classifies a terminal assistant message with no
user-visible parts as `assistant_completed_without_visible_output`. That is a
useful diagnostic terminal error, but it does not identify whether the
assistant parts were never produced, were lost in routing, were rejected by
the app's known-session guard, or were present in the transcript store and
not rendered. The sidebar-skill reproduction is a separate UI cache
invalidation defect and must not be used to explain this incident.

An owned cold desktop run on 2026-07-30 found a prior state that must be
classified separately: the Composer accepted the prompt while the local server
and orchestrator still reported unavailable/not-ready. The app held an active
send trace but did not publish a visible run indicator within 15 seconds. No
tool or assistant projection can be expected until a run is actually admitted.
This is evidence of missing foreground readiness/visible pending feedback, not
evidence that an already admitted OpenCode event was lost.

#### Required diagnostic slice

1. Add one correlated, redacted delivery ladder for an admitted run:
   expected user message, routed message/part event counts by part type,
   ignored-event reason/count, transcript-store message/part counts, visible
   assistant-output classification, and final run status/error.
2. Use only stable ids/digests, counts, enums, and lengths. Never capture
   prompt text, tool input/output, paths, URLs, or raw event bodies.
3. Make the desktop live scenario observe both a tool-producing run and a
   terminal assistant response. Its artifact must state separately whether
   tool rows and assistant output were visible; a run indicator disappearing
   is not sufficient proof.
4. Reproduce before changing event-stream, transcript, grouping, or run
   reconciliation behavior. The first code fix belongs solely to the proven
   loss boundary.
5. Classify no-indicator submissions before this ladder as
   `pre-execution-unavailable` rather than `stored-not-rendered`.

#### Diagnostic implementation record

The desktop diagnostic trace now records a content-free UI delivery ladder:
accepted and ignored SSE message/part events, each committed part's type and
store-change decision, transcript-store write ownership, and canonical/visible
projection boundaries with assistant message/part counts and text lengths.
The live scenario artifact reduces those records to counters and terminal
classifications only. The server's bounded canonical-transcript ingest trace
also carries its trigger and terminal run id across each read, retry,
persistence, and settle phase. This is diagnostic instrumentation only; it
does not alter event routing, durable transcript ownership, or rendering.

#### Acceptance evidence

1. A focused unit test proves every new ladder result is redacted and keeps
   distinct `not-produced`, `not-routed`, `ignored`, `stored-not-rendered`,
   and `rendered` outcomes where the evidence supports them.
2. A real desktop run records the ladder for a tool-producing conversation.
3. If `assistant_completed_without_visible_output` occurs, its artifact shows
   the last known boundary for that exact admitted run rather than treating
   it as a generic model failure.

## Sequencing

```text
CDE01a -> CDE01b
CDE01a -> CDE02
CDE01a -> CDE06a -> CDE06b (conditional)
CDE03, CDE04, and CDE05 are independent diagnostics work.
```

CDE01a is the first implementation slice. CDE01b then decides whether CDE06
needs behavior change. CDE02 is an audit/observability close-out, not a new
response design. CDE03-CDE05 must not delay a proven send remediation.

## Verification policy

- Every source workstream runs focused tests and its owning typecheck.
- Changes under the local server rebuild the server binary before any runtime
  check relies on it.
- A normal source-code handoff runs the applicable full quality gate, including
  `pnpm check`, and updates durable documentation when behavior changes.
- Desktop E2E is explicitly deferred for this plan. The selected behavior is
  verified later in an installed application; that production check is not
  evidence for completion of an untested source slice.

## Completion gate

The document remains `done: false` until every workstream has a final state:
`implemented`, `production-verified`, `not-reproduced`, `disproved`,
`externally-blocked`, `superseded`, or `tracked-separately`.

The original capture is accounted for as five submit failures, two slow
recoveries, a durable-binding/current-runtime-session hypothesis, and defined
diagnostic attribution gaps. No other cloud error response was observed in
the examined local-day interval.
