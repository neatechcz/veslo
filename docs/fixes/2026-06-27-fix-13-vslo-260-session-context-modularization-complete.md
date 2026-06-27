# Fix 13: VSLO-260 Session Context Modularization Complete

## Problem

`packages/app/src/app/context/session.ts` had become a high-risk runtime store monolith. It owned
session list loading, selected transcript loading, transcript hydration and persistence, runtime
permission/question prompts, active and background SSE streams, reconnect catch-up, command display
aliases, workspace snapshots, scoped busy state, and the public `createSessionStore` facade in one
large closure.

That made session runtime fixes risky: a change in reconnect, transcript persistence, or prompt
routing could accidentally mutate unrelated state. It also encouraged source-contract tests and docs
to keep pointing future work back at `context/session.ts`, which would make the monolith grow again.

## Fix

- Completed the implementation plan in
  `docs/plans/2026-06-27-session-context-modularization-plan.md`; all phases and the frontmatter are
  now `done: true`.
- Kept `packages/app/src/app/context/session.ts` as the public `createSessionStore` facade, Solid
  store owner, controller composition shell, and returned API wiring.
- Extracted durable runtime modules:
  - `packages/app/src/app/context/session-store-model.ts`
  - `packages/app/src/app/context/session-transcript-controller.ts`
  - `packages/app/src/app/context/session-runtime-prompts.ts`
  - `packages/app/src/app/context/session-selection-controller.ts`
  - `packages/app/src/app/context/session-event-stream.ts`
  - `packages/app/src/app/context/session-workspace-cache.ts`
- Updated source-contract and behavior tests so transcript, prompts, selection, SSE, reconnect, and
  workspace cache assertions target the owning modules instead of requiring business logic to stay in
  `context/session.ts`.
- Updated live documentation:
  - `docs/dev/app-map.md`
  - `docs/features/session-runtime.md`

## Review Hardening

Follow-up review findings were fixed before marking the plan complete:

- Reconnect catch-up now snapshots running sessions for the stream workspace instead of losing the
  workspace owner through unscoped `sessionStatus` keys.
- Background reconnect catch-up no longer mutates the active transcript or todo store; it schedules
  durable background transcript ingestion for the owning workspace.
- Permission prompt routing now matches question prompt routing for selected cross-workspace
  sessions.
- Permission replies no longer fall back to the active workspace client when the prompt owner client
  is missing.
- Authoritative transcript append snapshots can explicitly apply shorter results with
  `allowShorter: true`, so legitimate deletion snapshots are not rejected as stale warm-cache data.
- Command display aliases now replace only the first user text part while preserving later text and
  non-text parts in order.

## Coverage

- `session-context-modularization.test.ts` locks the durable context module boundaries and prevents
  extracted modules from importing the facade.
- `session-store-model.test.ts` covers message/part ordering, command aliases, placeholders, and
  synthetic error turns.
- `session-transcript-controller.test.ts` covers hydration, shorter authoritative snapshots, live
  deletion persistence, background transcript ingestion, and timer cleanup.
- `session-runtime-prompts.test.ts` covers per-workspace prompt aggregation, selected prompt
  routing, missing-owner permission reply behavior, and stale route release.
- `session-selection-controller.test.ts` covers selected-session loading, offline transcript
  fallback, browse policy, missing-session fallback, and rename routing.
- `session-event-stream.test.ts` covers active/background event behavior, reconnect cleanup,
  per-stream SSE connected state, active reconnect catch-up, and background reconnect catch-up.
- `session-workspace-cache.test.ts` covers workspace snapshot save/load/clear, selected-session
  validation, transcript metadata restore, and eviction.

## Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-context-modularization.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/session-reconnect.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/session-list-roots-regression.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-question-workspace-routing.test.ts src/app/tests/context/session-command-display.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/context/session-reconnect-store.test.ts src/app/tests/context/workspace-session-snapshots.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/session-route-client-resume.test.ts src/app/tests/pages/session-navigation.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --cached --check
```

Result:

- focused context/session suite passed: `85 pass`, `0 fail`
- broader app contract suite passed: `118 pass`, `0 fail`
- app typecheck passed
- `git diff --cached --check` passed

## Status

VSLO-260 is complete from the modularization side. The session context plan is closed, Phase 7 is
done, docs are updated, and the modularization changes have been committed.
