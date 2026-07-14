# Session UI Mutation Trace Deep Audit

Date: 2026-07-13

## Scope

This is a read-only audit of the newest manual dev-runtime run and the code
which produces and renders its session UI trace. No Tauri Pilot scenario was
started for this audit.

Evidence inspected:

- `.tmp/send-workflow-trace.ui.ndjson`, written from
  `2026-07-13T16:38:06.598Z` through `2026-07-13T16:38:40.639Z`;
- matching server and orchestrator traces in `.tmp`;
- `packages/app/src/app/pages/session.tsx`;
- `packages/app/src/app/components/session/message-list.tsx` and
  `progress-grouping-model.ts`;
- the focused grouping, session-page, dev-script tests.

The run contains two successful sends against one workspace/session. It is a
good sample for the suspected transcript churn, but it is not a statistically
representative performance benchmark.

## Verdict

There is no evidence here of the originally suspected session-runtime state
regression (for example a visible run indicator bouncing from active to idle
and back). Both sends completed normally.

There *is* a real, high-confidence transcript rendering issue in the
non-virtualized `MessageList` path: every `messageBlocks()` recomputation
returns fresh block objects and the surrounding Solid `<For>` reconciles those
objects by value identity. Consequently it cannot retain the semantic message
or progress row even when the stable `messageId`/`progress-group.id` is the
same. The trace shows repeated remove/add pairs exactly on that container.

The new diagnostic is useful for detecting that churn, but it currently adds
far too much no-op state logging and reports only a stale/latest marker, not a
causal render source, in this run. Those are diagnostics defects, not
user-facing session lifecycle defects.

Recommended direction: make the diagnostic truthful and quiet first, then add
a small semantic-keyed block-row boundary for the regular (non-virtualized)
list. Do not replace the list with `<Index>` as a shortcut.

## Runtime Evidence

### Send and lifecycle behaviour: healthy

The UI, server, and orchestrator traces contain no event with a terminal
`error`, `failed`, `rejected`, or `timeout` status:

| Channel | Rows | Terminal error rows |
| --- | ---: | ---: |
| UI | 596 | 0 |
| Server | 109 | 0 |
| Orchestrator | 61 | 0 |

The first send starts at `16:38:10.519Z`, is admitted at `16:38:14.737Z`,
returns `submitted`, resets only after the active session becomes idle at
`16:38:29.421Z`, then receives a `completed` terminal event. The second send
follows the same sequence between `16:38:36.772Z` and `16:38:39.982Z`.

For each active interval, `runIndicatorVisible` remains true and `runPhase`
remains `responding` until the terminal idle/reset pair. The trace therefore
does not support an `active -> inactive -> active` UI-bounce finding.

The single startup `502`/`degraded` record is explicitly labelled
`boot-warmup`; native runtime preparation immediately follows and the engine
becomes ready before the first send. It is not a send failure.

### DOM churn: confirmed

The UI trace has 84 animation-frame mutation batches:

| Metric | Value |
| --- | ---: |
| Mutation records | 1,287 |
| `childList` records | 1,267 |
| Attribute records | 20 |
| Added nodes | 509 |
| Removed nodes | 769 |
| Batches naming `div.space-y-4` | 80 of 84 |

The largest batches are pure replacement patterns on the transcript list:

| Time (UTC) | Records | Added / removed | Primary target |
| --- | ---: | ---: | --- |
| `16:38:31.779Z` | 216 | 108 / 108 | `div.space-y-4` |
| `16:38:33.757Z` | 204 | 102 / 102 | `div.space-y-4` |
| `16:38:37.654Z` | 108 | 36 / 72 | `div.space-y-4`, `span` |

This is materially more than text-node streaming alone. It shows rows and
their descendants being removed and reinserted. It does **not** prove that all
of `SessionView` is re-rendering: Solid uses fine-grained DOM updates, and the
observer reports concrete DOM writes rather than component renders.

### State trace is noisy rather than unstable

Of 323 `session-ui:state-change` records, 297 have an empty
`changedFields` array. Only 26 represent a visible state-tuple transition.

The callback can legitimately rerun when an upstream reference changes while
the sampled scalars do not (for example a new messages array with the same
length). But writing an event with no changed field makes the trace 11.4 times
larger than its useful state-transition set and obscures the real sequence.

This is a trace-quality bug. It is not evidence that the session state itself
changed 323 times.

## Source Analysis

### F1 — Non-virtualized message rows lose semantic identity

**Status:** confirmed

**Severity:** P1 for UI smoothness; no data/lifecycle correctness impact found

`messageBlocks()` calls `buildProgressRenderBlocks()` on each recomputation
(`message-list.tsx`, around lines 623–695). The builder allocates a new block
object for every message and progress group, as well as new nested arrays
(`progress-grouping-model.ts`, `messageBlock`, `progressGroupFromEntries`, and
`buildProgressRenderBlocks`).

This allocation is not isolated to the grouping model. The session facade maps
the whole selected message list into fresh `MessageWithParts` wrappers
(`context/session.ts`, around lines 936–944), including when no command alias
is applied; `applyCommandDisplayAlias` still returns `{ info, parts }`. The
transcript viewport also clones its source array on every projection
(`session-transcript-viewport.ts`, around lines 81–97). These are current
view-model contracts, not evidence of a broken store or transcript-recovery
owner. F1 must therefore separate DOM identity from all upstream view-model
object identities.

The normal-size transcript path renders those objects directly:

```tsx
<For each={messageBlocks()}>{(block, blockIndex) => renderBlock(block, blockIndex())}</For>
```

(`message-list.tsx`, around lines 1677–1691).

Solid's [`<For>`](https://docs.solidjs.com/reference/components/for) maps its
list by item value identity. A freshly allocated object therefore is not the
previous item, even if `block.messageId` or `block.id` has the same string
value. The current non-virtualized loop does not pass its semantic identifiers
into the reconciliation boundary.

The virtualized path already has the right *shape* of solution in `getItemKey`,
but its current progress key is also unstable:

```ts
progress-${block.messageIds.join(",")}
```

It changes when the progress group gains another message id. That key is not
used by either regular-list fallback either. The latest run has only a few
messages, so it necessarily exercised the regular path and its
`div.space-y-4` container; the virtual path still needs the same correction.

The grouping test already proves that a progress-group `id` is stable when the
turn grows. The rendering code simply does not consume that stable identity.

#### KISS fix

1. Add one exported semantic `progressRenderBlockKey(block)` helper in the
   grouping model. Its preferred values are `message:${messageId}` and
   `progress:${id}`. The collection-level caller must explicitly disambiguate
   missing or duplicate preferred keys with an unstable local fallback such as
   `unstable:${kind}:${index}`. It must not throw or make incomplete transcript
   data unrenderable.
2. Derive one current keyed collection from `messageBlocks()`: each entry has a
   unique primitive key and its current block. Render `<For>` over the primitive
   keys, then have `MessageBlockRow` resolve both `block()` and `index()` from
   current accessors. A JSX `key` attribute or a wrapper that calls the current
   `renderBlock(block, index)` once is insufficient: the former does not change
   Solid's `<For>` identity contract and the latter either retains stale block
   data or recreates its subtree.
3. Use the same disambiguated key collection in both regular fallbacks and in
   the virtualizer's `getItemKey`. In particular, use `progress:${block.id}`
   rather than the growing `messageIds` list.

Do **not** switch the current loop blindly to
[`<Index>`](https://docs.solidjs.com/reference/components/index-component).
`<Index>` preserves positions, not semantic items. This transcript can
insert/remove a progress group as an assistant turn evolves, so position
retention could attach local row state or DOM to a different message kind.

The boundary must be a small `MessageBlockRow`/accessor extraction, not an
attempt to cache mutable `ProgressRenderBlock` objects globally. Caching the
old object would make `renderBlock` retain stale `parts`, groups, and markdown
content.

#### Required verification

**Decision: do not add a DOM-test harness in this slice.** The repository has
no jsdom, happy-dom, or Solid component-test runtime. Adding one just to assert
node object retention is a separate infrastructure change and would be larger
than this correction. Use the existing pure Node test surface plus the manual
dev-runtime trace instead.

- Unit-test identical semantic inputs across two builder calls: blocks may be
  new objects, but their preferred semantic keys must remain equal.
- Unit-test a growing progress group: its key must stay `progress:${id}` even
  though `messageIds` changes. Test the same key source used by the virtualizer.
- Unit-test missing and duplicate message/progress ids: the collection helper
  returns distinct, explicit unstable fallbacks and the builder remains
  renderable.
- Cover a progress-group gaining an item and a following final-answer message
  being added. The key model must preserve existing keys and allocate only the
  actual new key.
- Re-run the same two-send dev flow. Inspect only batches whose complete
  `targets` array is `["div.space-y-4"]`; the current observer has aggregate
  counts and cannot attribute a mixed-target batch to the list. The baseline
  has 52 such batches, including `+108/-108` and `+102/-102` replacements.
- The slice passes when an unchanged outer transcript does not produce another
  sole-target replacement storm (equal add/remove counts of at least 50). True
  insertion/removal, mixed-target batches, and later nested-row mutations are
  not failures for F1.

### F2 — State-change tracing records no-op checkpoints

**Status:** confirmed

**Severity:** P2 observability noise

`SessionView` computes `changedFields` from a compact state tuple and always
writes `session-ui:state-change` afterward (`session.tsx`, around lines
2162–2232). It has no guard for `previous` plus an empty result.

#### KISS fix

After calculating `changedFields`, return when `previous` exists and the array
is empty. Keep the initial full-state event. That preserves every state change
represented by the trace contract and removes 297 of the 323 events in this
sample.

This is deliberately trace I/O hygiene only. The reactive callback will still
rerun when an upstream dependency changes; F2 neither claims nor attempts to
remove that work or the transcript DOM churn.

The test should assert both the initial event and the no-op guard; a source
regex that only checks that `recordSendTrace` exists is insufficient.

### F3 — `latestRenderSource` is not causal and is stale when Developer Mode is off

**Status:** confirmed trace-causality gap in this run

**Severity:** P2 diagnostic correctness and causality gap

All 84 DOM batches say:

```text
latestRenderSource=SessionView.initialRender
latestRenderReason=component-created
```

and there are zero `session-ui:render-source-mark` events. This is not because
the flow has no source markers. `SessionConversationFlow` marks immediate send,
materialization, and acceptance; `SessionQueueDrainController` marks a selected
session change.

The marker function in `session.tsx` returns before making a snapshot unless
`props.developerMode` is true. The MutationObserver instead follows the Vite
dev trace flag. The manual dev launcher sets that Vite flag to `1`, but this run
did not have application Developer Mode enabled. The observer therefore ran
while all flow markers were suppressed, and the separate metadata effect
intentionally retained the original `source`/`reason` fields.

Changing that gate is necessary but not sufficient. Existing markers originate
from the conversation flow and queue controller; they do not mark an SSE part
update, terminal transcript hydration, or `messageBlocks()` recomputation. A
newly enabled `...accepted` marker could still predate a later DOM batch by
seconds. It would be a **latest flow marker**, not proof of what performed the
DOM write.

#### KISS fix

1. Define one `sessionUiDiagnosticEnabled()` guard:
   `props.developerMode || sessionUiMutationTraceEnabled()`. Apply it to every
   diagnostic write: the initial snapshot, `markTempRuntimeUiRenderSource`, and
   both metadata effects which currently call `setTempRuntimeUiRenderSource`
   without a guard. Use a static inert initial value when disabled. This makes
   the diagnostic dev-only rather than merely hiding its badge in production.
   The badge remains gated by `props.developerMode`.
2. Pass one dev-trace-only callback from `SessionView` to `MessageList` and
   call it directly inside `messageBlocks()` after the blocks and their stable
   keys are derived. Mark it as `MessageList.messageBlocks` with a monotonic
   revision, time, message count, block count, and add/change/remove summary.
   Call the callback through `untrack` so reading the parent snapshot cannot
   become another dependency of `messageBlocks()`.
3. Rename the DOM fields from `latestRenderSource`/`latestRenderReason` to
   `latestUiMarker`/`latestUiMarkerAt` and include its revision and age. Treat
   that as temporal correlation only. A batch with no nearby message-block
   marker remains `unknown`; it must not be attributed to an old flow marker.

This distinguishes a direct render-boundary event (`MessageList.messageBlocks`)
from an upstream trigger (such as an SSE part update). It does not claim that a
MutationObserver can prove which JavaScript function caused every individual
node mutation.

Focused tests should cover the Developer-Mode-off trace gate and the pure
message-block marker payload. The fresh manual trace is the required proof that
the marker precedes the observed regular-list batches.

### F4 — Nested progress and text rows can still churn after F1

**Status:** confirmed and deliberately deferred

The expanded progress block has another identity-based `<For>` over freshly
derived `items()` (`message-list.tsx`, around line 1225). Regular message rows
also derive `textGroups()` with `filter()` and render it through another
identity-based `<For>` (around lines 1494 and 1592). The grouping model creates
fresh arrays/groups, so F1 cannot promise zero DOM mutations after the outer
row boundary is stable.

Do not broaden the first slice into nested keying or markdown/part caching.
After F1, use the sole-target outer-list trace criterion first. Only if that
passes while the remaining user-visible churn is material should nested progress
or text group identity become a separate decision.

### F5 — Test coverage proves source shape, not DOM identity or trace truth

**Status:** confirmed verification gap

The focused suite is green, but its limits are clear:

- `progress-grouping-model.test.ts` verifies grouping semantics and stable
  progress ids, not list-node retention;
- `message-list-hybrid-timeline.test.ts` is source-structure based;
- `session-inline-loading.test.ts` checks that an observer and three trace
  calls exist, but not that no-op records are suppressed or causal marker
  fields are valid in the common Dev-mode-off configuration;
- dev-script tests check environment wiring statically, not runtime DOM
  mutation behaviour.

This is why the suite passed while the trace still exposed the identity churn
and stale source label.

## Deferred Items

The evidence does not justify these changes now:

- global `SessionView` decomposition or memoization sweep;
- trace batching beyond the existing animation-frame batch;
- changing `updatedAt`/timeline state identity maps;
- changing the session lifecycle, durable ingest, or run-state ownership;
- nested progress/text-row keying or markdown/part caching before the outer-row
  result is measured;
- making MutationObserver a production feature.

The observer already excludes sidebars by observing only
`data-testid="session-center-pane"`, batches into one record per animation
frame, and is gated to a Vite dev build plus an explicit environment flag.

## Implementation Order

1. **Diagnostic guard and trace hygiene:** introduce one shared dev-only
   diagnostic guard for the initial snapshot, marker, and both metadata effects;
   add the F2 no-op trace-write guard.
2. **Trace meaning:** distinguish flow markers from the direct
   `MessageList.messageBlocks` marker, and record honest latest-marker fields.
3. **Row identity:** introduce semantic keys for both regular fallbacks and the
   virtualizer; `MessageBlockRow` receives current `block()` and `index()`
   accessors rather than one captured view-model object.
4. **Fallback policy:** make missing/duplicate semantic ids render through a
   distinct unstable local fallback, never through a thrown error or duplicate
   key.
5. **Verification:** run pure key-model tests and the manual two-send trace.
   Apply the sole-target `div.space-y-4` replacement-storm criterion only; do
   not require zero DOM mutations.
6. Revisit nested progress/text or markdown churn only if the post-F1 trace
   still shows material user-visible churn.

## Verification Performed

### Implementation checkpoint (2026-07-13)

Implemented the narrow first slice described above:

- F2 now skips a state-trace record when an already-initialized checkpoint has
  no changed fields. This reduces trace I/O only; it does not claim to reduce
  reactive reruns.
- F3 has one shared diagnostic gate for the initial snapshot, flow marker, and
  both metadata snapshots. The explicit mutation-trace flag can enable the
  diagnostic without Developer Mode, while production receives an inert
  snapshot and no trace callback. `MessageList.messageBlocks` now emits the
  direct, revisioned render-boundary marker through `untrack`; MutationObserver
  batches retain only an honest latest-marker correlation.
- F1 derives primitive semantic keys for regular and virtual transcript rows.
  Retained rows read the current block and index through accessors, so a fresh
  grouping-model object does not itself replace the outer row. Missing or
  duplicate ids receive an explicit unstable local key instead of throwing or
  sharing a key.

The intentionally deferred nested progress/text row churn remains outside this
slice. A fresh manual two-send dev trace is still required to prove the
sole-target outer-list replacement storm is gone; no Tauri Pilot was run.

```powershell
pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm `
  src/app/tests/components/session/progress-grouping-model.test.ts `
  src/app/tests/components/session/message-list-hybrid-timeline.test.ts `
  src/app/tests/pages/session-inline-loading.test.ts
# 47 passed

pnpm --filter @neatech/veslo-ui typecheck
# passed

git diff --check -- <changed app and audit paths>
# passed; only existing LF/CRLF working-tree warnings
```

These checks establish the source and type contract. They do not substitute
for the required manual DOM-retention trace.
