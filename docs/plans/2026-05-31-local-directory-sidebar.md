# Local Directory Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a newly added local directory immediately in the by-project left sidebar without moving the existing workspace-opening flow.

**Architecture:** Keep workspace registration and runtime startup separate. The app should publish the local workspace into the sidebar immediately after registration, and `WorkspaceSessionList` should render the existing workspace-only project group for empty local workspaces. Do not add new engine start, workspace switch, or composer-routing behavior.

**Tech Stack:** SolidJS signals/memos, app-side TypeScript model tests, Tauri workspace registration bridge.

---

### Task 1: Lock Sidebar Model Behavior

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-model.ts`

**Step 1: Write the failing test**

Add a test that builds project groups from an active workspace with sessions plus a newly added local workspace with no sessions. Assert that the new local workspace appears as a workspace-only project group.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- workspace-session-list-model
```

Expected: FAIL if the current projection drops the newly added empty local workspace.

**Step 3: Write minimal implementation**

If needed, adjust `buildProjectGroups` or its input preparation so empty local workspaces from `workspaceSessionGroups` are preserved as workspace-only groups. Keep private workspaces hidden.

**Step 4: Run test to verify it passes**

Run the same focused test command. Expected: PASS.

### Task 2: Preserve Add-Only Flow

**Files:**
- Modify: `packages/app/src/app/pages/session-navigation.test.ts`
- Modify: `packages/app/src/app/pages/session-navigation.ts`
- Possibly modify: `packages/app/src/app/app.tsx`

**Step 1: Write the failing test**

Add or adjust a focused test proving the directory-add path publishes the registered workspace before the existing activation/pending-draft continuation. The test should distinguish “registered in workspace list/sidebar” from “opened/runtime activated”.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- session-navigation
```

Expected: FAIL if adding a local directory does not publish the workspace until after activation/opening.

**Step 3: Write minimal implementation**

Route the add-directory action through workspace registration/sidebar publication before continuing into the existing pending-draft activation path. Existing explicit project click, pending-draft, send, and workspace activation paths stay otherwise unchanged.

**Step 4: Run test to verify it passes**

Run the same focused test command. Expected: PASS.

### Task 3: Verification

**Files:**
- No additional source files expected.

**Step 1: Run focused unit tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- workspace-session-list-model session-navigation
```

**Step 2: Run app checks**

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

**Step 3: Decide if desktop E2E is needed**

If the change touches only pure model/helper code, record unit/typecheck coverage. If the app flow changes Tauri runtime behavior, run the desktop E2E preflight and focused WebdriverIO spec per `docs/dev/testing-playbook.md`.
