# Titlebar Nonselectable Text Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the app, session, and project labels in the titlebar non-selectable so dragging the window does not highlight titlebar text.

**Architecture:** Keep the behavior in the shared titlebar chrome. Add selection-prevention classes to the text containers that render the brand and centered session context without changing button hit areas or the Tauri drag strip.

**Tech Stack:** SolidJS, Tailwind utility classes, Node test runner.

---

### Task 1: Guard Titlebar Text Selection

**Files:**
- Modify: `packages/app/src/app/components/titlebar-menu-toggles.test.ts`
- Modify: `packages/app/src/app/components/titlebar-menu-toggles.tsx`

**Step 1: Write the failing test**

Add a test requiring `select-none` on the shared titlebar brand label and the centered titlebar content wrapper.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/titlebar-menu-toggles.test.ts`

Expected: FAIL because the selection-prevention class is missing.

**Step 3: Write minimal implementation**

Add `select-none` to the brand label and centered content text wrapper in the shared titlebar component.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/titlebar-menu-toggles.test.ts`

Expected: PASS.

**Step 5: Run verification**

Run: `pnpm typecheck`

Expected: PASS.
