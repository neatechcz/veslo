# Private Workspace Bundle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Collapse Veslo-created private workspaces into one unnamed bundled sidebar group while keeping `Recent` behavior intact.

**Architecture:** Reuse the existing sidebar grouping implementation and thread the real `isPrivateWorkspacePath` predicate from `workspaceStore` down into `WorkspaceSessionList`. Use that predicate to synthesize one shared private-workspace group and to suppress private labels in the recent feed.

**Tech Stack:** SolidJS, TypeScript, existing sidebar script checks, pnpm

---

### Task 1: Add a failing sidebar contract for bundled private workspaces

**Files:**
- Modify: `packages/app/scripts/sidebar-flat-sessions.mjs`
- Test: `packages/app/scripts/sidebar-flat-sessions.mjs`

**Step 1: Write the failing test**

Update the script to assert that the sidebar component now contains structural markers for:
- a private-workspace grouping predicate
- a synthetic bundled private group
- blank recent labels for private-workspace rows

**Step 2: Run the script to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:sidebar-flat
```

Expected: FAIL before production code changes.

**Step 3: Keep the assertions narrow**

Assert on stable logic markers rather than cosmetic classes.

**Step 4: Re-run after implementation**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:sidebar-flat
```

Expected: PASS.

### Task 2: Thread private-workspace detection into the sidebar

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`

**Step 1: Add prop plumbing**

Add an `isPrivateWorkspacePath` prop from `app.tsx` through the dashboard/session page props into `WorkspaceSessionList`.

**Step 2: Keep semantics real**

Use `workspaceStore.isPrivateWorkspacePath` directly instead of duplicating the private-path detection logic in the component.

**Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

### Task 3: Bundle private workspaces in `By project`

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`

**Step 1: Write the minimal implementation**

Update the component so all rows whose project root satisfies `isPrivateWorkspacePath(...)` map to one synthetic grouped key with an empty visible label.

**Step 2: Preserve ordering**

Inside the private bundle, use the same ordering as `Recent`:
- newest first by created time
- existing recent tiebreakers unchanged

**Step 3: Keep named project behavior**

Do not change grouping for non-private local workspaces or remote workspaces.

**Step 4: Hide recent labels for private sessions**

In the `Recent` feed, suppress the secondary project basename for private-workspace sessions only.

**Step 5: Run targeted checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:sidebar-flat
```

Expected: PASS.

### Task 4: Verify and record limitations

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/scripts/sidebar-flat-sessions.mjs`

**Step 1: Run local verification**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:sidebar-flat
pnpm --filter @neatech/veslo-ui build
```

Expected: PASS.

**Step 2: Attempt runtime UI verification if available**

Run:

```bash
packaging/docker/dev-up.sh
```

Then verify the sidebar in the running UI if Docker and browser automation are available.

**Step 3: If the environment blocks the UI gate**

Record:
- which step failed
- why it failed
- which local checks passed instead
