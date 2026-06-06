# Default Collapsed Right Menu Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the right menu collapsed by default on first app launch while preserving existing saved user preferences.

**Architecture:** Store the first-run default in the shared global sidebar preference helper. Dashboard and session surfaces should read and write through that helper so the same local storage key and migration behavior apply everywhere.

**Tech Stack:** SolidJS app shell, TypeScript, node:test source-level regression tests.

---

### Task 1: Shared Sidebar Preference Default

**Files:**
- Modify: `packages/app/src/app/components/layout/global-sidebar-prefs.test.ts`
- Modify: `packages/app/src/app/components/layout/global-sidebar-prefs.ts`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`

**Step 1: Write the failing tests**

Add a test that `readGlobalSidebarDockedPrefs` returns `{ left: true, right: false }` when storage is empty. Add a source-level test to ensure dashboard and session view both import and use the shared read/write helpers instead of local duplicate preference logic.

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @neatech/veslo-ui exec tsx src/app/components/layout/global-sidebar-prefs.test.ts`

Expected: FAIL because the current first-run default keeps the right menu visible and the views still contain local duplicated preference helpers.

**Step 3: Implement the minimal change**

Change `DEFAULT_GLOBAL_SIDEBAR_DOCKED_VISIBILITY.right` to `false`. Replace the local dashboard/session read/write helpers with `readGlobalSidebarDockedPrefs` and `writeGlobalSidebarDockedPrefs`.

**Step 4: Run focused verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec tsx src/app/components/layout/global-sidebar-prefs.test.ts
pnpm typecheck
```

Expected: PASS.
