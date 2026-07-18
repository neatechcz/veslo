---
title: Professional Transcript Projection Hardening Plan
date: 2026-07-18
status: proposed
done: false
scope: desktop-to-app transcript transport and projection after identity stabilization
---

# Professional Transcript Projection Hardening Plan

## Context

The first identity stabilization pass makes repeated equivalent SSE and snapshot
writes no-ops, preserves terminal transcript authority, and retains projected
message identity through the viewport. It is deliberately a KISS remediation,
not the final architecture for a high-frequency transcript.

One correctness bug found during review has already been fixed in that pass:
the former string-signature equality could collide for delimiter-containing
payloads. Store equality now uses structural comparison and has a direct
regression test. This plan is for the four remaining architectural steps, not
for re-opening that fixed collision.

## Desired end state

```text
SSE / snapshot
  -> normalized entity store with explicit freshness contract
  -> session canonical/visible selector with structural sharing
  -> viewport-owned direct rendered memo and windowing
  -> optional incremental block projection keyed by stable transcript block IDs
  -> keyed DOM / virtualizer
  -> content-free dev diagnostics and manual trace gate
```

The selected session must not rebuild its full render model for an unrelated
entity update or a repeated transport event. A legitimate update to the active
assistant part may update its block and any dependent suffix, but must not
invalidate completed prior turns.

## Step 1 — make transport freshness explicit at the ingress boundary

**Owners**

- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/session-store-model.ts`
- `packages/app/src/app/context/session-transcript-controller.ts`
- `packages/app/src/app/utils/messages.ts`
- `packages/app/src/app/types.ts` (`OpencodeEvent` transport metadata)
- `packages/desktop/src-tauri/src/commands/engine_sse.rs`
- relevant OpenCode SDK/event adapters

1. First verify whether the upstream SSE/SDK contract provides a per-event ID or
   monotonic part sequence that survives a disconnect and subsequent
   subscription. Record the raw SSE `id:` behavior and the SDK equivalent; do
   not infer identity from local arrival order.
2. When upstream identity exists, preserve it through the complete transport
   contract: parse `id:` in `engine_sse.rs`, include it in the desktop bridge
   event, retain it in `normalizeEvent`, and expose it as optional transport
   metadata on `OpencodeEvent`. The app writer may then use that reconnect-stable
   identity for delta deduplication.
3. Define typed `MessageFreshness` and `PartFreshness` comparators. Prefer a
   monotonic revision/sequence; use explicit structural equality only as the
   compatibility fallback for payloads that have no freshness metadata.
4. Define two separate part contracts. A full-text part is an authoritative
   replacement subject to its freshness comparator. A text delta is an append
   operation and may be deduplicated **only** by a stable delta `eventId` or a
   monotonic per-part sequence; text content or `endsWith(delta)` is never an
   idempotency key. Two distinct `"ha"` deltas after `""` must produce
   `"haha"`.
5. Define the deduplication-state scope and lifecycle. An opaque `eventId` key
   is at least `(source/workspace, sessionID, partID, eventId)`; it must survive
   reconnect for that scope and must not collide with another workspace or
   session. For a monotonic sequence, retain only the highest accepted sequence
   per `(source/workspace, sessionID, partID)`. For opaque IDs, clear seen state
   only after a terminal authoritative snapshot, part deletion/revert, or a
   known cursor fence proves the replay window closed. This keeps the state
   bounded without clearing it before the promised reconnect deduplication.
6. If upstream provides no reconnect-stable delta identity, explicitly retain an
   at-least-once stream contract. Do not generate a local counter and present it
   as a deduplication key. A reconnect catch-up is safe only with an explicit
   synchronization fence: either the snapshot carries cursor/revision `R` and
   the subscription supplies only events after `R`, or the server returns an
   atomic snapshot together with the stream cursor. Buffering app events while
   a snapshot fetch is in flight is not by itself a fence.
7. Without a reconnect-stable event identity **and** a snapshot/stream cursor,
   retain only eventual full-snapshot reconciliation. Do not replay or discard
   buffered append deltas based on local timing, and do not claim immediate
   post-reconnect transcript correctness. Diagnostics must identify this
   degraded contract so it cannot silently masquerade as catch-up.
8. Keep the current exact terminal-hydration exception: a canonical terminal
   snapshot can replace partial live content once even if its source timestamp
   is not newer in the normal streaming sense.
9. Emit one aggregate development trace per writer batch with accepted,
   duplicate, stale, and terminal-replacement counts. Keep
   `onTranscriptObserved` event-level and separate from accepted store writes.

**Acceptance**

- No generic delimiter-sensitive serializer remains on a transcript write path.
- A duplicate event is cheap and does not replace an entity or list reference.
- A stale event cannot overwrite newer text/tool state.
- Two distinct equal-content text deltas both append; replaying the same
  identified delta does not append twice; and a full replacement part still
  supersedes its prior candidate when its freshness contract permits it.
- The same identified delta replayed after a separate SSE subscription is still
  a no-op, not merely a duplicate within one connection.
- The same opaque event ID in separate workspace/session/part scopes never
  suppresses a legitimate delta; dedup state is bounded and survives for exactly
  the reconnect replay window promised by its transport contract.
- Without a reconnect-stable identity, the system explicitly uses at-least-once
  delivery. It uses immediate catch-up only with a snapshot/stream cursor fence;
  otherwise it performs eventual full-snapshot reconciliation, makes no
  immediate-correctness or exactly-once claim, and emits a content-free
  diagnostic.
- A delta already represented by a fenced snapshot cannot duplicate text when
  the buffered stream is released; a delta after that snapshot cursor cannot be
  lost.
- A terminal canonical snapshot still wins over a partial stream exactly once.

## Step 2 — consolidate the transcript selector into one explicit owner

**Owners**

- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/context/session-store-model.ts`
- `packages/app/src/app/context/session-visible-messages.ts`
- `packages/app/src/app/pages/session-transcript-viewport.ts` for its preserved
  hand-off contract and regression tests

1. Introduce a named transcript projection controller/selector that owns the
   current `MessageWithParts` cache and visible-message cache.
2. Its public stages must be explicit: `canonical` and `visible`. Each returns
   its previous array if ordered item identities did not change.
3. Move the cache contracts out of `app.tsx` closures into the selector owner.
   Keep synthetic error construction injected from the app shell if it needs UI
   localization, but keep cache and identity policy in the selector.
4. Make collection mutability honest: use `readonly` arrays end-to-end where
   consumers do not mutate, rather than `messages as T[]` casts.
5. Keep windowing, anchoring, local echo, and the direct `renderedMessages`
   memo in the viewport controller. It currently prevents a rapid
   idle/running-transition transcript flash; a selector extraction must not
   replace it with the deferred batched signal. Any future move of this stage
   requires the same direct-memo behavior and a dedicated flash regression.

**Acceptance**

- One owner documents each projection stage and its allowed allocation cases.
- No app-shell effect or component reconstructs transcript arrays ad hoc.
- Unchanged synthetic errors, aliases, and no-window viewport paths preserve
  their prior identities.
- The direct viewport memo remains the value exposed as
  `effectiveRenderedMessages`; the batched render experiment remains
  observational only.

## Step 3 — make progress-block derivation incremental

**Owners**

- `packages/app/src/app/components/session/progress-grouping-model.ts`
- `packages/app/src/app/components/session/message-list.tsx`
- tests under `packages/app/src/app/tests/components/session/`

1. Profile a fresh manual trace first. Continue only when either threshold is
   met after Step 1–2 are live: (a) at least 20 excess `messageBlocks`
   recomputations and at least 25% more block recomputations than display/input
   revisions in one 30-second stream scenario, or (b) `message-blocks` has p95
   self time of at least 6 ms or cumulative self time above 150 ms in that same
   scenario. Record both counts and duration in the baseline note.
2. Add a `createProgressBlockProjection` model keyed by stable
   `message:<id>` / `progress:<id>` keys. Reuse completed block objects when
   their contributing message references are unchanged.
3. On a live assistant part update, rebuild only the active assistant turn and
   any formally identified dependent suffix. Do not attempt unsafe arbitrary
   partial grouping.
4. Return one projection object containing entries, keys, block lookup, and
   block-to-message index, replacing the current parallel `.map()` and `Map`
   derivations from the same entries.

**Acceptance**

- Stable completed transcript prefix keeps the same block identities across a
  final assistant stream.
- Both normal `<For>` and virtualized paths use the same stable keys.
- No key downgrade to index fallback is introduced for valid message/block IDs.
- Transcript ordering and progress grouping tests remain unchanged semantically.

## Step 4 — establish the measured rollout gate

**Owners**

- `packages/app/src/app/components/session/message-list.tsx`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/scripts/analyze-ui-effect-trace.mjs`
- `docs/plans/` baseline note

1. Keep development tracing content-free and local. Correlate writer batch
   revision, canonical/visible/rendered projection revision, block revision,
   and DOM batch without assigning a guessed single cause to a mixed frame.
2. Define a manual `pnpm dev` scenario: long streaming answer, continued draft
   typing, local echo, terminal recovery, synthetic error, revert boundary, and
   session switch.
3. Establish a before/after baseline using `displayRevision` and
   `streamPartRevision`, then calculate the Step 3 thresholds from block
   recomputations after subtracting explicitly recorded streaming/input
   revisions.
4. Gate Step 3 rollout on evidence that the remaining work is block derivation,
   rather than another upstream store/projection write.

**Acceptance**

- No per-token Tauri IPC is added.
- Equal writer/projection revisions are not classified as a real streaming
  delta.
- A trace can distinguish ingress duplication, projection allocation, and a
  genuine DOM update.
- The final record contains exact trace timestamps and counts, not a vague
  “rendering improved” claim.

## Verification sequence

For Step 1, add focused ingress tests for both of these cases before the normal
context/component suites:

1. two different identified deltas with the same text append twice (`"ha"` +
   `"ha"` becomes `"haha"`);
2. replaying the same identified delta leaves the part and list references
   unchanged.
3. replaying that same identified delta through two separate desktop/SSE
   subscription cycles also leaves the part and list references unchanged.
4. an upstream source without reconnect-stable delta identity takes the
   at-least-once recovery path and declares the degraded eventual-reconciliation
   contract after reconnect.
5. a buffered delta already included by a fenced snapshot is not appended a
   second time when the subscription buffer is released.
6. a delta produced after the fenced snapshot cursor is applied after the
   snapshot and is not lost.
7. the same opaque event ID in different workspace/session/part scopes applies
   once in each scope rather than suppressing a legitimate delta.
8. cleanup after a terminal authoritative snapshot, part deletion/revert, or a
   known cursor fence bounds opaque-ID state without weakening the replay rule
   during a normal reconnect window.

For each implemented step, run the focused context/component tests, then:

```powershell
pnpm --dir packages/app typecheck
git diff --check
```

Do not mark this plan done until a manually controlled `pnpm dev` trace proves
the expected remaining bottleneck and confirms transcript/focus behavior. Do
not use Tauri Pilot for that trace.
