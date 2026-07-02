---
title: App TSX Architecture Hardening Implementation Plan
date: 2026-07-02
target: packages/app/src/app/app.tsx
status: completed
done: true
base_branch: local/sandbox-merge
source_audit: conversation audit 2026-07-02 (Claude, app.tsx deep audit)
---

# App TSX Architecture Hardening Implementation Plan

## Goal

Fix the highest-risk composition-root findings from the 2026-07-02 app.tsx
architecture audit without changing product behavior:

1. The init-order seams patched by ad-hoc mutable refs fail silently when
   accessed before binding.
2. Session identity joins (`id` / `conversationId` / `opencodeSessionId`) are
   re-implemented independently at four call sites.
3. `chooseFolderForCurrentSession` is a ~200-line destructive workflow living
   inline in the composition shell.
4. Verified dead code left in the shell after the BLC01-BLC05 cleanup.

Out of scope (needs its own plan): scoped busy/error state replacing the
global `busy`/`busyLabel`/`setError` signals; LFC07 abort contract hardening.

## Coordination

Same protocol as `2026-07-02-app-tsx-business-logic-cleanup-implementation-plan.md`:
reservations happen in this file in the original worktree, code changes happen
only in the reserved worktree.

ARC01-ARC04 are executed serially by a single agent and touch overlapping
regions of `app.tsx`, so they intentionally share one branch and one worktree.
Do not reserve individual ARC tasks while that shared reservation is active.

## Task Reservation Ledger

| id | task | status | reserved_by | done |
| --- | --- | --- | --- | --- |
| ARC01 | late-bound composition seams | merged | claude-20260702-arch | true |
| ARC02 | canonical session identity resolver | merged | claude-20260702-arch | true |
| ARC03 | extract choose-folder workflow controller | merged | claude-20260702-arch | true |
| ARC04 | remove dead composition-shell code | merged | claude-20260702-arch | true |

Shared reservation:

```yaml
reserved_by: claude-20260702-arch
reserved_at: 2026-07-02T12:00:00+02:00
branch: app-arch/architecture-hardening
worktree: ../veslo-app-arch-architecture-hardening
```

## Tasks

### ARC01: Late-Bound Composition Seams

Cause:

- Six init-cycle seams use ad-hoc mutable variables (`workspaceStoreRef` +
  version signal, `managedAiAccessStoreRef` + pending boolean,
  `markReloadRequiredHandler`, `onHotReloadAppliedHandler`,
  `resolveSessionCapabilitySkillInventoryWorkspaces`, `let refreshMcpServers`).
- Access before assignment is a silent no-op; the pending-boolean queue on the
  managed AI store proves those windows are hit in production boots.

Implementation:

- Add `lib/late-bound.ts`: a reactive late-bound slot with `current()`,
  `bind()`, `whenBound()` (keyed queue), and one-shot early-access reporting.
- Replace the first five seams in `app.tsx` with named slots reporting through
  `wsDebug` + `recordBootstrapDiagnostic("app:late-bound-early-access")`.
- Keep `let refreshMcpServers` as-is: the unbound window is synchronous-only
  and a pre-assignment call fails loudly today; contract tests pin its shape.
- Preserve current fallback behavior at every seam (no queued replay except
  the managed AI refresh, which already queued via the boolean flag).
- Update `app-skill-registry-events.test.ts` regexes to the slot-based wiring.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/lib/late-bound.test.ts \
  src/app/tests/app-skill-registry-events.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

### ARC02: Canonical Session Identity Resolver

Cause:

- `statusForSession`, `activeConversationBusy`,
  `findSidebarSessionForWorkspace`, and `activeReloadBlockingSessions` each
  re-implement the `id`/`conversationId`/`opencodeSessionId` join by hand.

Implementation:

- Add a pure helper module owning the candidate-id set and workspace-scope
  resolution for a session reference; unit tests cover the join rules.
- Rewire the four call sites in `app.tsx` to the helper without changing
  which ids participate in each lookup.
- Do not change abort semantics or run-id authority (LFC07 stays deferred).
- Update `app-conversation-abort.test.ts` source contract to the new shape.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/lib/session-identity.test.ts \
  src/app/tests/app-conversation-abort.test.ts \
  src/app/tests/app-send-latency-trace.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

### ARC03: Extract Choose-Folder Workflow Controller

Cause:

- `chooseFolderForCurrentSession` is a ~200-line inline workflow with
  `window.confirm`, SQLite mutation, sidebar bookkeeping, a 100 ms sleep to
  dodge the route effect, and a destructive
  `forgetWorkspace({ deleteLocalData: true })` at the end.

Implementation:

- Move the workflow into `controllers/` per `controllers/README.md`, with
  dependencies injected from `app.tsx`.
- Keep behavior identical, including the yield points; document the route
  effect race at the yield site. Replacing the sleep with an explicit route
  sync handshake is allowed only if covered by a focused test.

Verification:

```bash
pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

### ARC04: Remove Dead Composition-Shell Code

Cause (re-verified against post-BLC05 HEAD before removal):

- No-op auto-select `createEffect` that ends in a bare `return;`.
- Duplicate import block from `./utils`.
- `reloadWorkspaceEngineAndResume` pass-through wrapper.
- `workspaceAutoReloadAvailable = createMemo(() => false)` and its dependent
  memos/setters/view-prop wiring.

Implementation:

- Remove each item only after confirming no live reader outside the chain.
- Keep `respondPermissionAndRemember`: it documents an intentional
  session-scoped permission decision.

Verification:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

## Final Plan Acceptance

- ARC01-ARC04 merged back into `local/sandbox-merge` after rebase onto the
  current branch head.
- `pnpm --filter @neatech/veslo-ui typecheck` and
  `pnpm --filter @neatech/veslo-ui test:unit` pass in the original worktree.
- Every task row above flips to `done: true`.

## Progress Log

- 2026-07-02 claude-20260702-arch: plan created; ARC01-ARC04 reserved on the
  shared branch `app-arch/architecture-hardening`.
- 2026-07-02 claude-20260702-arch: ARC01-ARC04 implemented as four commits
  (f14907fa, b0380077, 8879abef, d23cd288) and fast-forward merged into
  `local/sandbox-merge`.
- Branch verification: `pnpm --filter @neatech/veslo-ui typecheck` pass,
  `test:unit` 2031/2031 pass, `test:i18n` pass.
- Original-worktree verification after merge: typecheck pass, `test:unit`
  2031/2031 pass.
- Baseline repairs folded in: classified `pages/session-send-workflow.test.ts`
  (BLC04) in the modularization source-reader inventory; the full unit suite
  failed on it before this branch.
- Known pre-existing failure not addressed here: `test:ui-localization`
  reports 141 violations on the untouched base commit as well.
