---
title: Transcript Message Identity Stabilization Plan
date: 2026-07-18
status: proposed
done: false
scope: app-only Solid transcript projection and dev-trace validation
---

# Transcript Message Identity Stabilization Plan

## Problem

The latest manually operated `pnpm dev` trace shows a semantic-identity
failure in the session transcript path, not an inference, model-selection, or
managed-config failure.

Baseline: the manual trace recorded at `2026-07-18T13:47:11Z` through
`2026-07-18T13:47:57Z` contains 206 `MessageList.messageBlocks` recomputations.
The 199 recomputations emitted after the identity diagnostic was loaded all
received a new `messages` array identity. The visible message-block model
changed only 20 times (17 were legitimate streaming deltas). The mutation
observer also saw real DOM work rather than its own diagnostic marker: 60
batches, including repeated batches that removed nine nodes and added three
while the message display revision did not advance.

The trace narrows the mechanism to this allocation chain:

```text
session store messages memo
  -> list.map(MessageWithParts)                  new wrappers + array
  -> app visibleMessages().filter(...)           new array
  -> transcript viewport [...messages]           new array
  -> MessageList sees a new messages prop
  -> block memo and nested row JSX re-evaluate
```

The relevant current owners are:

| Owner | Current behavior | Why it amplifies churn |
| --- | --- | --- |
| `packages/app/src/app/context/session.ts` | `messages` maps every `MessageInfo` to a fresh `MessageWithParts` wrapper. | Any store invalidation gives downstream code a new message-list identity. |
| `packages/app/src/app/context/session-store-model.ts` | `upsertMessageInfo` and `upsertPartInfo` replace an existing entry even when an incoming SSE/snapshot value is semantically equal. | Duplicate or equivalent transport updates invalidate the transcript store. |
| `packages/app/src/app/context/session-transcript-controller.ts` | `setMessagesForSession` sorts and writes each fetched/snapshot array unconditionally. | A duplicate snapshot or an equal terminal recovery can invalidate list and parts despite no transcript delta. |
| `packages/app/src/app/app.tsx` | `visibleMessages` always calls `.filter(...)`, and may insert synthetic errors. | It creates a new result even when no message is filtered, reverted, or augmented. |
| `packages/app/src/app/pages/session-transcript-viewport.ts` | `resolveTranscriptSourceMessages` always clones with `[...messages]`. | It discards a stable upstream array before `MessageList`. |
| `packages/app/src/app/components/session/message-list.tsx` | Correctly treats the received array as a reactive input. | It is the consumer, not the correct first fix owner. |

The diagnosis does **not** mean that all allocation is a bug. A text delta,
part status change, changed command alias, session switch, visibility boundary,
or locally submitted message must still reach the transcript immediately. The
contract is narrower: if the projected display is semantically unchanged, the
same projected array and unchanged per-message view-model identities must be
retained.

## Goals and non-goals

### Goals

1. Preserve `MessageWithParts[]` identity through the normal transcript path
   when its display inputs have not changed.
2. Drop no genuine SSE text/tool/status update and do not delay streaming.
3. Avoid a duplicate transport event or an equal terminal snapshot causing an
   equal transcript to re-render.
4. Keep existing direct `renderedMessages` memo behavior: it is intentionally
   used to avoid an idle/running transcript flash and is not a batching target.
5. Prove the improvement using the existing manual `.tmp` diagnostics.

### Non-goals

- Changing managed AI routing, the selected model, gateway authorization, or
  runtime reload policy.
- Replacing Solid fine-grained reactivity with a global render cache.
- Treating every nested DOM mutation as a defect; a streaming delta may update
  a text node or a tool/timeline row.
- Removing terminal transcript hydration or optimistic-message handoff.

## Invariants

For a selected session whose displayed messages, aliases, visibility boundary,
and local echo are unchanged:

1. `sessionStore.messages()` returns the same array reference.
2. `visibleMessages()` returns that same reference when it applies no filter or
   synthetic insertion.
3. `resolveTranscriptSourceMessages()` returns that same reference when there
   is no local echo.
4. `resolveRenderedTranscriptMessages()` returns that same reference when no
   windowing/search operation changes the displayed slice.
5. `MessageList` does not receive a new array identity, so its block memo does
   not run solely because a duplicate store write occurred.

When any display input changes, the smallest affected level changes identity:

- a text/tool part delta changes its owning message projection and outer array;
- a command-display alias changes only its user-message projection;
- a local echo changes only the concatenated source list;
- a visibility boundary changes only the filtered/sliced list;
- a synthetic error changes only the list into which it is inserted.

Snapshot authority is explicit and must not be weakened by this optimization:

- a passive or stale snapshot (`preserveLiveParts: true`) must not erase newer
  live parts;
- an exact-run terminal recovery (`preserveLiveParts: false`) may replace a
  partial live stream with the canonical terminal transcript;
- replaying that same canonical terminal transcript is a no-op;
- a different canonical terminal transcript applies its replacement once.

## Implementation plan

### Phase 1 — make store writes idempotent

**Owners**

- `packages/app/src/app/context/session-store-model.ts`
- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/session-transcript-controller.ts`
- focused tests under `packages/app/src/app/tests/context/`

1. Add pure equality/reconciliation helpers for stored `MessageInfo` and
   `Part` values. The helpers must compare the fields preserved by the store,
   including nested text/tool payload data, without relying on object identity
   or key insertion order.
2. Change `upsertMessageInfo` and `upsertPartInfo` to return the existing list
   instance when an item with the same ID is semantically unchanged. Preserve
   ordering behavior for a genuine update or a new item.
3. Make `setMessagesForSession` reconcile the sorted message list and each
   message's sorted parts against the current store before writing. Do not call
   a store setter for an equal list.
4. Keep `message.part.updated` delta append behavior intact. It must compare the
   resolved resulting part, not the incoming delta string alone, because a
   retried delta may already be present.
5. Keep `onTranscriptObserved` **event-level**. A duplicate SSE event still
   proves that the live stream was observed and must advance the non-reactive
   observation barrier used by offline/fallback recovery. It must be explicitly
   separate from the semantic-store-write decision.
6. Emit a development-only, content-free trace at the writer boundary with
   `source` (`sse`, `snapshot`, `history`), changed message/part count, and
   `skippedEqualWriteCount`. This is an aggregate event, not one IPC call per
   token.

**Acceptance**

- Replaying the identical `message.updated`, `message.part.updated`, or
  transcript snapshot leaves the corresponding store arrays untouched.
- A different text delta, tool state, or message metadata update is retained.
- A passive/stale snapshot cannot erase newer live parts.
- An equal exact-run terminal snapshot is a no-op; a different canonical
  terminal snapshot replaces partial live parts exactly once.
- A duplicate SSE event still advances `transcriptObservationVersion`, even
  when its store write is skipped; the fallback/recovery barrier remains live.

### Phase 2 — retain the session-level projection

**Owners**

- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/context/session-store-model.ts`
- tests under `packages/app/src/app/tests/context/`

1. Extract a pure `reconcileMessageProjection` helper. Its input is the stored
   message list, the parts-by-message map, and command-display aliases; its
   output reuses the prior `MessageWithParts` entry when that message's info,
   part list, and effective alias are unchanged.
2. Have the `messages` memo use that helper and return the previous outer array
   when every projected entry is reused in the same order.
3. Preserve the existing alias behavior from `applyCommandDisplayAlias`; cache
   its derived text part/wrapper by `(info, parts, alias)` rather than creating a
   fresh alias projection on every unrelated store invalidation.
4. Do not use a blanket deep-equality check inside the render path. Equality is
   decided at writer time and by bounded reference-based projection descriptors.

**Acceptance**

- An unrelated session's store update does not replace the selected session's
  projected message array.
- A selected assistant text delta replaces only the relevant projected entry and
  outer array.
- A command alias update changes the affected user message once and remains
  stable afterwards.

### Phase 3 — make visible and viewport projections identity-preserving

**Owners**

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/pages/session-transcript-viewport.ts`
- optionally a new pure helper next to the viewport or under
  `packages/app/src/app/context/`; do not add policy to `MessageList`.
- tests under `packages/app/src/app/tests/pages/` and
  `packages/app/src/app/tests/context/`

1. Extract `visibleMessages` selection into a pure resolver. If no synthetic
   session error exists, no synthetic-error prefix is present, and no revert
   boundary applies, return the incoming array unchanged instead of calling
   `.filter(...)`.
2. When a filter, revert, or synthetic insertion is necessary, return a new
   array only if its ordered message identities differ from the previous result.
3. Add a small synthetic-error projection cache keyed by stable error-turn ID,
   session ID, anchor ID, timestamp, and text. It must reuse a synthetic
   `MessageWithParts` wrapper when that error turn is unchanged, and reuse the
   outer visible array when the base list and ordered synthetic entries are
   unchanged. Do not exempt synthetic errors from the identity guarantee.
4. Change `resolveTranscriptSourceMessages` to return `messages` directly when
   `localSubmittedMessage` is absent. Allocate only for the local-echo append.
5. Change `resolveRenderedTranscriptMessages` to return its source array
   directly when search/windowing does not remove any element. Allocate only for
   `slice` or a changed visibility window.
6. Keep `effectiveRenderedMessages = renderedMessages`; do not re-enable the
   currently deferred stream render batch experiment as part of this fix.

**Acceptance**

- Idle loaded session: `visibleMessages`, source messages, and rendered messages
  are reference-equal to the base projection.
- A displayed, unchanged synthetic error retains both its message wrapper and
  the outer visible list identity across unrelated invalidations.
- Local echo, search, history reveal, and revert retain their current contents
  and intentionally obtain a different list when required.
- The session-switch handoff still holds and releases its old displayed
  messages correctly.

### Phase 4 — validate the consumer and diagnostics

**Owners**

- `packages/app/src/app/components/session/message-list.tsx`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/scripts/analyze-ui-effect-trace.mjs`
- focused tests beside existing session UI diagnostics

1. Retain the current `messageArrayIdentityRevision`, `displayRevision`, and
   `streamPartRevision` fields. Add the writer/source revision from Phases 1–3
   to the same marker payload so a downstream reference change is attributable
   to `sse`, `snapshot`, `local-echo`, `visibility`, or `unattributed`.
2. Extend the local analyzer to rank equal-display commits by source revision;
   it must distinguish an expected streaming revision from an equal writer
   replay.
3. Keep the mutation observer's diagnostic-node exclusion. It remains a
   validation signal, never a guessed source of causality.

**Acceptance**

- A repeated equal source revision cannot be reported as a legitimate streaming
  delta.
- A DOM batch sharing a changed `streamPartRevision` is classified as expected.
- Focus diagnostics remain local until an actual incident; this work must not
  add per-token Tauri IPC.

## Regression coverage

Add or extend targeted tests for:

1. equal message and part upserts return the original array; changed text/tool
   payloads return a new array;
2. a passive/stale snapshot preserves newer live parts; the same exact-run
   terminal snapshot does not replace store lists; and a different canonical
   terminal snapshot replaces partial live parts exactly once;
3. `reconcileMessageProjection` preserves individual entries and its outer list
   for equal descriptors;
4. an alias update, local echo, unchanged synthetic error, changed synthetic
   error, revert, search, and window slice each deliberately preserve or change
   identity according to their visible output;
5. viewport source/rendered resolver returns its source instance in the no-op
   branch;
6. marker payload reports a stable `messageArrayIdentityRevision` after a
   duplicate event and advancing `streamPartRevision` for a real text delta.
7. duplicate SSE events advance the event-level transcript observation barrier
   without replacing the semantic store projection.

Run the focused suites plus:

```powershell
pnpm --dir packages/app typecheck
git diff --check
```

## Manual verification

Use a fresh manually controlled `pnpm dev` run; do not use Tauri Pilot or mix
multiple scenarios.

1. Enable the existing session UI trace and run one short streaming prompt.
2. Leave the completed session idle for ten seconds.
3. Trigger one terminal transcript hydration/recovery if available.
4. Inspect `.tmp/send-workflow-trace.ui.ndjson` with the local analyzer.

Expected result:

- `messageArrayIdentityRevision` advances for real message/part/visibility
  changes, not for repeated equal source events;
- equal `displayRevision`/`streamPartRevision` markers no longer form long
  bursts of new array identities and DOM replacement batches;
- normal streaming text updates still advance `streamPartRevision` and render;
- no focus/draft incident is introduced.

## Rollout order

1. Land Phase 1 with its pure tests first; it protects every consumer.
2. Land Phase 2 projection caching next; this is the highest-leverage UI change.
3. Land Phase 3 no-op identity paths separately, because they are easy to test
   and easy to revert.
4. Run the manual trace only after all three are present, then adjust Phase 4
   diagnostics or make a narrowly evidenced row-level fix.

Do not mark this plan complete merely because allocation counts fall. It is
complete only when the trace proves that unchanged transcript state preserves
identity while real streaming and recovery updates remain visible.
