# Session Archive Button + Context Menu Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace session-row three-dot action with archive action and open the previous submenu on right-click, while keeping archive non-destructive.

**Architecture:** Add sidebar preferences for archived session IDs and "show archived" state, then apply filtered rendering in `WorkspaceSessionList`. Reuse existing menu anchor infrastructure for right-click context menu. Keep behavior client-side/local-first for this phase.

**Tech Stack:** SolidJS (`@neatech/veslo-ui`), localStorage-backed sidebar prefs, Node test runner (`node --test`).

---

### Task 1: Add Sidebar Archive Preferences

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.test.ts`

**Step 1: Write failing tests for archive prefs**

Add tests for:
- default `showArchived` = false
- write/read `showArchived`
- write/read archived session IDs (trim + dedupe)

**Step 2: Run targeted tests and confirm RED**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefs.test.ts
```

Expected: FAIL (new functions/constants missing).

**Step 3: Implement minimal archive prefs in prefs module**

Add:
- `SIDEBAR_SHOW_ARCHIVED_KEY`
- `SIDEBAR_ARCHIVED_SESSION_IDS_KEY`
- `readShowArchivedSessions`
- `writeShowArchivedSessions`
- `readArchivedSessionIds`
- `writeArchivedSessionIds`

with normalization helpers.

**Step 4: Re-run targeted tests and confirm GREEN**

Run same command as Step 2.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list-prefs.ts packages/app/src/app/components/session/workspace-session-list-prefs.test.ts
git commit -m "feat(sidebar): persist archived session preferences"
```

### Task 2: Implement Archive Icon + Right-Click Menu in Session Rows

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`

**Step 1: Write failing tests for new interaction contract**

Add assertions for:
- archive icon button in session rows
- right-click (`onContextMenu`) opens menu target for session rows
- show archived control/tooltip present

**Step 2: Run targeted interaction/layout tests and confirm RED**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-interactions.test.ts src/app/components/session/workspace-session-list-controls-tooltips.test.ts src/app/components/session/workspace-session-list-recent-layout.test.ts
```

Expected: FAIL (new selectors missing).

**Step 3: Implement minimal UI behavior**

In `workspace-session-list.tsx`:
- load/persist archive prefs
- filter rows using archived IDs + showArchived flag
- replace session-row hover three-dot action with archive icon action
- add right-click handler on session rows to open existing menu anchor
- add `Show archived` toggle control

**Step 4: Add i18n keys**

Add English/Czech strings:
- `sidebar.archive_session`
- `sidebar.unarchive_session`
- `sidebar.show_archived`

**Step 5: Re-run targeted tests and confirm GREEN**

Run command from Step 2.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-interactions.test.ts packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts
git commit -m "feat(sidebar): archive sessions from row action and open menu on right-click"
```

### Task 3: Full Verification + Manual Gate Notes

**Files:**
- Modify: `docs/plans/assets/workspace-remove-safety/README.md` (append pointer to archive behavior verification)
- Create: `docs/plans/assets/session-archive-context-menu/README.md`

**Step 1: Run full unit suite**

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Attempt desktop UX verification**

Run:

```bash
pnpm --filter @neatech/veslo dev
```

Verify:
- hover row action archives session (hidden when showArchived=false)
- right-click row opens submenu
- showArchived toggle reveals archived rows

**Step 3: Record evidence constraints**

If Docker/Chrome MCP flow cannot be run in-session, document exact missing steps and commands in `docs/plans/assets/session-archive-context-menu/README.md`.

**Step 4: Commit**

```bash
git add docs/plans/assets/workspace-remove-safety/README.md docs/plans/assets/session-archive-context-menu/README.md
git commit -m "docs: add archive session context-menu verification notes"
```
