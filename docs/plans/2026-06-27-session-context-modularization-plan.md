---
title: Session Context Modularization Implementation Plan
date: 2026-06-27
target: packages/app/src/app/context/session.ts
done: true
---

# Session Context Modularization Implementation Plan

## Goal

Reduce `packages/app/src/app/context/session.ts` from a 2,983-line runtime store monolith into a
small public `createSessionStore` facade plus a few durable context-level modules. Keep the public
`createSessionStore` options and return shape stable in the first pass so `app.tsx`,
`state/sessions.ts`, and existing page code do not need broad rewiring.

The final `done: true` value is allowed only after every phase below has its own `done: true`, the
progress log names the test written or updated first, and the focused context/session checks plus
typecheck pass.

## Deep Audit Snapshot

Current risk profile for `context/session.ts`:

- 2,983 lines, roughly 117 KB.
- Public exports are small, but the internal closure owns many unrelated domains:
  - session list loading and directory filtering
  - selected-session transcript loading and offline fallback
  - transcript hydration, live ingest, background ingest, and deletion tracking
  - permission/question refresh, reply routing, active prompt selection, and per-workspace prompt
    aggregation
  - SSE subscription setup, coalescing, reconnect backoff, outage catch-up, and event application
  - command display aliasing
  - reload detection, invalid-tool handling, Chrome MCP error surfacing, synthetic-continue
    diagnostics
  - workspace session snapshot save/load/eviction
  - scoped session status and workspace busy notification
- The highest-risk region is the SSE/event pipeline:
  `applyBackgroundWorkspaceEvent`, `applyEvent`, `setupSseStream`, and reconnect catch-up span
  roughly lines 2028-2831 and mutate nearly every store surface.
- Transcript state is a shared dependency between `selectSession`, `loadEarlierMessages`, active SSE
  events, background SSE events, reconnect catch-up, and workspace snapshots.
- Several tests still read `context/session.ts` source directly. Those tests should be retargeted to
  the extracted modules as each behavior moves.

Existing adjacent modules that should be kept and reused:

- `packages/app/src/app/context/select-session-guard.ts`
- `packages/app/src/app/context/session-reconnect.ts`
- `packages/app/src/app/context/workspace-session-snapshots.ts`
- `packages/app/src/app/context/workspace-routing.ts`
- `packages/app/src/app/lib/scoped-session-status.ts`

## Non-Goals

- Do not change the public `createSessionStore` options or returned store API in the first pass.
- Do not move `createSessionAndOpen` from `app.tsx` in this plan; it is adjacent but belongs to app
  send/session-creation orchestration.
- Do not split into tiny helper files such as one file per regex, one file per setter, or one file
  per event type.
- Do not rewrite the store to classes. Use controller/factory modules with explicit dependencies,
  matching existing local patterns.
- Do not change routing, offline transcript, or SSE semantics while extracting.
- Do not weaken source-contract tests just because code moved. Convert them to behavior/module
  assertions.

## Module Size Rule

Create a module only when it owns a durable runtime boundary and enough state to justify the file.

Target module size guidance:

- Controllers should usually be larger than roughly 150 lines.
- Pure model modules can be smaller only when they replace brittle source-contract tests with clear
  behavior tests.
- Prefer one coherent controller over several small utility modules.

## Planned Module Boundaries

Target structure:

```text
packages/app/src/app/context/session.ts
packages/app/src/app/context/session-store-model.ts
packages/app/src/app/context/session-transcript-controller.ts
packages/app/src/app/context/session-runtime-prompts.ts
packages/app/src/app/context/session-selection-controller.ts
packages/app/src/app/context/session-event-stream.ts
packages/app/src/app/context/session-workspace-cache.ts
```

Expected ownership:

- `session.ts`: public `createSessionStore`, Solid store creation, controller composition, facade
  return shape, and dependency wiring.
- `session-store-model.ts`: pure session/message/part sorting, upsert/remove helpers, command
  display alias projection, placeholder message creation, and session error turn de-duplication.
- `session-transcript-controller.ts`: selected transcript read/write primitives, transcript snapshot
  hydration, message limit/completion/load state, live transcript ingest, background transcript ingest,
  and pending deletion tracking.
- `session-runtime-prompts.ts`: per-workspace permission/question refresh, stale route release,
  reply/reject routing, active permission/question selection, busy flags, and aggregate counts.
- `session-selection-controller.ts`: session list loading, directory override filtering, selected
  session loading, offline fallback policy, todo fetch after transcript load, and `renameSession`.
- `session-event-stream.ts`: active/background event application, SSE fan-out, event coalescing,
  reconnect backoff, outage catch-up, reload/tool-error side effects, debug event compaction, and
  workspace busy/status notifications.
- `session-workspace-cache.ts`: workspace snapshot save/load/clear, snapshot record filtering, selected
  session validation, cache eviction, and workspace session id restoration.

## Test-First Rule

Before each extraction:

1. Add or update the behavior test that captures the expected contract.
2. Run the focused test and record the failing result in the progress log when a new module does not
   exist yet.
3. Extract the module.
4. Run the same focused test again.
5. Run the broader phase verification set.
6. Only then change the phase from `done: false` to `done: true`.

## Baseline Verification Set

Focused context/session checks:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Broader app checks to add once the event stream or selection controller moves:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/session-route-client-resume.test.ts src/app/tests/pages/session-navigation.test.ts
```

## Phase 0: Baseline Guardrails

done: true

Purpose:

- Freeze current behavior contracts before moving code.
- Inventory source-contract tests that read `context/session.ts`.
- Add one modularization contract test that rejects replacing this monolith with many tiny files.

Target files:

- `packages/app/src/app/context/session.ts`
- New test: `packages/app/src/app/tests/context/session-context-modularization.test.ts`
- Existing source-contract tests under `packages/app/src/app/tests/context/`

Tasks:

- id: P0.1
  done: true
  task: Inventory every test that reads `context/session.ts` directly and classify it as behavior,
    wiring, or brittle source placement coverage.
- id: P0.2
  done: true
  task: Add `session-context-modularization.test.ts` with planned module names, minimum module size
    expectations, and a rule that modules must not import `context/session.ts`.
- id: P0.3
  done: true
  task: Run the baseline verification set before extraction.

Current status:

- done: true
- Added `packages/app/src/app/tests/context/session-context-modularization.test.ts`.
- Test-first result recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts`
  initially failed because the direct source-reader inventory included the new guardrail test itself.
- Fixed the inventory to exclude the guardrail test while retaining all legacy direct readers.
- Baseline verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts`
  passed with 40 tests.
- Baseline verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Baseline verification passed: `git diff --check`

## Phase 1: Store Model And Pure Mutators

done: true

Purpose:

Move pure list/message/part helpers first. This lowers closure size with low runtime risk and gives
later controllers stable primitives.

Target module:

- `packages/app/src/app/context/session-store-model.ts`

Behavior to own:

- Session sorting and upsert/remove.
- Message sorting and upsert/remove.
- Part sorting and upsert/remove.
- Placeholder assistant message creation for streamed parts.
- Slash command display formatting and alias projection for user messages.
- Session error turn de-duplication model.

Test first:

- Add `packages/app/src/app/tests/context/session-store-model.test.ts`.
- Convert `session-command-display.test.ts` away from source placement once model helpers exist.

Required test cases:

- id: P1.T1
  done: true
  task: Session and message upserts preserve deterministic activity ordering.
- id: P1.T2
  done: true
  task: Part upserts preserve deterministic id ordering.
- id: P1.T3
  done: true
  task: Command display alias replaces only the first user text part and preserves non-text parts.
- id: P1.T4
  done: true
  task: Session error turns de-dupe identical text at the same message boundary.

Implementation tasks:

- id: P1.1
  done: true
  task: Extract pure helpers without changing `createSessionStore` return shape.
- id: P1.2
  done: true
  task: Replace local helper definitions in `session.ts` with imports from the model module.
- id: P1.3
  done: true
  task: Retarget source-contract tests to the model module where applicable.

Current status:

- done: true
- Test-first failure recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-store-model.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` before `session-store-model.ts` existed.
- Added `packages/app/src/app/context/session-store-model.ts` for pure session/message/part sorting,
  upsert/remove helpers, placeholder assistant messages, command display formatting/projection, and
  session error turn de-duplication.
- `context/session.ts` now imports those pure helpers and keeps only store-specific wrappers for
  Solid state mutation.
- Retargeted `packages/app/src/app/tests/context/session-command-display.test.ts` from a
  `context/session.ts` source-contract test to a model behavior test.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-context-modularization.test.ts`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts`
  passed with 45 tests.
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed: `git diff --check` with LF-to-CRLF warnings only.

## Phase 2: Transcript Controller

done: true

Purpose:

Create a single transcript controller before moving selection or SSE. Transcript state is the shared
dependency between selection, live events, background events, reconnect catch-up, and snapshots.

Target module:

- `packages/app/src/app/context/session-transcript-controller.ts`

Behavior to own:

- `setMessagesForSession`.
- `hydrateTranscriptSnapshot`.
- Warm transcript reads and message count reads.
- Transcript freshness reads.
- Message limit/completion/load state.
- `loadEarlierMessages` transcript fetch branch if the controller can receive read-policy and client
  dependencies without pulling selection concerns into the module.
- Live transcript ingest scheduling, immediate flush, in-flight serialization, deletion tracking, and
  background transcript ingest from explicit source workspace client.

Test first:

- Add `packages/app/src/app/tests/context/session-transcript-controller.test.ts`.
- Convert `session-transcript-hydration.test.ts` source assertions about live ingest into module or
  behavior assertions.

Required test cases:

- id: P2.T1
  done: true
  task: Hydration ignores unavailable snapshots and older stale snapshots.
- id: P2.T2
  done: true
  task: Hydration does not replace a longer already-warm transcript with a shorter snapshot.
- id: P2.T3
  done: true
  task: Message and part deletion events are carried into the next transcript ingest payload and
    cleared only after successful write.
- id: P2.T4
  done: true
  task: Background transcript ingestion reads session and messages from the explicit source workspace
    client, not the active client.
- id: P2.T5
  done: true
  task: Ingest timers are cleared on controller cleanup.

Implementation tasks:

- id: P2.1
  done: true
  task: Extract transcript signals and ingest maps into one controller.
- id: P2.2
  done: true
  task: Keep `session.ts` as the owner of the Solid `store` but delegate transcript operations.
- id: P2.3
  done: true
  task: Replace direct transcript source-contract assertions with controller behavior tests.

Current status:

- done: true
- Test-first failure recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-transcript-controller.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` before `session-transcript-controller.ts` existed.
- Added `packages/app/src/app/context/session-transcript-controller.ts` for transcript message/part
  writes, snapshot hydration, transcript freshness, message limit/completion/load state, live ingest,
  background ingest, deletion tracking, and ingest timer cleanup.
- `context/session.ts` now instantiates `createSessionTranscriptController` and delegates transcript
  operations while preserving the public `createSessionStore` return shape.
- Updated `session-workspace-busy-source.test.ts` so background transcript ingest source coverage
  points to `session-transcript-controller.ts`.
- Updated `session-question-workspace-routing.test.ts` to avoid using the removed local
  `setMessagesForSession` function as a brittle source slice anchor.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/session-context-modularization.test.ts`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts`
  passed with 49 tests.
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed: `git diff --check` with LF-to-CRLF warnings only.

## Phase 3: Runtime Prompts Controller

done: true

Purpose:

Move permission/question orchestration as one module. Permissions and questions share almost the same
per-workspace routing, stale route release, active prompt selection, and reply busy behavior.

Target module:

- `packages/app/src/app/context/session-runtime-prompts.ts`

Behavior to own:

- `pendingPermissionsByWs`, `pendingQuestionsByWs`, aggregate lists, and per-workspace counts.
- `refreshPendingPermissions` and `refreshPendingQuestions`.
- Stale non-active workspace route release on runtime failures.
- Active permission/question selection behavior.
- `respondPermission`, `respondQuestion`, and `rejectQuestion`.
- `permissionReplyBusy` and `questionReplyBusy`.

Test first:

- Add `packages/app/src/app/tests/context/session-runtime-prompts.test.ts`.
- Convert `session-question-workspace-routing.test.ts` and relevant
  `session-routing-runtime.test.ts` source checks into behavior checks.

Required test cases:

- id: P3.T1
  done: true
  task: Refresh probes every runtime-ready routed workspace and mirrors only the active workspace
    list into the legacy store fields.
- id: P3.T2
  done: true
  task: Stale non-active workspace runtime failures release the route, while active workspace
    failures remain visible.
- id: P3.T3
  done: true
  task: Active permission/question returns null while no real session is selected.
- id: P3.T4
  done: true
  task: Question reply and reject route to the owning workspace client.
- id: P3.T5
  done: true
  task: Permission reply routes to the owning workspace client and refreshes after success.

Implementation tasks:

- id: P3.1
  done: true
  task: Extract permission/question signals and methods into one prompts controller.
- id: P3.2
  done: true
  task: Preserve existing returned accessors and methods from `createSessionStore`.
- id: P3.3
  done: true
  task: Retarget source-contract tests to the prompts controller.

Current status:

- done: true
- Test-first failure recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-runtime-prompts.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` before `session-runtime-prompts.ts` existed.
- Added `packages/app/src/app/context/session-runtime-prompts.ts` for per-workspace
  permission/question refresh, stale route release, aggregate prompt accessors, active prompt
  selection, reply/reject routing, and reply busy flags.
- `context/session.ts` now instantiates `createSessionRuntimePrompts` and delegates runtime prompt
  behavior while preserving the public `createSessionStore` return shape.
- Retargeted `packages/app/src/app/tests/context/session-question-workspace-routing.test.ts` from
  `context/session.ts` source slices to `session-runtime-prompts.ts` module contracts.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-context-modularization.test.ts`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts`
  passed with 54 tests.
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed: `git diff --check` with LF-to-CRLF warnings only.

## Phase 4: Session Selection Controller

done: true

Purpose:

Move session list loading and selected-session load orchestration after transcript and prompt
controllers exist. This phase should not own raw transcript mutation or prompt refresh internals; it
should coordinate those controllers.

Target module:

- `packages/app/src/app/context/session-selection-controller.ts`

Behavior to own:

- Directory query path variants and defensive root filtering.
- Session directory override application.
- Conversation reader vs SDK list fallback.
- Retaining the currently selected session when a delayed list response lacks it.
- `renameSession`.
- Selected-session loading, select guard usage, offline fallback, stale selection aborts, todo fetch,
  and completion callback.
- Read policy: browse from DB when runtime is not ready, foreign workspace, or configured browse
  mode.

Test first:

- Add `packages/app/src/app/tests/context/session-selection-controller.test.ts`.
- Keep `session-select-background-hydration.test.ts`, `session-list-roots-regression.test.ts`, and
  `app-session-creation-flow-contract.test.ts` green.

Required test cases:

- id: P4.T1
  done: true
  task: `loadSessions` uses conversation reader when available and falls back to SDK only when needed.
- id: P4.T2
  done: true
  task: `loadSessions` keeps an already selected injected session if a delayed list response misses
    it but the directory still matches.
- id: P4.T3
  done: true
  task: `selectSession` hydrates offline transcript without cold-starting runtime in browse mode.
- id: P4.T4
  done: true
  task: Rapid A-B-A selection does not join stale in-flight loads.
- id: P4.T5
  done: true
  task: Todo and permission refresh stay outside the critical transcript load path.

Implementation tasks:

- id: P4.1
  done: true
  task: Extract session read policy and list filtering into the selection controller.
- id: P4.2
  done: true
  task: Move `selectSession`, `loadSessions`, and `renameSession` behind the controller while keeping
    returned method names stable.
- id: P4.3
  done: true
  task: Retarget remaining source contracts that assert delayed list retention or browse-mode reads.

Current status:

- done: true
- Test-first failure recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-selection-controller.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` before `session-selection-controller.ts` existed.
- Added `packages/app/src/app/context/session-selection-controller.ts` for session list loading,
  selected-session loading, offline transcript fallback, read policy coordination, todo refresh,
  permission refresh scheduling, `loadEarlierMessages`, and `renameSession`.
- `context/session.ts` now instantiates `createSessionSelectionController` and delegates selection
  behavior while preserving returned store method names.
- Retargeted `app-session-creation-flow-contract.test.ts` and `session-list-roots-regression.test.ts`
  from `context/session.ts` placement checks to `session-selection-controller.ts`.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/session-list-roots-regression.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/context/session-context-modularization.test.ts`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts`
  passed with 59 tests.
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed: `git diff --check` with LF-to-CRLF warnings only.

## Phase 5: Event Stream And Event Application Controller

done: true

Purpose:

Move the largest and riskiest domain only after transcript, prompt, and selection dependencies are
clean. This should remove the SSE monolith from `session.ts` without scattering event branches into
many tiny files.

Target module:

- `packages/app/src/app/context/session-event-stream.ts`

Behavior to own:

- Active vs background workspace event routing.
- Known-session filtering.
- Session status updates and workspace busy notifications.
- Active event mutation for session created/updated/deleted, message updated/removed, part
  updated/removed, todo updated, command executed, hot reload applied, and session errors.
- Background event behavior: update scoped status, refresh prompts, and schedule durable transcript
  ingestion without merging background message parts into the active store.
- Reload detection from mutating tools.
- Invalid-tool and Chrome MCP error surfacing.
- Synthetic continue diagnostics.
- Debug event compaction.
- SSE stream creation via `engineSseSubscribe` or SDK fallback.
- Event queue coalescing and flush timing.
- Reconnect backoff, outage notification, and catch-up for running sessions.

Test first:

- Add `packages/app/src/app/tests/context/session-event-stream.test.ts`.
- Convert `session-workspace-busy-source.test.ts`, `session-unread-events.test.ts`, and the SSE
  source assertions in `session-routing-runtime.test.ts` into module or behavior assertions.

Required test cases:

- id: P5.T1
  done: true
  task: Background workspace events update scoped status and schedule background transcript ingest
    without mutating active message/part state.
- id: P5.T2
  done: true
  task: Active `message.updated` accepts only known sessions and reports unread assistant responses
    only after the message is accepted.
- id: P5.T3
  done: true
  task: Active `message.part.updated` creates a placeholder message, appends deltas safely, and
    schedules transcript ingest.
- id: P5.T4
  done: true
  task: Event coalescing replaces repeated status, todo, and part update events before flush.
- id: P5.T5
  done: true
  task: Reconnect catch-up refreshes status, transcript, todos, permissions, and questions for
    sessions that were running during the outage.
- id: P5.T6
  done: true
  task: Stale non-active SSE failures release the route without marking the active stream
    disconnected.

Implementation tasks:

- id: P5.1
  done: true
  task: Extract event application behind a dependency-injected controller API.
- id: P5.2
  done: true
  task: Extract SSE setup/coalescing/reconnect into the same event stream module.
- id: P5.3
  done: true
  task: Keep `createEffect` wiring in `session.ts` if needed, but move target resolution and stream
    setup details into the controller.
- id: P5.4
  done: true
  task: Retarget source-contract tests to event stream behavior/module contracts.

Current status:

- done: true
- Test-first failure recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-event-stream.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` before `session-event-stream.ts` existed.
- Added `packages/app/src/app/context/session-event-stream.ts` as the dependency-injected owner for
  active/background event application, debug compaction, SSE setup, coalescing, reconnect catch-up,
  stale route release, route auth, reload/tool-error side effects, workspace busy/status writes, and
  transcript ingest scheduling.
- `context/session.ts` now delegates stream startup through
  `createSessionEventStreamController(...).startEventStreams()` and keeps the public store facade
  wiring stable.
- Retargeted event/SSE source-contract tests from `context/session.ts` to
  `session-event-stream.ts` where the behavior moved, including unread events, workspace busy,
  route auth/stale route release, transcript ingestion scheduling, boot gating, and reconnect
  catch-up assertions.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-context-modularization.test.ts`
  passed with 18 tests.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/session-route-client-resume.test.ts src/app/tests/pages/session-navigation.test.ts`
  passed with 118 tests.
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Final focused verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/session-list-roots-regression.test.ts`
  passed with 69 tests.
- Verification passed: `git diff --check` with LF-to-CRLF warnings only.

## Phase 6: Workspace Session Cache

done: true

Purpose:

Move workspace snapshot save/load/eviction after transcript and store model extraction, because the
cache needs message limits, transcript freshness, scoped status, and session id restoration.

Target module:

- `packages/app/src/app/context/session-workspace-cache.ts`

Behavior to own:

- `WorkspaceSessionCache` type.
- Snapshot record filtering.
- Selected session validation before saving and after loading.
- Cache eviction through `selectWorkspaceSnapshotEvictions`.
- Save, load, and clear workspace snapshot operations.
- Restoring `workspaceSessionIds` from loaded snapshots.

Test first:

- Add `packages/app/src/app/tests/context/session-workspace-cache.test.ts`.
- Convert source assertions in `workspace-session-snapshots.test.ts` to call the cache module.

Required test cases:

- id: P6.T1
  done: true
  task: Saving a snapshot includes only messages, parts, todos, statuses, and transcript metadata for
    sessions present in that workspace.
- id: P6.T2
  done: true
  task: Saving a snapshot does not preserve a selected session missing from the workspace session list.
- id: P6.T3
  done: true
  task: Loading a snapshot clears stale cross-workspace selection and normalizes the cached selected id.
- id: P6.T4
  done: true
  task: Cache eviction keeps the active/loaded workspace and removes older entries past the limit.

Implementation tasks:

- id: P6.1
  done: true
  task: Extract cache state and save/load helpers into one controller.
- id: P6.2
  done: true
  task: Preserve `saveWorkspaceSnapshot`, `loadWorkspaceSnapshot`, and `clearWorkspaceSnapshot`
    methods on `createSessionStore`.
- id: P6.3
  done: true
  task: Retarget snapshot source-contract tests to the cache module.

Current status:

- done: true
- Test-first failure recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-workspace-cache.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` before `session-workspace-cache.ts` existed.
- Added `packages/app/src/app/context/session-workspace-cache.ts` as the owner for
  `WorkspaceSessionCache`, snapshot record filtering, selected-session validation, save/load/clear
  operations, `workspaceSessionIds` restoration, transcript metadata restoration, and eviction
  through `selectWorkspaceSnapshotEvictions`.
- `context/session.ts` now delegates workspace cache behavior through
  `createSessionWorkspaceCacheController(...)` while preserving the public
  `saveWorkspaceSnapshot`, `loadWorkspaceSnapshot`, and `clearWorkspaceSnapshot` facade methods.
- Retargeted `workspace-session-snapshots.test.ts` source assertions from `context/session.ts` to
  `session-workspace-cache.ts`, and updated the direct `context/session.ts` source-reader inventory.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-context-modularization.test.ts`
  passed with 19 tests.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/session-list-roots-regression.test.ts`
  passed with 72 tests.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/session-route-client-resume.test.ts src/app/tests/pages/session-navigation.test.ts`
  passed with 118 tests.
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed: `git diff --check` with LF-to-CRLF warnings only.

## Phase 7: Facade Cleanup And Documentation

done: true

Purpose:

Close the extraction safely and make future work start at the right context module instead of
regrowing `context/session.ts`.

Target docs:

- `docs/dev/app-map.md`
- `docs/features/session-runtime.md`
- This plan file.

Tasks:

- id: P7.1
  done: true
  task: Remove dead local helpers, maps, and comments from `session.ts` after all controller wiring is
    stable.
- id: P7.2
  done: true
  task: Update docs that currently point engineers to `context/session.ts` for transcript, prompts,
    SSE, selection, or workspace cache behavior.
- id: P7.3
  done: true
  task: Add a final progress log entry naming all modules created and final verification commands.
- id: P7.4
  done: true
  task: Set each completed phase to `done: true`.
- id: P7.5
  done: true
  task: Set frontmatter `done: true` only after final verification passes.

Implementation notes:

- `session.ts` is now kept as the public `createSessionStore` facade and controller composition
  shell; typecheck confirms there are no unused local helpers left behind after extraction.
- `docs/dev/app-map.md` and `docs/features/session-runtime.md` now route transcript, prompts,
  selection, SSE, reconnect, and workspace-cache work to the owning context modules instead of
  pointing future work back at `context/session.ts`.

Completion criteria:

- `session.ts` is primarily a public store facade plus controller composition.
- No source-contract test requires transcript, prompt, SSE, selection, or workspace cache business
  logic to live directly in `session.ts`.
- Focused context/session checks, broader app checks, typecheck, and `git diff --check` pass.

## Recommended Implementation Order

1. Store model and pure mutators.
2. Transcript controller.
3. Runtime prompts controller.
4. Session selection controller.
5. Event stream controller.
6. Workspace cache controller.
7. Facade cleanup and docs.

Do not start with SSE extraction. It has the biggest line-count payoff, but it currently depends on
transcript primitives, prompt refresh, status writes, known-session filtering, error turns, command
display, reload detection, and reconnect catch-up. Extracting transcript and prompts first gives the
SSE module clean dependency ports and lowers regression risk.

## Progress Log

Use this format for every implementation step:

```text
2026-06-27 - Phase N - test written/updated: `<path>` - module changed: `<path>` - verification: `<command>` passed/failed - done: false
```

2026-06-27 - Phase 0 complete - test written/updated: `packages/app/src/app/tests/context/session-context-modularization.test.ts` - module changed: none - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts` failed before inventory self-exclusion; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts` passed with 40 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed - done: true
2026-06-27 - Phase 1 complete - test written/updated: `packages/app/src/app/tests/context/session-store-model.test.ts`, `packages/app/src/app/tests/context/session-command-display.test.ts`, `packages/app/src/app/tests/context/session-context-modularization.test.ts` - module changed: `packages/app/src/app/context/session-store-model.ts`, `packages/app/src/app/context/session.ts` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-store-model.test.ts` failed before module creation; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts` passed with 45 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with LF-to-CRLF warnings only - done: true
2026-06-27 - Phase 2 complete - test written/updated: `packages/app/src/app/tests/context/session-transcript-controller.test.ts`, `packages/app/src/app/tests/context/session-workspace-busy-source.test.ts`, `packages/app/src/app/tests/context/session-question-workspace-routing.test.ts` - module changed: `packages/app/src/app/context/session-transcript-controller.ts`, `packages/app/src/app/context/session.ts` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-transcript-controller.test.ts` failed before module creation; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts` passed with 49 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with LF-to-CRLF warnings only - done: true
2026-06-27 - Phase 3 complete - test written/updated: `packages/app/src/app/tests/context/session-runtime-prompts.test.ts`, `packages/app/src/app/tests/context/session-question-workspace-routing.test.ts`, `packages/app/src/app/tests/context/session-context-modularization.test.ts` - module changed: `packages/app/src/app/context/session-runtime-prompts.ts`, `packages/app/src/app/context/session.ts` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-runtime-prompts.test.ts` failed before module creation; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts` passed with 54 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with LF-to-CRLF warnings only - done: true
2026-06-27 - Phase 4 complete - test written/updated: `packages/app/src/app/tests/context/session-selection-controller.test.ts`, `packages/app/src/app/tests/app-session-creation-flow-contract.test.ts`, `packages/app/src/app/tests/session-list-roots-regression.test.ts`, `packages/app/src/app/tests/context/session-context-modularization.test.ts` - module changed: `packages/app/src/app/context/session-selection-controller.ts`, `packages/app/src/app/context/session.ts` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-selection-controller.test.ts` failed before module creation; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/session-list-roots-regression.test.ts` passed with 59 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with LF-to-CRLF warnings only - done: true
2026-06-27 - Phase 5 complete - test written/updated: `packages/app/src/app/tests/context/session-event-stream.test.ts`, `packages/app/src/app/tests/context/session-unread-events.test.ts`, `packages/app/src/app/tests/context/session-workspace-busy-source.test.ts`, `packages/app/src/app/tests/context/session-routing-runtime.test.ts`, `packages/app/src/app/tests/context/session-transcript-hydration.test.ts`, `packages/app/src/app/tests/context/session-reconnect-store.test.ts`, `packages/app/src/app/tests/app-boot-engine-ready.test.ts`, `packages/app/src/app/tests/app-send-latency-trace.test.ts`, `packages/app/src/app/tests/app-send-prompt-session-creation.test.ts` - module changed: `packages/app/src/app/context/session-event-stream.ts`, `packages/app/src/app/context/session.ts` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-event-stream.test.ts` failed before module creation; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-context-modularization.test.ts` passed with 18 tests; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/session-route-client-resume.test.ts src/app/tests/pages/session-navigation.test.ts` passed with 118 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with LF-to-CRLF warnings only - done: true
2026-06-27 - Phase 6 complete - test written/updated: `packages/app/src/app/tests/context/session-workspace-cache.test.ts`, `packages/app/src/app/tests/context/workspace-session-snapshots.test.ts`, `packages/app/src/app/tests/context/session-context-modularization.test.ts` - module changed: `packages/app/src/app/context/session-workspace-cache.ts`, `packages/app/src/app/context/session.ts` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-workspace-cache.test.ts` failed before module creation; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-context-modularization.test.ts` passed with 19 tests; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/session-list-roots-regression.test.ts` passed with 72 tests; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/session-route-client-resume.test.ts src/app/tests/pages/session-navigation.test.ts` passed with 118 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with LF-to-CRLF warnings only - done: true
2026-06-27 - Phase 7 complete - test written/updated: documentation closeout only; no new behavior test - module changed: `docs/dev/app-map.md`, `docs/features/session-runtime.md`, `docs/plans/2026-06-27-session-context-modularization-plan.md` - verification: focused context/session checks passed with 85 tests; broader app checks passed with 118 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --cached --check` passed - modules created: `session-store-model.ts`, `session-transcript-controller.ts`, `session-runtime-prompts.ts`, `session-selection-controller.ts`, `session-event-stream.ts`, `session-workspace-cache.ts` - done: true
