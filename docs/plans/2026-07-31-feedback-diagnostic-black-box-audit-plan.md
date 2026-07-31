---
title: Feedback Diagnostic Black Box Audit Plan
status: proposed
done: false
date: 2026-07-31
issue: unlinked
scope: decision and implementation-readiness audit for bounded desktop diagnostics attached to user feedback
related:
  - docs/dev/state-and-config-reference.md
  - docs/dev/veslo-application-logs.md
  - docs/plans/2026-07-28-production-runtime-error-causality-audit-plan.md
---

# Feedback Diagnostic Black Box Audit Plan

## Decision to validate

Veslo must not continuously upload a full application firehose or send these
events to GlitchTip. Instead, it should keep a small, redacted, native-owned
diagnostic black box on the device. The user may explicitly attach a sealed
snapshot of the most recent ten minutes when filing feedback immediately
after a problem.

The existing explicit two-minute diagnostic capture remains useful for a
support-guided reproduction. The proposed ten-minute window is a different
interaction: it gives a user evidence from immediately *before* the error,
without asking them to reproduce it while a capture is running.

This document is an audit plan, not authorization to change application
behavior, upload policy, schemas, or cloud configuration.

## Product outcome

When a user opens Feedback, the form can offer an optional control similar to:

> Attach the last 10 minutes of redacted diagnostics

If selected, the feedback record and the diagnostic attachment share one
opaque `captureId`. The feedback submission must still work when snapshot
creation or upload fails; the UI reports that the diagnostic attachment was
not included and retains an upload/retry status locally. The user does not
need to copy log files or repeat the failing workflow.

The support/admin view uses the `captureId` to find the encrypted diagnostic
events. It must not paste raw diagnostic payloads into feedback text or an
external ticket automatically.

## Options under review

| Option | Behavior | Benefit | Main risk | Initial assessment |
| --- | --- | --- | --- | --- |
| A. Full-run cloud upload behind a switch | Collect and upload all runtime logs while a temporary flag is on. | Immediate central visibility. | High volume, duplicate errors, privacy exposure, requires a cloud carrier on every desktop. | Reject as the default design. It turns normal execution into a permanent firehose. |
| B. Explicit two-minute capture only | The user starts capture, reproduces the issue, then stops it. | Already bounded and implemented. | Misses the event that happened before the user recognized a problem. | Keep as the support/reproduction lane. |
| C. Ten-minute local rolling buffer, explicit feedback attachment | Retain a bounded local timeline; seal and upload only on user request. | Captures pre-error context, no continuous cloud transfer, clear consent. | Requires careful local retention, redaction, atomic snapshot, and feedback correlation. | Recommended primary lane. |
| D. Hybrid B + C | One collector provides both explicit capture and feedback snapshot; each has its own trigger and budget. | Avoids two incompatible logging systems. | Shared collector must preserve the stricter privacy and ownership rules. | Recommended target, subject to this audit. |

## Non-negotiable boundaries

- No GlitchTip event is created by this feature, and no GlitchTip event is
  used as the attachment store.
- The normal ten-minute buffer stays local. It is uploaded only after an
  explicit user action in Feedback or the already explicit support capture.
- "Whole run" means all high-signal, structured diagnostic classes needed to
  explain a failure. It does not mean raw prompts, transcripts, workspace
  files, tokens, headers, environment values, screenshots, or unbounded
  stdout/stderr.
- The native desktop layer owns retention, redaction before persistence,
  snapshot sealing, retry, and upload. The renderer may request a snapshot but
  must not own a second browser-storage copy.
- A user/org change invalidates pending attachments rather than allowing a
  snapshot collected for one identity to be uploaded under another.
- The feature is temporary/explicitly gated. The audit must name one owner,
  one default-off gate, an expiry date, and the removal or renewal decision.

## Diagnostic event contract to audit

The audit must define a compact, versioned envelope. Every accepted event
needs only the data required to reconstruct ordering and ownership:

```text
schema version, timestamp, monotonic sequence, source, kind, level,
workspace/session/conversation/run/trace correlation ids when available,
sanitized result class, bounded attributes, redaction and drop counters
```

Required high-signal families are:

1. user action boundaries: submit, cancel, retry, feedback open/submit;
2. submit/run disposition: accepted, queued, blocked, failed, completed;
3. OpenCode/router/proxy failure class: status family, timeout, unavailable,
   malformed response, connection failure; never a raw upstream response;
4. runtime-chain lifecycle: sidecar start, ready, exit, restart, exit
   code/signal/restart reason and a safe process generation identifier;
5. workspace/runtime readiness and recovery decision: policy, readiness
   result, recovery attempt, terminal typed reason;
6. renderer handled/fatal error: stable context, error class and bounded,
   redacted message fingerprint; and
7. diagnostic-delivery state: buffer overflow, coalescing, snapshot created,
   upload accepted/retried/rejected/expired.

The current traces already show why this needs a single correlation model: one
OpenCode submit failure creates several server and UI "failed" events. The
attachment must preserve the causal timeline without treating those downstream
records as several independent customer errors.

## Anti-noise policy

The collector must produce a causal timeline, not a second error console.
Before implementation, audit and specify all of the following:

| Control | Required rule |
| --- | --- |
| Allowlist | Only the event families above and explicitly approved bootstrap/updater events enter the ring. Unknown sources are rejected. |
| Levels | Retain error/warn/action boundaries first. Info events are allowed only for a small allowlist that explains a state transition. |
| Coalescing | Identical `(kind, source, correlation ids, normalized failure class)` records in a short interval become one record with `count`, first/last timestamps. |
| Rate limits | Set per-source and per-correlation-id limits. Record a single `events_coalesced` or `events_dropped` summary instead of every suppressed repeat. |
| Size cap | The ring has both a ten-minute time window and a serialized-byte cap. It evicts oldest low-priority/coalescible events first and records exactly what was dropped. |
| Snapshot cap | A feedback snapshot is bounded independently of the live ring at 50 MiB serialized event data. It is sent in bounded batches, never as one large request. |
| No recursive logging | Collector, serialization, persistence, and upload failures are represented by a bounded delivery summary; they must not feed their own error loop. |
| Sampling | Never sample away a user-action terminal result, typed submit failure, fatal renderer event, or sidecar exit. Sampling is permitted only for repetitive low-priority diagnostics. |

The audit must measure a normal active session and the known retry/failure
storm. It must prove that the cap preserves the initial failure and final
disposition, rather than keeping only a flood of reconciliation attempts.

## Proposed owner architecture

Introduce one native owner, provisionally named `DesktopDiagnosticsOwner`.
It is the only component allowed to decide whether a diagnostic event is
retained locally, sealed into an attachment, or sent outside the application.
It owns the policy and lifecycle, not every individual producer.

For this first KISS slice, it has exactly four responsibilities:

1. receive approved, structured events from app/native/server/sidecar bridges;
2. redact, normalize, coalesce, and retain the ten-minute local window;
3. seal a feedback snapshot with identity binding and durable delivery status;
   and
4. upload a sealed snapshot to the existing authenticated diagnostics service
   only after explicit user attachment.

The renderer gets a deliberately small command surface: ask whether an
attachment is available, request a sealed feedback snapshot, and read its
status. It does not serialize logs, store a ring buffer, redact data, choose a
cloud endpoint, own retries, or upload on its own.

The intended future boundary is equally narrow: other external diagnostics
deliveries can become `DesktopDiagnosticsOwner` requests with an approved
purpose and sink, but they cannot bypass its event policy or create their own
spools. This does **not** justify a general telemetry framework now. The first
implementation has one sink (the current Den diagnostics service) and one
purpose (`feedback-attachment`).

The owner should keep its collaborators small and replaceable:

| Collaborator | KISS responsibility | Explicit non-responsibility |
| --- | --- | --- |
| Event normalizer | allowlist, schema validation, redaction and fingerprinting | process lifecycle or network I/O |
| Recent ring store | bounded local segment retention and atomic snapshot read | cloud upload |
| Snapshot queue | immutable capture status, identity binding and retry state | receiving live events |
| Den sink | authenticated upload of sealed batches | deciding what may be collected |

This split keeps one owner without creating a diagnostics god object.

## Proposed retention, memory, and lifecycle

```text
approved app/server/sidecar event
          |
          v
native redaction + structured normalizer
          |
          v
ten-minute, byte-bounded local ring
          |
          +-- user starts support capture --> bounded capture queue --> Den
          |
          +-- user selects Feedback attachment --> immutable captureId snapshot
                                                --> durable upload queue --> Den
                                                                           |
feedback record <--------------------------- captureId only ---------------+
```

The ring must be persisted by the native layer rather than held in an
unbounded in-memory array: a renderer crash or a desktop restart is often the
event the user wants to report. Persistence is still short lived. On every
append and startup recovery it deletes entries older than ten minutes; it
applies the byte cap; and it clears a fully delivered snapshot according to
the established capture-retention policy.

The initial implementation target for audit is a small segmented on-disk ring,
not a database and not one growing JSON file:

- write already-redacted NDJSON events into short-lived native-owned segments;
- keep only the active segment writer plus a bounded coalescing index in RAM;
- use a 50 MiB total ring budget, approximately 1 MiB per segment, at most 50
  retained segments, a maximum 1,024 recent coalescing keys, and a 30-second
  coalescing interval; and
- cap a sealed feedback snapshot at 50 MiB serialized event data, emitting a
  truthful truncation summary only if the time window has already crossed that
  hard cap.

The 50 MiB limits are product requirements for this proposal; segment size and
coalescing-key count remain implementation values to validate. The audit must
profile a normal ten-minute production session and a retry storm on the
supported desktop hardware. It must demonstrate a hard upper bound for
resident memory, files, open handles, CPU spent serializing, and upload work.
The ring writes locally only; it opens no network connection and schedules no
retry until a user explicitly seals an attachment.

The normal desktop spool must not be repurposed as an unbounded history. Its
delivery semantics and source eligibility are different. The audit must decide
whether the existing user-capture queue can be generalized into a separately
named snapshot queue or whether a small shared bounded-queue abstraction is
safe. A second free-form renderer spool is out of scope.

## Upload and feedback association

The existing direct diagnostic ingestion path is the preferred cloud endpoint:
it authenticates the signed-in user, verifies organization membership, stores
payloads encrypted, and already understands capture identifiers. A 50 MiB
attachment must use the existing bounded batch protocol rather than one large
JSON request: the native owner serializes a sealed snapshot into independently
idempotent, size-limited batches and reports the attachment as uploaded only
after every batch is accepted. The current two-minute support capture may keep
its separate 2 MiB product budget; this plan changes only the feedback
attachment budget.

The audit must verify whether the direct-ingest allowlist accepts every
proposed normalized event. It must expand an allowlist deliberately, not make
the endpoint accept arbitrary desktop logs. It must also define a short cloud
retention policy for 50 MiB attachments so the larger capacity cannot become
an accidental permanent archive.

Feedback currently has no diagnostic attachment reference. The intended
contract to evaluate is an optional, opaque UUID field such as
`diagnosticCaptureId` on the feedback request and persistent feedback record.
It is a reference, not log content.

The failure ordering must be explicit:

1. Native code seals the local ten-minute window under a newly created
   `captureId` and records the user/org binding.
2. Feedback may submit the same `captureId` without waiting for cloud upload.
3. Native upload retries independently using the same idempotency identity.
4. The admin/support view shows `pending`, `uploaded`, `undeliverable`, or
   `not-requested`; it never pretends an attachment exists merely because the
   feedback row contains an id.
5. A failed feedback submission must not silently upload diagnostics. A failed
   diagnostic upload must not discard the feedback text or block its retry.

This ordering keeps user intent clear and prevents the attachment from making
the feedback path less reliable than it is today.

## Temporary gate and sunset

Do not add a renderer-only boolean. The gate must be owned by the desktop
build/runtime configuration, default off, and checked before the ring accepts
events or the Feedback UI offers attachment.

The existing production diagnostic-capture build gate is a candidate, but the
audit must decide whether feedback attachment needs a distinct,
plainly-named gate. The selected gate needs:

- a documented owner and expiry date;
- release/build evidence of its value without exposing secrets;
- a test proving default-off creates no diagnostic ring and offers no upload;
- a test proving disabling it stops future collection while safely clearing
  unuploaded data; and
- a scheduled decision to remove it, renew it, or graduate it into a durable
  consented support feature.

## Audit work packages

### DBB01 — Baseline and source inventory

Map every present producer that should feed the ring: renderer error reporter,
send workflow, local server structured logs, orchestrator/router/engine
supervision, bootstrap/updater, and current user capture. For each, record
whether it is structured, already redacted, correlated, rate-limited, and
currently visible to the native forwarder.

Deliverable: source-to-event-family table and a list of gaps. In particular,
verify whether handled renderer errors enter the native capture today rather
than only error monitoring.

### DBB02 — Privacy and schema review

Define the schema, source allowlist, field-level redaction, maximum string
lengths, correlation-id validation, and message fingerprinting. Test hostile
values containing bearer tokens, URLs with query strings, home paths, prompts,
and nested JSON. Determine whether sidecar JSON log records are normalized
before the ring and how unstructured stderr is treated.

Exit criterion: a reviewer can state exactly why each field is needed and why
no raw user content survives persistence.

### DBB03 — Bounded ring behavior and production resource budget

Prototype or specify the native ten-minute segmented ring with a serialized
byte budget, stable ordering, coalescing, and explicit drop summaries. Stress
it with a retry/reconcile storm, high-frequency UI mutation traces, and a
quiet session. Measure maximum resident memory, segment count/bytes, open file
handles, append latency, CPU cost, and startup recovery time.

Exit criterion: there is one deterministic eviction policy, and a snapshot
from every scenario retains the first causal failure plus final terminal state
without unbounded process memory or background network work.

### DBB04 — Native owner and capture/snapshot queue contract

Compare the current two-minute capture queue with the required feedback
snapshot. Decide whether to reuse its batching, idempotency, identity binding,
backoff, terminal states, and cleanup. Prove that sealing is atomic with
respect to concurrent writes and that a crash cannot produce a partially
labelled attachment. Define the three renderer-to-owner commands and prove no
renderer module keeps a parallel log buffer or makes a cloud upload request.

Exit criterion: one native owner and one durable retry story; no duplicated
queue implementation without a documented reason.

### DBB05 — Feedback and cloud contract

Audit the feedback request, persistence schema, feedback projection, diagnostic
ingest validation, admin lookup, and access control for an opaque
`diagnosticCaptureId`. Establish how pending/undeliverable attachment state is
shown to support and whether the external feedback projector receives only the
reference or a safe availability indicator.

Exit criterion: feedback remains submit-able when diagnostics fail, and no
diagnostic payload is copied to the feedback database or external ticket.

### DBB06 — Real desktop verification

Use the Tauri desktop runtime to validate these cases:

1. default-off gate: no local ring, no feedback attachment control, no cloud
   diagnostic upload;
2. quiet ten-minute session: bounded snapshot uploads with complete metadata
   and the declared resident-memory/file-handle budget;
3. typed OpenCode submit failure: snapshot contains the action, runtime state,
   failure class, and final user-visible disposition once each;
4. repeated retry/reconcile errors: coalescing and drop summaries prevent a
   flood while preserving causality;
5. renderer failure and sidecar exit: redacted event appears in snapshot;
6. feedback succeeds while upload is delayed or rejected; and
7. sign-out, account switch, restart, full byte cap, and ten-minute expiry:
   no cross-identity or expired upload occurs.

Use focused unit/contract coverage only to support this desktop path. The
final implementation plan must include a Tauri Pilot scenario for the user
feedback flow.

## Decisions required before implementation

1. Is the 50 MiB local-ring and 50 MiB feedback-attachment limit acceptable
   together with the measured production-hardware resource budget and cloud
   retention policy?
2. Does the feature attach by an explicit checkbox, or should an error banner
   preselect it while still requiring confirmation?
3. Is the existing diagnostic-capture gate sufficient, or do we want a
   separate temporary feedback-attachment gate with an explicit sunset date?
4. Which support surface can resolve `feedbackId -> diagnosticCaptureId` while
   enforcing organization and platform-admin access?
5. What retention applies to a successfully uploaded feedback attachment, and
   who is accountable for deletion?

## Success criteria

The work is ready to implement only when it proves all of the following:

- a ten-minute local diagnostic window is bounded by time, bytes, resident
  memory, file handles, and background work;
- it is quiet under normal operation and coalesces failure storms;
- it contains the causal context needed for the current OpenCode/runtime
  incidents without raw user content;
- a user can attach it to feedback explicitly after an error;
- feedback and diagnostic delivery fail independently and truthfully;
- the cloud stores encrypted payloads with least-privilege lookup; and
- the temporary gate is default off and has a documented expiry/removal path.
