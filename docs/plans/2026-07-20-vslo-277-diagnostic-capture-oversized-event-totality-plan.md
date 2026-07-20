---
title: VSLO-277 Diagnostic Capture Oversized Event Totality Plan
date: 2026-07-20
status: in_progress
done: false
base_branch: main
base_commit: bda77f67c3264621df609ad5b3f7171d2ea6ec12
source_issue: User diagnostic capture can leave an oversized queued event pending
target_area:
  - packages/desktop/src-tauri/src/user_diagnostic_capture.rs
  - services/den/test/desktop-diagnostics-route.test.ts
---

# VSLO-277: Diagnostic Capture Oversized Event Totality

## Goal

Make the desktop diagnostic-capture delivery path total. A delivery-eligible
queued event has a non-empty, unique trimmed string `id` and its serialized
event is at most the 2 MiB **per-event delivery eligibility cap**. Each such
event is included in exactly one prepared delivery batch. A record outside that
contract reaches an explicit terminal drop; it must not remain pending without
a delivery attempt, retry, or drop classification.

This is a defensive correctness fix, not an emergency production outage.
The normal capture path cannot currently produce an event over the 224 KiB
batch limit: `DebugLogsForwarder::append()` caps a log line at 64 KiB and the
capture sanitizer caps the resulting diagnostic text at 16 KiB. The fix closes
the generic batcher gap for malformed/local queues and future callers without
weakening those input limits.

## Verified Current Behaviour

`user_diagnostic_capture.rs` defines these independent limits:

| Limit | Value | Role |
| --- | ---: | --- |
| `MAX_DIAGNOSTIC_TEXT_BYTES` | 16 KiB | Current production capture input bound |
| `MAX_BATCH_BYTES` | 224 KiB | Preferred network batch bound |
| `CAPTURE_MAX_BYTES` | 2 MiB | Total locally captured payload budget; also the per-event delivery eligibility cap for persisted queue input |
| Den desktop diagnostics route | 10 MiB | Cloud request-body bound |

`build_batches()` currently skips a first event that exceeds
`MAX_BATCH_BYTES`: with an empty `current` batch, the candidate fails the
limit and neither branch stores it. `flush()` then sees no batch to post,
rewrites the event as remaining, clears retry state, and keeps it pending.

There are two adjacent contract gaps to close with the same change:

- Queue parsing accepts arbitrary JSON. `flush()` tracks delivery in a
  `HashSet` keyed by `id`, so a missing, empty, or duplicated ID cannot support
  an exactly-once claim.
- The current fit calculation serializes only `{ batchId, events }` and derives
  the tentative ID from the newest candidate event. `post_batch()` later sends
  a larger envelope and derives its ID from the first event in the actual
  batch. The 224 KiB guard is therefore not measuring the actual request.

The background flush runs every five seconds. Retention eventually clears the
queue at `endsAt + 24 hours`, so "forever" is not literal; a contrived queued
event can nevertheless block the next capture for that retention period.

The direct cloud route is compatible with a single capture-budget-sized event:
it accepts JSON bodies up to 10 MiB, validates no per-event payload byte limit,
and persists encrypted payloads in `longtext`. A capture event under the 2 MiB
local budget plus its request envelope remains below this route contract.

## Scope And Non-Goals

In scope:

- Validate queue identity and size before delivery.
- Preserve every delivery-eligible event in exactly one prepared batch.
- Send a delivery-eligible event that alone exceeds 224 KiB as a one-event
  batch when it remains within the existing 2 MiB capture budget.
- Add focused desktop flush, batcher, and Den contract regression tests.

Out of scope:

- Raising `CAPTURE_MAX_BYTES`, `MAX_BATCH_BYTES`, or the 16 KiB source limit.
- Changing the capture journal schema, retry policy, UI status shape, or
  retention window. Existing `dropped_delivery`, `delivery_rejected`, and
  `terminal_reason` are sufficient for the new terminal classifications.
- A new server route or server-side batching system.
- Treating ordinary large process output as acceptable capture input; source
  truncation and sanitization remain mandatory.

## Implementation Plan

### VSLO277-01: Validate the local delivery contract

File: `packages/desktop/src-tauri/src/user_diagnostic_capture.rs`

1. After parsing the queue and before preparing any request, require every
   event to contain a non-empty string `id` and require IDs to be unique across
   the queue file.
2. Measure each serialized event against `CAPTURE_MAX_BYTES` as the per-event
   delivery eligibility cap. This protects the generic/local queue path even
   though normal `observe()` input is already bounded to 16 KiB; it does not
   change the original total capture budget.
3. On a missing/empty/duplicate ID, serialization failure, or event over the
   capture budget, fail closed for the capture: remove its queue, set
   `pending_events` to zero, add the queued event count to `dropped_delivery`,
   set `state = delivery_rejected`, and persist a specific terminal reason
   (`queue_invalid_event_id`, `queue_duplicate_event_id`, or
   `queue_event_exceeds_capture_budget`). Do not call the poster.
4. This is deliberately a capture-level terminal drop rather than trying to
   retain an ambiguous subset. It preserves the existing fail-closed treatment
   of invalid delivery input and prevents a duplicate ID from deleting an
   unposted sibling through the delivered-ID set.

### VSLO277-02: Prepare and measure the exact request body

File: `packages/desktop/src-tauri/src/user_diagnostic_capture.rs`

1. Introduce one internal request serializer that accepts the cloud context,
   actual first-event-derived `batchId`, and events, and returns the exact JSON
   bytes sent to `/v1/desktop-diagnostics`.
2. Have batch construction produce prepared batches containing the actual
   `batch_id`, events, and serialized body. `post_batch()` must send those
   bytes directly; it must not rebuild a second envelope.
3. Apply `MAX_BATCH_BYTES` to that exact serialized body. This includes
   `installId`, `bootId`, user/org/workspace fields, `deliveryPath`, and the
   real batch ID.
4. Retain ordinary packing: at most 500 events and at most 224 KiB based on the
   exact payload. Keep the 500-event boundary distinct from byte overflow.
5. If an otherwise delivery-eligible single event exceeds 224 KiB, prepare it
   as one explicit oversized batch. Its body can exceed the preferred batch
   limit, but remains compatible with the existing 10 MiB Den request limit.
6. Preserve input order and exactly-once batch membership. The deterministic
   batch ID remains `capture:<captureId>:<firstEventId>` and is used both in
   the serialized body and `Idempotency-Key`.

### VSLO277-03: Make flush delivery testable without the network

File: `packages/desktop/src-tauri/src/user_diagnostic_capture.rs`

1. Keep the public `flush()` API unchanged.
2. Extract its posting loop behind a small private `flush_with_poster` seam (or
   equivalent injected poster). Production calls the current `ureq` poster;
   tests provide a local successful poster and inspect the prepared batch.
3. Do not introduce a trait hierarchy, runtime configuration, or alternate
   transport. The seam exists solely to make queue mutation after a successful
   post deterministic and testable.

### VSLO277-04: Add focused native regression coverage

File: `packages/desktop/src-tauri/src/user_diagnostic_capture.rs`

Add focused tests using serialized capture-like JSON events:

- a single event just over `MAX_BATCH_BYTES` produces one one-event prepared
  batch whose measured body is the exact body supplied to the poster;
- a sequence `small -> oversized -> small` preserves all IDs, ordering, and
  exactly-once membership; the oversized event is its own batch;
- a normal batch at the 500-event boundary starts the next event in a new
  normal batch rather than classifying it as oversized;
- an end-to-end local flush fixture with a successful injected poster delivers
  one oversized-but-under-budget event, removes it from the queue, makes
  `pending_events` zero, increments `accepted_events`, and moves a finished
  capture to `uploaded`;
- missing, empty, duplicate, and over-budget event IDs/payloads never reach
  the poster and produce the documented terminal drop with no pending queue.

The test must create the oversized value intentionally. It must not rely on
the production capture sanitizer, because the point is to protect the batcher
against future or locally malformed queue contents.

### VSLO277-05: Pin the cloud compatibility assumption

File: `services/den/test/desktop-diagnostics-route.test.ts`

Add one route test that posts an authenticated UUID-marked capture event whose
serialized request is above 224 KiB and below 2 MiB. Assert `202` and one
stored event. This is a contract test for the single-event fallback, not a
request to make all diagnostic uploads arbitrarily large.

No Den production code changes are expected: the existing 10 MiB parser,
validation, and `longtext` payload storage already satisfy this contract.

## Acceptance Criteria

- A delivery-eligible queue has unique non-empty event IDs, and flattening its
  prepared batches yields those IDs once in input order.
- The measured byte size of every ordinary batch is the size of the exact
  payload sent by the poster and is at most 224 KiB.
- An event over 224 KiB but below the capture budget is posted exactly once as
  a one-event batch, then removed from the queue on a successful response.
- Missing, duplicate, unserializable, and over-budget records are terminally
  dropped with `pending_events = 0`; they cannot enter an empty delivery loop.
- A normal 500-event boundary retains normal packing behaviour.
- The Den route demonstrably accepts the fallback payload size.
- Existing source truncation, sanitization, identity checks, retry behaviour,
  and retention semantics are unchanged.

## Verification

Run:

```powershell
Set-Location packages/desktop/src-tauri
cargo test user_diagnostic_capture --lib

Set-Location ../../..
pnpm --filter @neatech/den exec tsx --test test/desktop-diagnostics-route.test.ts
pnpm --filter @neatech/den typecheck
git diff --check

# Repository quality gate before merge/release
pnpm check
```

Manual desktop runtime validation is not required for this isolated pure
batching change; the production source path is already bounded to 16 KiB and
the focused native plus route tests exercise the changed contract directly.

## Rollout And Removal

Ship with the next desktop release without a feature flag. The change only
makes already queued input deliverable and does not alter the public capture
UI or cloud endpoint. There is no temporary compatibility branch to remove.
