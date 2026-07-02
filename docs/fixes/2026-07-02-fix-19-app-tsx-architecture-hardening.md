# Fix 19: App TSX Architecture Hardening

## Problem

A deep audit of `packages/app/src/app/app.tsx` after the Fix 18 modularization found that the
composition shell itself carried the highest-risk debt left in the app package:

- Six init-order seams were patched with ad-hoc mutable variables (`workspaceStoreRef` plus a
  hand-rolled version signal, `managedAiAccessStoreRef` plus a pending-refresh boolean,
  `markReloadRequiredHandler`, `onHotReloadAppliedHandler`,
  `resolveSessionCapabilitySkillInventoryWorkspaces`, `let refreshMcpServers`). Access before
  assignment was a silent no-op, so boot-order races surfaced later as unexplained bugs instead of
  diagnostics. The pending-refresh boolean proved those pre-bind windows are hit in real boots.
- The session identity join across the three id keyspaces (`id` / `conversationId` /
  `opencodeSessionId`) was re-implemented by hand at four call sites (`statusForSession`,
  `activeConversationBusy`, the sidebar session lookup, and the reload-blocking session memo).
  Every new consumer had to know to check all three ids or it produced wrong busy/status results.
- `chooseFolderForCurrentSession` was a ~200-line workflow inline in the shell: `window.confirm`
  prompts, OpenCode SQLite mutation, `veslo.json` rewrite, sidebar bookkeeping, and a destructive
  `forgetWorkspace({ deleteLocalData: true })` at the end.
- Verified dead code remained after BLC01-BLC05: a no-op bare-return route effect, duplicate
  `./utils` import blocks, unused imports, a pass-through reload wrapper, and the
  `workspaceAutoReload*` chain whose availability memo was hardcoded to `false` while the config
  tab still rendered two permanently disabled toggles for it.

## Fix

Implemented as `docs/plans/2026-07-02-app-tsx-architecture-hardening-implementation-plan.md`
(ARC01-ARC04) on branch `app-arch/architecture-hardening`, merged fast-forward into
`local/sandbox-merge` as commits `f14907fa`, `b0380077`, `8879abef`, `d23cd288`.

- ARC01 late-bound composition seams:
  - Added `packages/app/src/app/lib/late-bound.ts`, a reactive late-bound slot with `current()`,
    `bind()`, keyed `whenBound()` queueing, and one-shot early-access reporting.
  - Replaced the first five ad-hoc seams with named slots that report pre-bind access through
    `wsDebug` and `recordBootstrapDiagnostic("app:late-bound-early-access")`.
  - Kept `let refreshMcpServers` as-is: its unbound window is synchronous-only and already fails
    loudly, and contract tests pin its shape.
- ARC02 canonical session identity resolver:
  - Added `packages/app/src/app/lib/session-identity.ts` owning the candidate-id set
    (`sessionIdentityCandidates`) and alias matching (`sessionIdentityMatches`).
  - Rewired `statusForSession`, `activeConversationBusy`, and the sidebar session lookup to the
    resolver without changing which ids participate in each lookup.
- ARC03 choose-folder workflow controller:
  - Moved the workflow to `packages/app/src/app/controllers/session-folder-move-controller.ts`
    per `controllers/README.md`, with the source-workspace resolution extracted as the pure,
    unit-tested `resolveSessionFolderMoveSource`.
  - Behavior preserved, including the microtask/100 ms yields around the route effect; replacing
    the sleep with an explicit route-sync handshake needs a real Tauri-runtime test first.
- ARC04 dead composition-shell code:
  - Removed the no-op bare-return auto-select effect, merged the duplicate `./utils` import
    blocks, dropped unused imports, and removed the `reloadWorkspaceEngineAndResume` wrapper.
  - Removed the `workspaceAutoReload*` memo/setter chain and its prop plumbing through
    `app-view-props.ts`, `pages/dashboard.tsx`, and `pages/config.tsx`, including the two config
    cards that could never be enabled.

`app.tsx` went from 4598 to 4367 implementation lines and no longer contains silent late-binding
seams.

## Scope Boundaries

- Scoped busy/error state (replacing the shared `busy`/`busyLabel`/`setError` signals) is out of
  scope and needs its own plan; it changes the interface of ~20 modules.
- LFC07 abort contract hardening stays deferred and reserved by
  `docs/plans/2026-07-01-conversation-run-lifecycle-controller-implementation-plan.md`; this fix
  does not change abort semantics or run-id authority.
- The send/mutation workflow dependency bags and `createAppViewProps` width are unchanged.

## Coverage

- `src/app/tests/lib/late-bound.test.ts` covers slot semantics, early-access reporting, and keyed
  `whenBound` queue collapse.
- `src/app/tests/lib/session-identity.test.ts` covers candidate ordering, trimming,
  de-duplication, and alias matching.
- `src/app/tests/controllers/session-folder-move-controller.test.ts` covers source-workspace
  resolution including the private-workspace and remote-workspace rejections.
- Retargeted source contracts: `app-skill-registry-events.test.ts`,
  `app-send-latency-trace.test.ts`, `app-conversation-abort.test.ts` (unchanged, still passing),
  `pages/dashboard-menu-navigation.test.ts`, `pages/session-navigation.test.ts` (now reads the
  controller module).
- Baseline repair: classified `pages/session-send-workflow.test.ts` (added by BLC04) in the
  `app-modularization-contract.test.ts` source-reader inventory; the full unit suite failed on
  the unclassified reader before this branch.

## Verification

Branch worktree and original worktree after merge:

```bash
pnpm --filter @neatech/veslo-ui typecheck   # pass
pnpm --filter @neatech/veslo-ui test:unit   # 2031/2031 pass
pnpm --filter @neatech/veslo-ui test:i18n   # pass
```

Known pre-existing failure not addressed here: `pnpm --filter @neatech/veslo-ui
test:ui-localization` reports 141 violations on the untouched base commit `287bb9c5` as well.

## Status

Complete. Merged into `local/sandbox-merge` at `d23cd288` on 2026-07-02.
