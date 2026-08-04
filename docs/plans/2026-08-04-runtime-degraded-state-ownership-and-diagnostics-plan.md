---
title: Runtime Degraded-State Ownership and Diagnostics Plan
date: 2026-08-04
status: proposed
done: false
scope: one owner for the user-visible runtime connection state, a finite reason vocabulary instead of raw error text, and content-free diagnostics for the states that today are only observable in a third-party log
related:
  - docs/plans/2026-08-04-production-feedback-continuation-kiss-remediation-plan.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/feedback-diagnostics.md
  - docs/dev/veslo-application-logs.md
---

# Runtime Degraded-State Ownership and Diagnostics Plan

## Executive verdict

A production session on 2026-08-04 showed a persistent “Runtime je degradovaný”
banner whose visible detail was a raw OpenCode error envelope. Investigating it
required reading a third-party log, because the failure was recorded nowhere in
Veslo. Three separable defects produced that experience, and only the first one
has been fixed so far.

1. **An identity from one namespace was sent to another.** SSE reconnect
   catch-up derives session ids from the `sessionStatus` store keys, which are
   owned by whatever wrote the row — including Veslo conversation ids and
   pending-draft keys. Those ids were forwarded to OpenCode, which rejects
   anything not prefixed `ses`. **Already repaired** at the outgoing boundary:
   a non-OpenCode id is now skipped and traced instead of being dispatched and
   counted as a catch-up failure. The remaining question is which writer put a
   conversation id into that store; the guard prevents the damage but does not
   remove the source.
2. **No owner decides what the user is told, or when it stops.** Five separate
   call sites emit `degraded` with their own prose, and the recovery episode
   that gates re-attempts is cleared on only two narrow paths. A degraded state
   can therefore outlive the condition that caused it.
3. **The decisive evidence is not recorded.** The banner renders a free-form
   `lastError` string, while the corresponding runtime-recovery events are
   written through a debug-gated perf log that is off in normal use. The user
   sees an error reference that exists in no Veslo artifact.

This plan gives the connection state one owner, replaces free-form error text
with a finite reason set, and records those transitions content-free. It does
not introduce a new runtime controller, a second reconnect mechanism, or any
change to engine lifecycle authority.

## Evidence

From the 2026-08-04 desktop session (local trace mirrors plus the engine log):

| Time (UTC) | Observation |
| --- | --- |
| 16:10:40–16:10:41 | Engine for the workspace starts; `event connected`. |
| 16:10:42.348 | Orchestrator proxies `GET /session/conv-…` to the engine. |
| 16:10:42.471 | Engine logs `ERROR ref=err_112acf0f`, `Expected a string starting with "ses"`. |
| 16:10:43.425 | App records `session-sse:reconnect-no-cursor-fence`. |
| shortly after | UI shows `data-reconnect-status="degraded"` with the raw engine error envelope as its detail. |

Supporting negative evidence:

- The error reference appears in **no** Veslo artifact: not in the three
  `send-workflow-trace.*.ndjson` mirrors, and not in the ~27 MB runtime trace.
- No `catchup-*-failed` event was present in the UI trace for that window, so
  the failure path that degraded the runtime left no first-party record.
- Predecessor classification in the same session was healthy
  (`active_exact_owner`, and `ready` with a proven-lost owner). This incident is
  independent of the terminal-handoff work.

## Current-code audit

### A. The connection state has emitters, not an owner

`ReconnectState` carries `status`, `lastError`, and `messagesMayBeDelayed`.
`degraded` is emitted from five distinct places in the event-stream module:
catch-up incompleteness, recovery-budget exhaustion, recovery returning
not-recovered, recovery throwing, and the terminal stream-failure branch. Each
supplies its own message text. Nothing arbitrates between them, and nothing
owns the transition back to `live`.

### B. The reason vocabulary is unbounded prose

`lastError` is a truncated error string that is rendered directly to the user.
That is why an OpenCode envelope with an internal reference id reached the
banner. A raw upstream message is simultaneously too much detail for a user and
too little signal for support, because it is not classified and not counted.

### C. Recovery episodes can outlive their cause

The per-workspace recovery episode is set when a fresh runtime recovery is
attempted and deleted on only two success paths. Once
`attemptedFreshRuntimeRecovery` is set, a later outage on the same key short
circuits to `degraded` with “Runtime recovery already attempted for this
outage.” If neither clearing path is reached, the workspace stays in that
posture until the stream is torn down.

### D. The observability is debug-gated

Runtime-route recovery start, result, and budget exhaustion are written through
a perf log guarded by a session-debug flag. In a normal user session those
events do not exist, which is precisely the session in which a support question
is later asked.

## Required invariants

1. Exactly one owner decides the user-visible connection status; emitters
   report observations to it and never write the status directly.
2. The user-visible reason is drawn from a finite, enumerated set. Raw upstream
   error text is never rendered to the user.
3. Every degraded state has a defined clearing condition. No state may persist
   because its clearing path was never reached.
4. An identity is only sent to a runtime that owns that namespace. A namespace
   mismatch is a local defect, never a runtime outage.
5. Every status transition is recorded content-free: status, finite reason,
   workspace scope, and attempt counters — no prompt text, transcript text,
   file names, paths, tokens, or upstream error bodies.
6. Diagnostics for these transitions are always recorded, not gated behind a
   debug flag.
7. This plan changes presentation and diagnostics only. It does not alter
   engine lifecycle authority, admission, or queueing.

## KISS implementation plan

### Slice 1 — make the consumer namespace-aware (P0)

**Corrected after investigation.** The original premise — that a defective
writer put a conversation id into `sessionStatus` — is wrong. The run
promotion path writes the status under three deliberate aliases
(`sessionId`, `opencodeSessionId`, `conversationId`) so that a later read can
resolve the status by any of them. That aliasing is intended behavior and must
be preserved.

The defect is the consumer: outage bookkeeping treats every running key as an
OpenCode session id, so an intentional Veslo alias was forwarded to the engine.

1. Keep the alias write unchanged. Removing it would break status lookups that
   legitimately key by conversation id.
2. Keep the outgoing guard already in place: an id that is not an OpenCode
   session id is never dispatched to the engine, is traced, and does not count
   as a catch-up failure. This is the boundary invariant.
3. **Attempted and rejected.** Filtering the same distinction into outage
   bookkeeping (so the derived "running sessions" set would exclude local
   aliases) was tried and reverted. It broke four existing reconnect tests that
   legitimately use non-prefixed ids, and it made the outage return early, which
   *removed* the skip diagnostic instead of recording it. One guard at the
   dispatch boundary is sufficient and strictly more observable.
4. Record a content-free diagnostic when an id is skipped, so a recurrence is
   visible without reading an engine log.

**Status: done.** The guard is in place with a regression test that was
confirmed to fail when the guard is disabled. The event-stream test harness now
keys session status exactly like production; that alignment revealed the
reconnect catch-up branch had not been exercised by tests at all.

**Known blocker:** the event-stream test harness keys session status as
`workspace:id`, while production uses a `\0`-scoped key. A regression test for
the guard cannot exercise the real path until that harness scoping matches
production. Align the harness first; do not add a test that appears to cover
the branch but does not.

**Exit criterion:** no Veslo conversation or pending-draft key can reach an
OpenCode session endpoint, and a recurrence is visible in a first-party trace.

### Slice 2 — one owner and a finite reason set (P0)

1. Introduce a single reconnect-presentation owner that accepts observations
   (stream failed, catch-up incomplete, recovery attempted, recovery proven
   failed, identity mismatch skipped) and returns the status to present.
2. Replace `lastError` free text in the user-facing path with a finite reason
   enum. Keep a separate, content-free diagnostic field for support; it must
   not be rendered verbatim to the user.
3. Give every degraded reason an explicit clearing condition, and make the
   owner responsible for returning to `live`. A successful catch-up, a proven
   recovery, or a healthy stream must clear the state without requiring the
   stream to be torn down.
4. Make the recovery-episode lifetime part of the owner rather than an
   independent map, so “already attempted” cannot outlive the outage it
   described.
5. Do not change `reconnectStateBlocksSend`. Degraded presentation must remain
   non-blocking for sends.

**Status: done.** A finite `ReconnectStateReason` is carried on the state, every
degraded emitter supplies one, returning to `live` clears it, and the banner
renders the classified reason instead of `lastError`. The raw upstream envelope
is kept for diagnostics only and is never shown to the user. All emitters now
funnel through one owner that also returns the outage-scoped recovery budget
when the runtime goes live, so “recovery already attempted” can no longer
outlive the outage that produced it.

**Coverage gap to close:** the budget-return behavior has no direct test. Two
attempts to drive it through the event-stream harness never reached the recovery
branch, and a test that passes without exercising the branch is worse than none.
Closing it needs a harness affordance for entering the recovery path
deliberately, in the same spirit as the key-scoping alignment in Slice 1.

**Exit criterion:** a degraded banner names a finite reason, and disappears when
that reason no longer holds.

### Slice 3 — always-on, content-free transition diagnostics (P1)

1. Record every connection-status transition through the normal trace channel,
   not the debug-gated perf log: previous status, next status, finite reason,
   workspace scope, attempt count, and whether messages may be delayed.
2. Include the identity-mismatch skip from Slice 1 in the same vocabulary.
3. Extend the feedback diagnostic report to surface these transitions, reusing
   the normalized parser added by the previous plan.
4. Never record upstream error bodies, prompt or transcript content, file
   names, staged paths, or credentials.

**Status: items 1, 2 and 4 done.** Every connection-status transition is now
recorded with its finite reason, without a debug flag. The investigation also
showed why that alone was not enough: the session status trace writes only to an
in-memory array on `window`, which is why the original failure survived nowhere.
Transitions are therefore written to the send-workflow mirror as well.

**Open, with a correction.** Item 3 — surfacing these transitions in the
feedback diagnostic report — is not done, and the reason is more than
presentation. Verifying it revealed that the earlier claim in this plan was
too optimistic:

- The report's legacy branch recognizes `[veslo:send-workflow]`,
  `[veslo:runtime-trace]`, and `[veslo:ai-gateway]` prefixes.
- Real captures carry app-side rows as `[ui:…]` console lines — `[ui:runtime-perf]`
  was observed — and that prefix is applied by the desktop shell when it forwards
  webview console output, not by the app.
- No `[ui:send-trace]` equivalent could be confirmed in the source.

So the send-workflow mirror is reliable for a **local** investigation, which is
how this incident was actually solved, but it is not yet proven to reach a
**production** feedback capture. Before adding a report signal, establish how an
app-side send-workflow trace reaches a capture at all; if it does not, that
transport is the real gap and the report change would be decoration on missing
data. Do not add the prefix on assumption.

**Exit criterion:** a capture taken during a degraded runtime explains the
state from Veslo artifacts alone, with no third-party log required.

## Verification matrix

| Scenario | Required proof |
| --- | --- |
| Conversation id in session status | Never dispatched to the engine; skip is traced; catch-up is not marked failed. |
| Pending-draft key in session status | Same skip path; treated as local state, not an outage. |
| Catch-up incomplete | Degraded with a finite reason; clears after a later successful catch-up. |
| Recovery not recovered | Degraded with its own finite reason, distinct from catch-up incompleteness. |
| Recovery already attempted | Cannot outlive the outage; the episode clears with the outage. |
| Healthy stream after degradation | Returns to `live` without a stream teardown. |
| Any degraded state | No raw upstream error text is rendered to the user. |
| Diagnostics | Transitions are recorded without a debug flag and contain no content. |
| Send behavior | Degraded presentation still does not block sends. |

## Explicit non-goals

- introducing a second reconnect mechanism, runtime controller, or lease;
- changing engine lifecycle authority, admission, queueing, or generation
  evidence;
- blocking sends on degraded presentation;
- rendering upstream error identifiers to the user as a substitute for
  classification;
- rewriting the perf-log facility itself, beyond moving these specific
  transitions off the debug gate;
- retrying or resending user messages as part of recovery presentation.

## Why this is the KISS boundary

The failure was not a runtime fault. It was a local naming mismatch that was
presented as a runtime fault, in words the user could not act on, with no
first-party record. The repair is correspondingly narrow:

```text
identity from another namespace
  --must not reach--> a runtime that does not own it

an observation
  --must not become--> a directly written user-visible status

a degraded status
  --must have--> a finite reason and a defined clearing condition

a status transition
  --must be--> recorded content-free, without a debug flag
```
