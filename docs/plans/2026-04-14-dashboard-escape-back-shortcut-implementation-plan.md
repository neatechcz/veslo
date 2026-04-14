# Dashboard Escape Back Shortcut Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `Escape` in the dashboard behave like the header back button and return to the current session from dashboard sections.

**Architecture:** Add a small keyboard guard helper in the dashboard navigation module, then wire a single `window` keydown listener in `dashboard.tsx` to call the existing `returnToSession()` action. Keep the shortcut dormant while modal-style overlays are open.

**Tech Stack:** SolidJS, TypeScript, node:test source-contract tests

---

### Task 1: Lock the escape contract with tests

**Files:**
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Write the failing test**
- Add helper tests for the ESC shortcut guard.
- Add a dashboard source-contract assertion that `dashboard.tsx` listens for `keydown` and routes accepted `Escape` presses to `returnToSession()`.

**Step 2: Run test to verify it fails**
Run: `cd packages/app && node --test --import=tsx/esm src/app/pages/dashboard-menu-navigation.test.ts`
Expected: FAIL because the helper and dashboard keydown wiring do not exist yet.

**Step 3: Write minimal implementation**
- Add the ESC shortcut guard helper to `packages/app/src/app/pages/dashboard-menu-navigation.ts`.
- Register a `window` keydown listener in `packages/app/src/app/pages/dashboard.tsx` that prevents default and calls `returnToSession()` when the helper returns `true`.

**Step 4: Run test to verify it passes**
Run: `cd packages/app && node --test --import=tsx/esm src/app/pages/dashboard-menu-navigation.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add docs/plans/2026-04-14-dashboard-escape-back-shortcut-design.md \
  docs/plans/2026-04-14-dashboard-escape-back-shortcut-implementation-plan.md \
  packages/app/src/app/pages/dashboard-menu-navigation.ts \
  packages/app/src/app/pages/dashboard-menu-navigation.test.ts \
  packages/app/src/app/pages/dashboard.tsx

git commit -m "fix: support escape return from dashboard"
```
