# Sidebar Runtime Available Status Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the sidebar connection dot in a ready state during local browsing mode when the runtime is available but the active workspace is intentionally not attached to a live client yet.

**Architecture:** Thread the active workspace connection state into the sidebar status component and let the status model treat `workspace connected + Veslo connected` as ready, even when `clientConnected` is false. Keep the change local to the sidebar model and its immediate callers so underlying engine activation semantics stay unchanged.

**Tech Stack:** SolidJS, TypeScript, Node test runner

---

### Task 1: Cover browsing mode status in tests

**Files:**
- Modify: `packages/app/src/app/components/sidebar-status-controls.model.test.ts`

**Step 1: Write the failing test**

Add a unit test asserting that the unified status becomes `Ready` when:
- `clientConnected === false`
- `vesloServerStatus === "connected"`
- active workspace connection status is `"connected"`

**Step 2: Run test to verify it fails**

Run: `node --test src/app/components/sidebar-status-controls.model.test.ts`
Expected: FAIL because the model still returns `Unavailable`

### Task 2: Implement the minimal sidebar status change

**Files:**
- Modify: `packages/app/src/app/components/sidebar-status-controls.model.ts`
- Modify: `packages/app/src/app/components/sidebar-status-controls.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`

**Step 1: Thread active workspace connection state**

Compute the active workspace connection status in dashboard/session and pass it into `SidebarStatusControls`.

**Step 2: Update the unified status model**

Treat the sidebar status as `Ready` when Veslo is connected and either:
- the client is connected, or
- the active workspace connection status is `connected`

**Step 3: Keep the rest of the UI unchanged**

Do not alter engine/workspace switching, settings diagnostics, or workspace session list dots.

### Task 3: Verify the change

**Files:**
- Test: `packages/app/src/app/components/sidebar-status-controls.model.test.ts`

**Step 1: Run focused tests**

Run:
- `node --test src/app/components/sidebar-status-controls.model.test.ts`
- `pnpm --filter @neatech/veslo-ui typecheck`

**Step 2: Run broader relevant unit coverage if needed**

Run: `pnpm --filter @neatech/veslo-ui test:unit`
Expected: PASS
