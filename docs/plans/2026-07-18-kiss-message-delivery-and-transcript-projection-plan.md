---
title: KISS Message Delivery and Transcript Projection Plan
date: 2026-07-18
status: proposed
done: false
scope: app-side send presentation, local echo, and transcript render projection; no server transport change
---

# KISS Message Delivery and Transcript Projection Plan

## Decision

Treat an optimistic send as **one transient delivery item**, not as an
optimistic session and not as a second transcript.  The item is keyed by the
existing `clientMessageId`, belongs to one session queue key, and is visible
only until its canonical user message is observed or the delivery reaches a
terminal failure state.

The UI therefore has three independent models:

```text
server transcript       canonical, durable message history
delivery presentation   one local user-message row while that delivery is unresolved
run presentation        submitting/running/terminal activity indicator
```

They may change together for one user action, but none owns or rewrites the
others.  In particular, accepting a prompt must not reconstruct the selected
session's transcript, and a transcript update must not recreate delivery or
session hand-off state.

This plan is intentionally narrower than a generic reactive-store rewrite. It
uses the existing server-owned conversation submit contract and the existing
`clientMessageId` idempotency/correlation contract. It follows the current
identity-stabilization and transcript-hardening work; it does not replace their
transport freshness or canonical transcript guarantees.

## Why this is needed

The current healthy two-message desktop run showed one accepted submit per
user action, so duplicate transport is not the primary problem. The rendering
cost is asymmetric instead:

| Observed after user action | First message | Second message |
| --- | ---: | ---: |
| Direct app-to-server submits | 1 | 1 |
| DOM mutation batches | 8 | 11 |
| MutationObserver records | 36 | 1,014 |

The second send had two large replacement batches in the transcript list while
the canonical and effective message counts were unchanged. The current design
mixes several concerns around a pending submit: prepared local message,
pending session identity, session hand-off, optimistic admission, run state,
and transcript adoption. That coupling makes a small delivery transition able
to invalidate a broad render surface.

The product requirement is much smaller: immediately show the user's one
message, keep the composer usable, show delivery/run feedback, and replace the
local row with the canonical row exactly once. The product does not need an
optimistic copy of the whole session.

## Target shape

```text
Composer action
  -> MessageDeliveryController.submit(intent)
       -> add one LocalDeliveryItem
       -> invoke existing server-owned submit workflow once
       -> record accepted / failed / outcome-unknown

SSE and snapshot ingress
  -> canonical transcript store
  -> TranscriptRenderProjection
       canonical message items
       + at most one matching LocalDeliveryItem per rendered session
  -> MessageList keyed item reconciliation

Server lifecycle / run status
  -> RunPresentationState
  -> run indicator and composer availability only
```

`TranscriptRenderProjection` is the only place where canonical messages and a
local delivery item meet. It returns the prior item array when neither input
changed. It must not write the transcript store, change route selection, or
start a request.

The renderer receives a discriminated presentation item rather than being told
that the local row is a canonical `MessageWithParts` entity:

```ts
type TranscriptRenderItem =
  | { kind: "canonical"; key: `message:${string}`; message: MessageWithParts }
  | { kind: "local-delivery"; key: `delivery:${string}`; delivery: LocalDeliveryItem };
```

The local-delivery branch can reuse the existing user-message visual content,
but it must remain an adapter at the render edge. It must never be inserted
into the canonical session store or be mistaken for an OpenCode message.

## Ownership and invariants

### 1. `MessageDeliveryController` owns one send's temporary presentation

**New owner:** a focused controller/model under `packages/app/src/app/pages/`
or `context/`, chosen so it is composed by `SessionView` rather than by
`app.tsx`.

It owns a bounded map of local delivery items by session queue key. The normal
interactive policy is one unresolved visible item per key; queued drafts remain
queue records and do not become extra visible local rows before they are sent.

```ts
type LocalDeliveryPhase = "submitting" | "accepted" | "failed" | "outcome-unknown";

type LocalDeliveryItem = {
  clientMessageId: string;
  sessionKey: string;
  sessionId: string | null;
  draft: ComposerDraft;
  createdAt: number;
  phase: LocalDeliveryPhase;
  runId: string | null;
  error: string | null;
};
```

The controller is allowed to:

- create the item before the existing submit call;
- transfer it from a pending queue key to a materialized session key;
- record the server's accepted, rejected, or unknown outcome;
- remove it after a proven canonical-message adoption;
- expose a stable read model for the current rendered session.

It is not allowed to:

- write message or part entities;
- manufacture an OpenCode session id or directory;
- decide whether a server run is still active;
- own route selection, sidebar session rows, or transcript fetching;
- persist an unresolved delivery as canonical history.

### 2. The transcript store owns only server-observed history

`session-event-stream`, snapshot hydration, and
`session-transcript-controller` remain the exclusive writers of canonical
messages and parts. Their current identity/freshness work stays in place.

Canonical adoption has one explicit predicate:

1. the canonical message belongs to the delivery's materialized session;
2. its `clientMessageId` matches the local delivery item, when the server
   exposes that correlation; or a separately documented, deterministic legacy
   correlation rule applies;
3. the canonical user message is renderable.

Only that predicate removes the local delivery row. An accepted HTTP response
alone does not remove it, because the UI must not flash a blank gap while SSE
or a terminal snapshot is still catching up.

An ambiguous legacy match keeps the local row in `accepted`/syncing state. It
does not rewrite the transcript and it does not guess that a similarly worded
message is the same delivery. Terminal recovery may resolve the item only via
the same predicate or surface a recoverable outcome state.

### 3. Run presentation owns activity, not message identity

The existing per-session run state remains the authority for the run indicator,
composer busy state, cancellation, and queue draining. It receives an accepted
run id from the submit workflow but does not inspect or transform message
arrays.

The local delivery phase answers “did this user message leave the composer and
become visible?” The run state answers “is work still running?”. They are
related but deliberately not one state machine. A terminal run must not clear
a local message unless canonical adoption has happened; an accepted delivery
must not force a transcript replacement merely to start the indicator.

### 4. One projection owns what the list renders

Replace the current chain of independently allocated display arrays and
synthetic local `MessageWithParts` with one pure projection:

```text
canonical visible messages
  -> optional visibility/window slice
  -> optional local delivery item
  -> readonly TranscriptRenderItem[]
```

The projection preserves identity in these cases:

- no visibility change and no local delivery item: it reuses canonical entries;
- unchanged canonical entries plus the same local delivery object: it reuses
  the prior render-item array;
- a delivery phase change: it replaces only the local-delivery item and its
  outer item array;
- a canonical part delta: it replaces only the affected canonical item and its
  outer item array;
- canonical adoption: it removes one local-delivery item while retaining all
  unchanged canonical item objects and keys.

Session-switch hand-off remains a narrow route-loading concern. It may hold the
previous render-item array briefly when the next selected session has no loaded
history, but it may not clone, enrich, or merge deliveries from two sessions.

## Implementation slices

### KMD01 — characterize and freeze the current contracts

**Owners**

- `session-conversation-flow`
- `session-send-workflow`
- `pending-submit-model`
- `session.tsx`
- current focused send/optimistic/transcript tests

1. Write a concise transition table for normal send, first-message
   materialization, accepted response before SSE, canonical adoption, rejected
   submit, outcome-unknown, retry, queue drain, and session switch.
2. Add pure tests around the table before moving state. The tests assert
   identities, keys, and visible row count; they do not assert Solid timing.
3. Record the current behavior that must remain: one server-owned submit,
   client-message idempotency, pending-session hand-off, retry semantics,
   terminal transcript recovery, and queue ordering.
4. Mark every current pending-submit field as one of: delivery-only, run-only,
   queue-only, route/session hand-off, or obsolete coupling. Do not carry a
   field into the new owner merely because it exists today.

**Exit criterion:** the migration has an agreed transition table and does not
need to infer lifecycle meaning from UI state.

### KMD02 — introduce the delivery model without changing the renderer

**Owners**

- new `message-delivery-model` plus its tests
- `session-conversation-flow`
- `session.tsx`

1. Introduce `LocalDeliveryItem` and pure transitions:
   `create`, `remapSession`, `accept`, `fail`, `markOutcomeUnknown`,
   `adoptCanonical`, and `selectForSession`.
2. Keep the new model in the session-page composition boundary. Do not put it
   in `app.tsx`, the transcript store, or desktop persistence.
3. Make the normal send path create exactly one item and call the existing
   transport exactly once. Move only delivery fields out of the present
   optimistic draft map in this slice; leave queue and run state where they
   are.
4. During this transitional slice, adapt the new item through the existing
   local-message projection so visual behavior is unchanged. This is a
   temporary compatibility adapter, not the permanent architecture.
5. Add a focused trace counter at the delivery controller boundary:
   `created`, `remapped`, `accepted`, `adopted`, `failed`, `unknown`. It is
   content-free and only enabled by the existing local trace opt-in.

**Exit criterion:** every normal send has one delivery item and one submit;
there is no second owner creating an optimistic local row.

### KMD03 — make transcript adoption explicit and one-way

**Owners**

- `session.tsx`
- transcript projection/controller helpers
- `pending-submit-model` replacement tests

1. Move the current implicit `resolvePendingSubmittedRenderReplacement` and
   adoption effect into a named `adoptCanonicalDelivery` boundary.
2. Pass only a compact canonical-message index needed for correlation: session
   id, message id, role, client message id when present, and renderability.
   Do not scan text content or serialize transcript parts as an adoption key.
3. Remove a local item only through `adoptCanonicalDelivery`. All other
   transitions retain it with an explicit presentation phase.
4. Let a failed item remain editable/retryable as today, but give retry a new
   delivery item and client message id. An outcome-unknown item remains a
   delivery record and must not be silently converted into an editable retry.
5. Prove first-message remap: the delivery item changes its session key once,
   preserves its render key, and is not duplicated before/after materialization.

**Exit criterion:** a canonical store update cannot accidentally consume or
recreate a local row; adoption is observable, testable, and idempotent.

### KMD04 — replace synthetic message projection with render items

**Owners**

- new transcript render projection model near the viewport owner
- `session-transcript-viewport`
- `message-list`
- message-list and viewport tests

1. Introduce `TranscriptRenderItem[]` and one identity-preserving projection
   owner. Keep visibility/windowing policy in the viewport; it supplies a
   readonly canonical base to the render projection.
2. Change `MessageList` to reconcile by `TranscriptRenderItem.key` and render
   `canonical` versus `local-delivery` explicitly. Reuse present user-message
   rendering primitives rather than adding a second message card implementation.
3. Delete the compatibility adapter from KMD02 only after both branches have
   equivalent attachment, error, sync-warning, edit, copy, and accessibility
   behavior.
4. Preserve stable canonical keys (`message:<id>`) and use
   `delivery:<clientMessageId>` for the temporary row. A valid canonical item
   must never fall back to an index key.
5. Ensure that changing run indicator, composer busy state, managed-AI status,
   or route decorations does not allocate `TranscriptRenderItem[]`.

**Exit criterion:** no local delivery is represented as a canonical
`MessageWithParts`, and the list receives one stable item model with explicit
keys.

### KMD05 — remove coupled state and prove the measured budget

**Owners**

- old pending-submit compatibility paths
- session diagnostics and trace analyzer
- focused app tests; desktop manual trace

1. Remove only fields and helpers proven superseded by KMD02–04. Retain queue
   records, run-state records, and pending-session route hand-off when they
   still own distinct behavior.
2. Simplify `SessionView` so it composes three accessors—canonical transcript,
   selected local delivery item, and run presentation—rather than deriving
   local echo, pending state, and adoption in several effects.
3. Update diagnostics to report projection changes separately:
   `canonicalRevision`, `deliveryRevision`, `renderItemRevision`, and DOM
   batch. A run-only transition must show an unchanged render-item revision.
4. Run a controlled desktop trace: first send, wait for canonical adoption,
   second send, one streaming response, terminal hydration, retry/error case,
   and a session switch. Compare it to the documented baseline.
5. Make the acceptance gate structural, not a fragile absolute DOM count:
   - one normal send produces one delivery creation and one server submit;
   - one accepted delivery produces at most one remap and one adoption;
   - a run-only state transition causes zero render-item identity changes;
   - a canonical message/part update changes only the affected item plus the
     outer projection;
   - no DOM batch is attributed to a synthetic whole-session local echo.

**Exit criterion:** the legacy optimistic-session coupling is removed and the
second-send replacement pattern is either absent or attributed to a canonical
message/part update with a bounded affected item set.

## Required regression coverage

1. Normal existing-session send: one local delivery item, one submit, one
   canonical adoption, no duplicate user row.
2. First send: delivery starts under a pending queue key, remaps once to the
   materialized session, and keeps the same delivery render key.
3. Accepted response arrives before SSE: local row remains visible until
   canonical adoption.
4. Duplicate/equal canonical events do not change delivery or render-item
   identities after adoption.
5. Failed submit preserves an editable failed delivery; outcome-unknown is not
   silently retried.
6. A running/idle change without a canonical message or delivery transition
   preserves the render-item array reference.
7. A single assistant part delta preserves completed-prefix item identities and
   keys.
8. Session switch never shows a local delivery item from another session.
9. Queue drain has one delivery item only when the queued message actually
   starts sending; queued-but-unsent items do not appear in the transcript.
10. Existing terminal snapshot recovery still wins over partial live content
    without removing an unmatched local delivery item.

## Guardrails

- The app continues to send intent only; the Veslo server owns conversation,
  OpenCode-session, directory, and run creation.
- Do not add a global delivery store, a second transcript cache, persistence of
  optimistic rows, polling, debounce timers, or a broad Solid reactivity
  wrapper.
- Do not use message text, attachment names, or paths as an adoption key.
- Do not merge run lifecycle with delivery lifecycle merely to reduce the
  number of signals.
- Do not optimize away terminal transcript recovery; local delivery is a
  presentation concern, not a replacement for canonical reconciliation.
- Do not change server request counts in this plan. The healthy path already
  has one app submit per user action; this work targets presentation ownership
  and render allocation.

## Completion definition

The work is complete when one named controller owns one unresolved local
message delivery, one named projection owns the transcript list rendered by
`MessageList`, and run presentation is independent. The desktop trace must
show that a second normal send does not replace the completed transcript prefix
because of delivery/session state alone.
