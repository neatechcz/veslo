---
title: App TSX Business Logic Cleanup Implementation Plan
date: 2026-07-02
target: packages/app/src/app/app.tsx
status: completed
done: true
base_branch: local/sandbox-merge
source_audit: docs/dev/2026-07-02-app-tsx-business-logic-deep-audit-dev-specific.md
---

# App TSX Business Logic Cleanup Implementation Plan

## Goal

Remove or resolve currently verified stale business-logic layers in
`packages/app/src/app/app.tsx` without weakening existing behavior.

This is a cleanup plan, not a new modularization pass. Keep changes small,
test-first where behavior can regress, and do not touch unrelated dirty work.

Top-level `done: false` stays false until every task below is merged and the
final verification passes in the original worktree.

## Current Snapshot

- `createAppViewProps()` is currently balanced:
  - 291 keys passed from `app.tsx`
  - 291 keys destructured by `app-view-props.ts`
  - no extra pass-through keys
- Do not create an app-view-props cleanup task for
  `autoCompactContext` / `setAutoCompactContext`; that finding is stale.
- The current worktree may contain unrelated in-progress `sendPromptInFlight`
  changes. Do not mix those into this cleanup plan.

## Current Execution Decision

- Start with BLC01 only.
- Do not run BLC02-BLC05 in parallel while BLC01 is unmerged.
- BLC01 is a pure dead-code cleanup with no product decision:
  - remove `activeSessions = createMemo(() => sessions())`
  - remove `activeMessages = createMemo(() => messages())`
  - remove `providerDefaults = createMemo(() => globalSync.data.provider.default ?? {})`
- After BLC01 merges, evaluate BLC02 separately because it changes the
  preference-layer contract even if runtime auto-compaction remains always on.

## Coordination Protocol For Multiple Agents

Agents reserve work in the original worktree only. Code changes happen only in
the agent's own worktree.

Reservation steps in the original worktree:

1. Open this plan.
2. Pick one task with `status: available`, `reserved_by: null`, and all
   dependencies already `done: true`.
3. Change only that task's reservation fields:
   - `status: reserved`
   - `reserved_by: <agent-name-or-session-id>`
   - `reserved_at: <ISO timestamp>`
   - `branch: app-cleanup/<task-id>-<slug>`
   - `worktree: ../veslo-app-cleanup-<task-id>-<slug>`
4. Save this plan in the original worktree.
5. Create the agent worktree from the original checkout:

```bash
git worktree add ../veslo-app-cleanup-<task-id>-<slug> -b app-cleanup/<task-id>-<slug> HEAD
```

Rules:

- Do not edit product code in the original worktree.
- Do not reserve a task that already has a non-null `reserved_by`.
- Do not change another agent's reservation.
- Do not mark `done: true` from an agent worktree.
- Mark a task `done: true` only in the original worktree after that branch is
  merged and the task verification has passed there.
- If a task becomes blocked, set `status: blocked` and add one short blocker
  note.

## Shared Implementation Rules

- Keep `modelForSession()` as the send workflow contract.
- Keep auto-compaction behavior unless the task explicitly changes only the
  unused preference layer.
- Keep `createSkillReloadGuard()` unless a separate behavior review replaces
  the skill reload fallback contract.
- Do not touch `visibleRuntimeActivityHold`, latest-run artifact refresh,
  `workspaceStoreRefVersion`, `legacyDefaultModel`, session directory
  overrides, or pending initial session title logic in this plan.
- Do not include the current `sendPromptInFlight` dirty work in these tasks.

## Task Reservation Ledger

| id | task | status | reserved_by | done |
| --- | --- | --- | --- | --- |
| BLC01 | remove dead aliases | merged | codex-20260702-blc01 | true |
| BLC02 | remove auto-compact preference layer | merged | codex-20260702-blc02 | true |
| BLC03 | resolve obsolete session view lock guard | merged | codex-20260702-blc03 | true |
| BLC04 | remove dead per-session model maps | merged | codex-20260702-blc04 | true |
| BLC05 | clean skill fallback leftover state | merged | codex-20260702-blc05 | true |

## Tasks

### BLC01: Remove Dead Aliases

```yaml
id: BLC01
status: merged
reserved_by: codex-20260702-blc01
reserved_at: 2026-07-02T00:33:02.7599495+02:00
branch: app-cleanup/blc01-dead-aliases
worktree: ../veslo-app-cleanup-blc01-dead-aliases
done: true
depends_on: []
target_files:
  - packages/app/src/app/app.tsx
```

Cause:

- `activeSessions`, `activeMessages`, and `providerDefaults` are stale aliases
  with no readers in current app wiring.

Implementation:

- Remove:
  - `const activeSessions = createMemo(() => sessions());`
  - `const activeMessages = createMemo(() => messages());`
  - `const providerDefaults = createMemo(() => globalSync.data.provider.default ?? {});`
- Do not remove provider default setters or provider data used by other modules.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

Progress log:

- 2026-07-02T00:33:02.7599495+02:00 codex-20260702-blc01:
  reserved and implemented the dead-alias removal in
  `../veslo-app-cleanup-blc01-dead-aliases`.
- `git diff --check HEAD`: pass.
- Additional source-contract checks in the BLC01 worktree:
  - `src/app/tests/app-view-props.test.ts`: pass, 4/4
  - `src/app/tests/app-refactor-contracts.test.ts`: pass, 5/5
- `pnpm --filter @neatech/veslo-ui typecheck`: blocked by an unrelated
  baseline syntax error in `packages/app/src/app/pages/session-send-workflow.ts`
  (`TS1472: 'catch' or 'finally' expected`, `TS1005: '}' expected`). BLC01
  branch diff only changes `packages/app/src/app/app.tsx`.
- The BLC01 worktree uses ignored `node_modules` junctions for local test
  execution; these are not part of the branch diff.
- 2026-07-02 codex-20260702-blc01: rebased BLC01 onto current
  `local/sandbox-merge`, reran verification successfully, and merged the branch
  back with fast-forward commit `f41e2172`.
- Final verification after rebase:
  - `pnpm --filter @neatech/veslo-ui typecheck`: pass
  - `git diff --check HEAD`: pass

### BLC02: Remove Auto-Compact Preference Layer

```yaml
id: BLC02
status: merged
reserved_by: codex-20260702-blc02
reserved_at: 2026-07-02T00:47:12.2124046+02:00
branch: app-cleanup/blc02-auto-compact-preference
worktree: ../veslo-app-cleanup-blc02-auto-compact-preference
done: true
depends_on: [BLC01]
target_files:
  - packages/app/src/app/app.tsx
  - packages/app/src/app/context/app-startup-hydration.ts
  - packages/app/src/app/tests/pages/settings-tabs-layout.test.ts
```

Default decision:

- Auto-compaction remains enabled.
- The unused user preference layer is removed.

Cause:

- `autoCompactContext` defaults to `true`.
- Startup hydration forces `veslo.autoCompactContext` to `true` instead of
  restoring a user-selected false value.
- Settings tests already assert that the UI toggle is not exposed.

Implementation:

- Replace the signal-gated checks in `app.tsx` with always-on
  auto-compaction behavior.
- Remove the `autoCompactContext` signal and reset-default setter.
- Remove `AUTO_COMPACT_CONTEXT_PREF_KEY` usage from startup hydration if it no
  longer has a live preference contract.
- Keep manual compaction behavior unchanged.
- Keep tests asserting that no auto-compact settings UI is exposed.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/settings-tabs-layout.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

Progress log:

- 2026-07-02T00:47:12.2124046+02:00 codex-20260702-blc02:
  reserved BLC02 and added a failing startup hydration contract proving the
  auto-compact preference layer still existed.
- Expected pre-fix focused test result:
  - `src/app/tests/context/app-startup-hydration.test.ts`: fail on
    `automatic context compaction no longer has a persisted preference layer`.
- Implemented always-on automatic compaction by removing only the persisted
  preference signal/storage key/dependency wiring.
- BLC02 worktree verification:
  - `src/app/tests/context/app-startup-hydration.test.ts`: pass, 6/6
  - `src/app/tests/pages/settings-tabs-layout.test.ts`: pass, 6/6
  - `pnpm --filter @neatech/veslo-ui typecheck`: pass
  - `git diff --check HEAD`: pass
- 2026-07-02 codex-20260702-blc02: merged back into `local/sandbox-merge` with
  fast-forward commit `6f80af39`.

### BLC03: Resolve Obsolete Session View Lock Guard

```yaml
id: BLC03
status: merged
reserved_by: codex-20260702-blc03
reserved_at: 2026-07-02T00:50:31.7015937+02:00
branch: app-cleanup/blc03-session-view-lock-guard
worktree: ../veslo-app-cleanup-blc03-session-view-lock-guard
done: true
depends_on: [BLC02]
target_files:
  - packages/app/src/app/app.tsx
  - packages/app/src/app/context/app-route-sync.ts
  - packages/app/src/app/tests/context/app-route-sync.test.ts
```

Default decision:

- Remove the obsolete guard, because production app wiring never sets
  `sessionViewLockUntil`.

Cause:

- `app.tsx` creates `sessionViewLockUntil`, but `setSessionViewLockUntil` has
  no writer outside declaration.
- `app-route-sync.ts` still contains a dashboard-navigation guard that can only
  run in tests with an injected value.

Implementation:

- Remove `sessionViewLockUntil` from `app.tsx` and `createAppRouteSync()`
  dependencies.
- Remove the obsolete guard from `app-route-sync.ts`.
- Update route-sync tests so they still cover the live `creatingSession` guard,
  but no longer assert the unused session-view-lock branch.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/app-route-sync.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

Progress log:

- 2026-07-02T00:50:31.7015937+02:00 codex-20260702-blc03:
  reserved BLC03 and updated route-sync tests to cover only the live
  `creatingSession` dashboard-navigation guard.
- Expected pre-fix focused test result:
  - `src/app/tests/context/app-route-sync.test.ts`: fail with
    `TypeError: deps.sessionViewLockUntil is not a function`.
- Removed the unused `sessionViewLockUntil` app signal, route-sync dependency,
  injected `now` hook, and dashboard lock branch.
- BLC03 worktree verification:
  - `src/app/tests/context/app-route-sync.test.ts`: pass, 3/3
  - `pnpm --filter @neatech/veslo-ui typecheck`: pass
  - `git diff --check HEAD`: pass
- 2026-07-02 codex-20260702-blc03: merged back into `local/sandbox-merge` with
  fast-forward commit `1f0f533e`.

### BLC04: Remove Dead Per-Session Model Maps

```yaml
id: BLC04
status: merged
reserved_by: codex-20260702-blc04
reserved_at: 2026-07-02T00:52:59.5807020+02:00
branch: app-cleanup/blc04-session-model-maps
worktree: ../veslo-app-cleanup-blc04-session-model-maps
done: true
depends_on: [BLC03]
target_files:
  - packages/app/src/app/app.tsx
  - packages/app/src/app/pages/session-send-workflow.ts
  - packages/app/src/app/tests/pages/session-send-workflow.test.ts
```

Default decision:

- Remove the dead map layers only.
- Keep `modelForSession()` as the send workflow contract.

Cause:

- `sessionModelOverrideById` and `sessionModelById` are read by
  `modelForSession()`, but current app wiring never populates them.
- `sessionModelOverrideById` only has reset writers.
- `sessionModelById` has no writer.

Implementation:

- Remove both map signals and reset-only writes.
- Keep `modelForSession()` returning:
  - managed AI selected model when present
  - global/default model when no session id exists
  - last user message model for the selected session when present
  - global/default model as final fallback
- Retarget or update focused tests if they assert the removed map branches.
- Do not change send workflow model lookup timing or materialized-session
  behavior.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-send-workflow.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

Progress Log:

- 2026-07-02 codex-20260702-blc04: added focused source/behavior contract in
  `session-send-workflow.test.ts`; pre-change focused test failed as expected on
  dead `sessionModelOverrideById`/`sessionModelById` references.
- 2026-07-02 codex-20260702-blc04: removed the unpopulated model maps and reset
  writes from `app.tsx`; kept `modelForSession()` as the send workflow contract
  with managed-AI, missing-session, selected-session message, and global fallback
  behavior.
- 2026-07-02 codex-20260702-blc04: branch verification passed:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts`: 7/7 pass
  - `pnpm --filter @neatech/veslo-ui typecheck`: pass
  - `git diff --check HEAD`: pass
- 2026-07-02 codex-20260702-blc04: rebased onto current `local/sandbox-merge`
  after concurrent lifecycle commits and merged back via fast-forward commit
  `7f9988a1`.
- 2026-07-02 codex-20260702-blc04: original-worktree verification passed:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts`: 7/7 pass
  - `pnpm --filter @neatech/veslo-ui typecheck`: pass
  - `git diff --check HEAD -- packages/app/src/app/app.tsx packages/app/src/app/tests/pages/session-send-workflow.test.ts`: pass

### BLC05: Clean Skill Fallback Leftover State

```yaml
id: BLC05
status: merged
reserved_by: codex-20260702-blc05
reserved_at: 2026-07-02T00:57:45.6290155+02:00
branch: app-cleanup/blc05-skill-fallback-leftover
worktree: ../veslo-app-cleanup-blc05-skill-fallback-leftover
done: true
depends_on: [BLC04]
target_files:
  - packages/app/src/app/app.tsx
  - packages/app/src/app/lib/skill-reload-guard.ts
  - packages/app/src/app/tests/lib/skill-reload-guard.test.ts
```

Default decision:

- Keep `createSkillReloadGuard()`.
- Remove only no-op app-local leftover state.

Cause:

- `pendingSkillFallbackAutoReload` is set when the fallback fires.
- A later effect immediately clears it.
- The legacy auto-reload comment says auto-reload was intentionally removed.
- There is a no-op `onMount()` that contains only a comment.

Implementation:

- Remove `pendingSkillFallbackAutoReload` and its setters/effects from
  `app.tsx`.
- Remove the empty legacy `onMount()` block.
- Keep the skill fallback banner path through `markReloadRequired("skills")`.
- Keep `createSkillReloadGuard()` behavior and tests.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/lib/skill-reload-guard.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

Progress Log:

- 2026-07-02 codex-20260702-blc05: reserved BLC05 and created
  `../veslo-app-cleanup-blc05-skill-fallback-leftover`.
- 2026-07-02 codex-20260702-blc05: confirmed current HEAD already contains the
  BLC05 cleanup and contract test from earlier commit `c046f89e`; worktree had
  no code diff and the no-op fast-forward merge reported `Already up to date`.
- 2026-07-02 codex-20260702-blc05: focused verification passed:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/skill-reload-guard.test.ts src/app/tests/app-skill-registry-events.test.ts`: 7/7 pass
  - `pnpm --filter @neatech/veslo-ui typecheck`: pass
  - `git diff --check HEAD`: pass

## Final Plan Acceptance

After BLC01-BLC05 are merged into the original worktree:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/app-route-sync.test.ts \
  src/app/tests/pages/settings-tabs-layout.test.ts \
  src/app/tests/pages/session-send-workflow.test.ts \
  src/app/tests/lib/skill-reload-guard.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

Acceptance:

- Every task above has `done: true`.
- Top-level `done: false` is changed to `done: true`.
- `app.tsx` no longer contains the verified stale aliases, unused preference
  layer, dead session-view-lock guard, dead per-session model maps, or no-op
  skill fallback leftover state.
- No currently protected behavior listed under shared rules is removed.

Final Verification Log:

- 2026-07-02 codex: final acceptance in the original worktree passed:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/app-route-sync.test.ts src/app/tests/pages/settings-tabs-layout.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/lib/skill-reload-guard.test.ts`: 20/20 pass
  - `pnpm --filter @neatech/veslo-ui typecheck`: pass
  - `git diff --check HEAD`: pass
