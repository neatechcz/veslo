---
title: Managed-AI Send and Lifecycle Runtime Latency Remediation Plan
date: 2026-07-20
status: in_progress
done: false
base_branch: main
implementation_checkpoint:
  - 2026-07-20: Phase 1 KISS guarded-reload send gate implemented and covered by focused app tests; Phase 0 and later evidence-gated phases remain pending.
source_evidence:
  - .tmp/send-workflow-trace.ui.ndjson
  - .tmp/send-workflow-trace.server.ndjson
  - .tmp/send-workflow-trace.orchestrator.ndjson
target_area:
  - packages/app/src/app/context/managed-ai-runtime-config.ts
  - packages/app/src/app/context/conversation-service.ts
  - packages/app/src/app/context/session-lifecycle-recovery.ts
  - packages/app/src/app/context/send-runtime-readiness.ts
  - packages/app/src/app/lib/veslo-server/transport.ts
  - packages/app/src/app/lib/veslo-server/request-broker.ts
  - packages/server/src/routes/conversations.ts
  - packages/server/src/routes/workspace-management.ts
  - packages/server/src/request-headers.ts
  - packages/server/src/conversation-run-lifecycle-controller.ts
  - packages/server/src/conversation-transcript-ingest-coordinator.ts
  - packages/server/src/conversation-transcript-store.ts
  - packages/orchestrator/src/run-activity-probe.ts
---

# Managed-AI Send and Lifecycle Runtime Latency Remediation Plan

## Goal

Make a managed-AI send correct, attributable, and predictably fast across its
whole path:

```text
app preflight
  -> Veslo Server durable admission / queue
  -> OpenCode prompt dispatch
  -> AI Gateway provider request
  -> terminal lifecycle and canonical transcript delivery
```

The server remains authoritative for configuration freshness, run admission,
queueing, terminal transcript ingest, and lifecycle reconciliation. The app
must not gain a second run-state or transcript-persistence owner in an attempt
to hide latency.

## Product priority

1. The client must not lose a submitted answer: durable server admission,
   lifecycle recovery, and exact ownership remain non-negotiable.
2. The normal send path must reach durable admission and provider dispatch with
   the fewest justified round trips. An unchanged, already-applied managed
   configuration must not pay for reload, transcript recovery, or a second
   engine bootstrap.
3. Transcript repair and diagnostic work are best-effort side paths. They must
   never hold an unrelated submit in the renderer or delay a queued successor
   without a measured, bounded server-side reason.

The immediate optimisation target is therefore time from Send click to durable
admission/provider dispatch—not cosmetic terminal hydration latency. A correct
answer that arrives through stream/lifecycle recovery is preferable to a fast
UI transition that can lose the answer.

## Status and scope

Proposed. This document is based on the two-send local desktop trace captured
on 2026-07-20. The durations are confirmed for that trace; causes are marked as
confirmed only where code and trace establish them. No implementation or release
claim is made here.

This plan deliberately combines configuration correctness with lifecycle
latency because the second prompt was delayed by both an unchanged config
preflight and a concurrent terminal transcript path. They need one correlated
trace, but retain separate owners and acceptance criteria.

## Evidence

### First, cold send

| UTC interval | Observed phase | Duration | Interpretation |
| --- | --- | ---: | --- |
| 13:25:38.930 -> 13:25:42.822 | native runtime start | 3.892 s | cold runtime work begins after Send click |
| 13:25:38.338 -> 13:25:44.712 | click -> submit accepted | 6.374 s | includes cold runtime, materialization, config/auth, and submit |
| 13:25:44.658 -> 13:26:00.742 | OpenCode `prompt_async` accepted -> Gateway provider hit | 16.084 s | uninstrumented local OpenCode / handoff interval |
| 13:26:00.742 -> 13:26:07.143 | provider hit -> upstream headers | 6.401 s | actual Gateway/upstream TTFB |
| 13:26:08.208 -> 13:26:08.263 | lifecycle terminal -> server ingest trace | 55 ms | server terminal ingest completed promptly |

The first lifecycle probe already reports `running` and
`assistant_message_open` during the 16.084-second pre-provider interval. That
status proves only that an assistant message is open; it does not explain
whether OpenCode is waiting on a lock, config/provider resolution, context
construction, skills/MCP, or dispatch.

### Second send during first terminal delivery

| UTC interval | Observed phase | Duration | Result |
| --- | --- | ---: | --- |
| 13:26:12.202 -> 13:26:22.551 | click -> submit accepted | 10.349 s | server did not receive prompt promptly |
| 13:26:12.365 -> 13:26:21.774 | managed config send-preflight | 9.409 s | unchanged `managed-config-current` |
| 13:26:15.169 -> 13:26:21.878 | app terminal transcript projection | 6.709 s | loaded |
| 13:26:21.776 -> 13:26:21.787 | matching server projection handler | 11 ms | cold SQLite source |
| 13:26:22.285 -> 13:26:22.551 | actual submit request | 266 ms | submitted |
| 13:26:22.495 -> 13:26:22.671 | OpenCode accepted -> provider hit | 176 ms | warm handoff |

The second prompt was held before durable server admission, not in the
server-owned conversation queue and not by model inference. The config read and
terminal transcript path overlap, but current tracing does not identify whether
the wait occurred in app scheduling, request broker, Tauri HTTP/IPC, or another
local transport boundary.

### Active lifecycle probe pressure

The first run produced 20 server lifecycle reconciliations. One reconciliation
calls the orchestrator lifecycle status endpoint; while OpenCode is busy, its
activity probe issues `GET /session/status` and then
`GET /session/:id/message`. This can create about 40 OpenCode reads during one
response.

The warm follow-up reaches Gateway in 176 ms while the same policy is active,
so polling is not proven to cause the 16.084-second gap. It is nevertheless
avoidable contention and scales with response duration.

## Required invariants

- A config-changing managed-AI send never submits against an older loaded engine
  configuration.
- A server-owned queue receives a valid ordinary prompt as soon as its required
  freshness contract is satisfied; unrelated terminal recovery cannot silently
  hold it in the renderer.
- Exact `{ workspaceId, conversationId, runId }` ownership is preserved through
  terminal hydration. An older terminal run may not overwrite a newer run.
- A missed SSE event remains recoverable through bounded polling/recovery.
- Transcript recovery, ordinary transcript reads, and lifecycle polling never
  sit on the critical path between an otherwise ready Send and durable server
  admission.
- Timing traces contain no prompt text, transcript text, config body, bearer
  credential, token, or authorization header.
- No broad transport rewrite or client-only freshness TTL is allowed before the
  measured cause supports it.

## Delivery order

Only Phase 0 and Phase 1 are approved implementation work from this plan.
They produce the missing attribution and fix an independently demonstrated
correctness bug. Phase 2 through Phase 4 have precise contracts below, but
remain evidence-gated: do not change their runtime behaviour until the Phase 0
trace establishes that the relevant wait or pressure is material. The existing
workspace warm-up is a separate diagnostic follow-up, not a release gate.

After Phase 0, take the smallest fix for the measured click-to-admission
bottleneck before implementing Phase 2 or Phase 4. The current leading
candidate is the 9.409-second unchanged-config preflight/transport interval;
the 16.084-second OpenCode handoff is a separate measurement target. Do not
turn a transcript correctness improvement into a prerequisite for a faster
ordinary send.

## Phase 0 — correlate the critical path

Add bounded diagnostic timing before changing latency behavior.

### App transport and broker

For only these request classes, emit a non-secret correlation ID and existing
send trace ID where available:

- workspace config GET used by send preflight;
- transcript recover POST;
- terminal transcript GET;
- conversation submit POST.

Record `scheduledAt`, request-broker owner/join outcome, `fetchCalledAt`,
response headers, body completion, error class, and total duration. The broker
must distinguish a coalesced GET from an owner request; otherwise a joined slow
request looks like an unrelated transport stall. Its conclusion is deliberately
narrow: the broker shares only an identical shareable GET (URL, headers and
timeout). It does not serialize a config GET, transcript GET, and recovery or
submit POST, so it is not a generic explanation for their ordering.

Use `X-Veslo-Request-Id` as the exact per-request header. The app transport
attaches it; Veslo Server parses and traces it; and the server CORS
`Access-Control-Allow-Headers` allowlist includes it for the WebView loopback
fetch fallback. It is an opaque UUID with no prompt, user, credential, or
workspace-path data.

### Server and recovery timing

Carry the correlation ID and record server receipt, handler completion, and
response completion for those endpoints. Instrument transcript recovery around:

1. exact lifecycle status validation;
2. transcript ingest coordinator request;
3. outcome and generation.

The resulting trace must classify latency as:

```text
before fetchCalledAt                 app scheduling / identical-GET broker join
after fetchCalledAt, before server receipt  renderer / Tauri HTTP / IPC
inside server handler                endpoint / filesystem / OpenCode read
after server completion              response transport / body handling
```

### OpenCode handoff timing

Instrument the owner of `prompt_async` from accepted request to first outbound
provider request, separating where available:

- session or request lock wait;
- managed provider/config resolution;
- context/message construction;
- skill, agent, or MCP initialization;
- provider dispatch.

Run one cold and one warm send with this correlation. Do not assign the 16.084
seconds to lifecycle or the model before this evidence exists.

## Phase 1 — restore config-changing send correctness

### Defect

`syncVesloServerConfig()` can PATCH changed managed config, leave a deferred
`ifIdle` reload pending, and still return `verified`. Conversation service then
auth-primes and submits, so a run can start against the earlier loaded config.
`verified-reload-required` exists as an outcome and caller branch but is not
currently produced by this path.

### Typed outcome and required sequence

Replace the ambiguous boolean result from `syncVesloServerConfig()` with one
typed result at the app boundary:

```ts
type VesloServerConfigSyncResult =
  | { kind: "unchanged" }
  | { kind: "patched" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };
```

Map this internal result deliberately to the existing public send-preflight
outcomes (`verified`, `verified-reload-required`, `cancelled`, or `failed`);
do not overload `verified` to conceal a patch that has not yet reloaded.

A new `patched` result enters the synchronous, server-owned
`reloadEngine({ ifIdle: true })` step. A send whose config comparison is
`unchanged` but whose workspace has a matching pending reload must also join
that guarded reload; only `unchanged` with no pending revision may continue as
verified. `cancelled` and `failed` stop the send. Re-check cancellation/current
intent after every awaited PATCH and reload, immediately before authorization
prime and submit.

Do not make the renderer-local `pendingServerReloads` map the source of truth:
the requirement survives renderer restart and a second client. Veslo Server
must durably record, or deterministically derive, a `reloadRequiredRevision`
for a managed config write while an engine can still be loaded. Send preflight
reads that server-owned state. Store the desired fingerprint/revision with the
pending reload entry as a client optimisation only. The guarded reload
acknowledgement clears only that same server revision; a newer PATCH stays
pending. An `ifIdle` conflict is not a successful sync: preserve the pending
revision, return `verified-reload-required`, and do not issue either runtime
authorization prime or conversation submit.

```text
config PATCH
  -> server-owned reload(ifIdle) acknowledgement
  -> runtime authorization prime
  -> conversation submit
```

Do not replace the server-side atomic reload-versus-admission contract with an
app-side active-run check.

### Owners and tests

Owners:

- `managed-ai-runtime-config.ts`;
- `conversation-service.ts`;
- existing guarded reload route in `workspace-management.ts`.

Targeted tests:

- changed + idle: `get -> patch -> reload(ifIdle) -> auth -> submit` in order;
- changed + reload conflict: no auth/no submit, pending reload retained,
  `verified-reload-required` returned;
- prior changed + reload conflict, then unchanged retry: retry joins the same
  guarded reload and submits only after its success;
- renderer restart after a blocked reload: server-owned pending revision still
  blocks submit until guarded reload succeeds;
- cancellation during PATCH or guarded reload: no auth/no submit;
- unchanged: no PATCH/reload;
- resolved `serverWorkspaceId` stays stable through every operation;
- production owner, not only a mock, produces `verified-reload-required`.

## Phase 2 — exact-run terminal projection (evidence-gated after Phase 0)

When exact lifecycle recovery sees a terminal run, the normal app path calls
`POST /transcript/recover` and then a transcript GET. Meanwhile server lifecycle
reconciliation already performs terminal ingest for the same canonical identity.
The trace shows that server ingest succeeds 55 ms after terminal status, while
the client waits 6.626 s before issuing its GET.

### Server contract before an app-flow change

`latestRunArtifacts.anchorMessageId` is explicitly a transcript anchor, not a
lifecycle `runId`; a normal transcript GET therefore cannot prove that it is
reading terminal run A rather than a later run B. Do not implement a generic
GET-first optimisation.

Extend the server-owned SQLite `conversation-transcript-store` with a durable
terminal-ingest receipt keyed by canonical `{ workspaceId, directory,
engineSessionId, conversationId, runId }`. The lifecycle controller passes the
terminal lifecycle status into the ingest coordinator. A receipt is valid only
for `completed`, `failed`, or `aborted`; a client-supplied `expectedRunId` that
is merely current/running cannot request or create one.

The present coordinator single-flights only by transcript identity and carries
one generic task. It must not silently attach a joined run B (or recovery) to
run A's receipt. Extend it with per-run terminal evidence, or add a small
terminal-capture owner beside it, so each terminal run retains its own
`{ conversationId, runId, terminalStatus }` through persistence. After the
associated canonical snapshot is persisted, write that run's receipt in the
same transcript-store write/transaction boundary with:

```ts
{ runId, terminalStatus, watermark }
```

The server must establish that the captured snapshot belongs to that terminal
run—either by a bounded terminal capture before a successor is admitted or by
an equivalent server-side run boundary. If B may already have changed the
source and no such proof exists, write no receipt for A; return `missing` or
`mismatch`, never a plausible but misattributed receipt.

Terminal capture may not become an unbounded queue barrier. Prefer a
run-bound/immutable server projection; if a pre-successor capture is the only
safe option, define and trace its strict server-side time budget before
implementation. On budget exhaustion, release the successor and return no
receipt for A rather than making the next user prompt wait behind recovery.

`watermark` is opaque and derived from the canonical persisted projection; it
is not an anchor message ID or client-supplied value. Add an authenticated
exact-run read endpoint, scoped by the same canonical identity and
`expectedRunId`, which atomically reads receipt and canonical projection and
returns exactly one of:

```ts
{ state: "ready", runId, terminalStatus, watermark, transcript }
{ state: "missing" }
{ state: "mismatch", runId, terminalStatus, watermark }
```

`ready` is permitted only when the receipt run id equals `expectedRunId` and
the canonical projection still has that receipt's watermark. If a newer run has
replaced the projection, return `mismatch`, never a transcript for the wrong
run. Persist receipts per run rather than inferring them from the latest
projection, so an older run cannot be mistaken for a newer one.

Only after this server contract exists may the app use it: on an exact terminal
lifecycle status, make one bounded exact-run read. `mismatch` is terminal for
that recovery attempt: do not POST generic recovery and do not hydrate or clear
the presentation of the newer run. It means the current canonical projection
cannot prove A, and a generic current-transcript read could be B.

`missing` may request one bounded server retry only while the server confirms
the expected run is terminal and no later projection has superseded it. That
retry requests terminal capture; it does not turn an arbitrary current
transcript read into a receipt for A. It returns `ready`, `missing`, or
`mismatch` under the same exact-run contract. Preserve the existing bounded
retry and `transcript-unavailable` presentation for genuine OpenCode persistence
lag. The app applies `ready` only while its existing exact-run presentation
owner still owns A, so late A completion cannot overwrite B.

Tests:

- delayed ingest concurrent with exact read: `missing`, no incorrect hydrate;
- receipt and canonical snapshot commit: exact `ready` for the expected run;
- later run B: exact read for A is `mismatch`, never B's transcript;
- mismatch: no recovery POST, no A hydration, and B presentation remains owned
  by B;
- active `expectedRunId`: recovery is rejected/not-ready and creates no receipt;
- two terminal runs sharing one transcript identity retain distinct receipt
  evidence; a joined coordinator task cannot write B's watermark as A;
- server-ingested exact projection: no recovery POST;
- missing exact projection without supersession: one server capture retry then
  successful exact projection;
- incomplete/exhausted recovery: one bounded retry and visible unavailable
  state, never fabricated completed transcript;
- run A cannot hydrate over B;
- traces contain correlation/outcome only, never transcript content.

## Phase 3 — make unchanged freshness cheap after attribution (evidence-gated)

Phase 0 determines which remediation is justified.

- **App scheduling or identical-GET coalescing:** fix the measured blocking
  owner while retaining cancellation and one overall send deadline. Do not
  attribute ordering between distinct request classes to the request broker.
- **Tauri HTTP/IPC delay:** test a narrowly scoped ordinary WebView loopback
  fetch for Veslo Server JSON calls, keeping Tauri HTTP as compatibility
  fallback. Do not change the Rust SSE proxy.
- **Server config endpoint delay:** remove unrelated Veslo config/audit work.
  If a smaller response is justified, add a separate managed-projection
  no-write endpoint; do not shrink the generic config read that is needed for
  a preservation-safe merge/PATCH.

Then introduce a server-owned managed-config revision/ETag with this contract:

- every conditional GET still reaches Veslo Server and reads the current
  OpenCode config, so a direct external file edit/deletion is detected before a
  `304`; conditional GET is not a cure for renderer/Tauri transport queueing;
- derive the revision only from the canonical, managed OpenCode projection used
  for preflight, not Veslo config, audit rows, or today's audit-derived
  `updatedAt`;
- return an opaque, secret-free server-keyed digest (HMAC over the canonical
  managed projection). Never return or log its raw config body or the revision
  input;
- same managed projection returns `304`; changed or missing projection returns
  a validated managed projection and follows Phase 1 reload rules; any path
  that will write performs the fresh full read defined below;
- preserve the `X-Veslo-Request-Id` parsing and CORS contract from Phase 0 on
  both `200` and `304` responses.

Do not make a managed-only `304` authorize a write built from a stale full
`opencode` object. The existing formatter merges managed fields into that full
object. A preflight which can PATCH must therefore force a fresh full config
read immediately before its merge/write (or patch only a server-owned managed
subdocument with equivalent preservation semantics). Conditional managed
projection reads are only a no-write fast path backed by a previously validated
full snapshot.

Unify `hasUsableManagedAiRuntimeConfigForSend()` and sync preflight behind one
bounded, abortable read policy using the existing transient-error classification.
Retries share one send deadline and must never silently extend the user's wait.

Tests:

- unchanged current revision admits without PATCH/reload;
- changed revision follows Phase 1;
- external unmanaged config edit followed by a managed PATCH: force a fresh
  full read and preserve that unmanaged edit;
- delayed preflight is diagnosed as pre-admission, not model execution;
- server queue receives a second valid prompt immediately after required
  freshness confirmation.

## Phase 4 — reduce healthy-run probe pressure without changing authority
(evidence-gated)

After Phase 0 quantifies the activity probe cost:

The server's orchestrator lifecycle status remains the only authority for
queue drain, terminalization, and stale-run recovery. Rust-proxied SSE is an
app UI progress signal only: it may make the composer look responsive, but
neither client event receipt nor client event loss may choose a queue drain or
terminal state.

1. Keep immediate/exact server reconciliation for admission, abort,
   provider-start timeout, terminal uncertainty, and stale-run handling.
2. Start an active server run at the existing 1-second fast interval. After
   three consecutive server observations with no lifecycle/progress change,
   back off server-owned polling through 2 seconds to a hard maximum of 5
   seconds.
3. Return immediately to the 1-second interval after any server-observed
   lifecycle status, activity/progress timestamp, wait reason, error, abort,
   provider-watch timeout, queue-drain, or reconcile-error change. Client SSE
   never controls this decision.
4. Keep per-run, server-owned probe cadence state: last full message probe,
   last progress signature, and consecutive unchanged **full** observations.
   `/session/status: busy` alone is not progress evidence and cannot be used to
   refresh stale/no-progress time. A status-only observation is permitted only
   after the healthy full-observation threshold; force a full
   `/session/:id/message` read at least every 5 seconds and immediately for
   retry, status change, stale suspicion, or any error. This preserves terminal
   detection when OpenCode temporarily reports stale `busy`.
5. Keep bounded server fallback polling for missed engine events and queue
   successor wake-up.

Use deterministic server fake-timer tests for the 5-second maximum, fast
re-entry, completion after a status-only `busy` probe, abort, stale status, and
queued-successor drain. Do not reduce polling by weakening these recovery
guarantees.

## Separate follow-up — diagnose the existing workspace warm-up

Do not add a second warm-up owner. `workspace.ts` already schedules
`ensureEngineForWorkspace(..., { reason: "boot-warmup" })` for the active local
workspace; send readiness already joins that same single-flight bootstrap using
`runtime-bootstrap-join` when its client is absent.

First trace the existing path for each affected activation scenario: whether it
was eligible and scheduled, began, succeeded/failed/cancelled, published a
routed client, or was still in flight when Send joined it. Only a demonstrated
coverage gap may produce a separately scoped product decision about when to
start the existing warm-up. That work does not block the correctness fix,
transport attribution, or release of Phase 0 and Phase 1.

If such a follow-up is approved, retain the existing tests for one engine start
per selection/send join, inactive workspace exclusion, failure recovery, and
cross-workspace isolation.

## Acceptance criteria

- A changed managed config cannot submit before successful guarded reload.
- A guarded reload conflict submits nothing and yields
  `verified-reload-required`.
- A retry with an unchanged comparison but a known pending config revision also
  cannot submit before that revision's guarded reload succeeds.
- An unchanged config with no pending revision reaches authorization/submit
  without waiting for reload, transcript recovery, or terminal capture.
- An exact terminal projection for run A can never be manufactured from run B:
  `mismatch` performs no generic recovery or hydration, and a receipt exists
  only for proven terminal run evidence.
- One captured trace attributes slow config/recovery time to app scheduling,
  identical-GET broker coalescing, desktop transport, server handler, or
  upstream OpenCode read.
- The `prompt_async -> provider-hit` gap has stage-level evidence.
- The first performance change after Phase 0 reduces the measured
  click-to-admission bottleneck and does not add a transcript/queue barrier to
  the normal send path.
- Phase 2, Phase 3, and Phase 4 are implemented only when that trace supports
  their priority; Phase 2 must first meet its exact-run receipt contract and
  Phase 4 must retain server-owned lifecycle authority.
- Targeted Phase 0/1 tests, one focused manual two-send trace review, and
  `git diff --check` pass.
