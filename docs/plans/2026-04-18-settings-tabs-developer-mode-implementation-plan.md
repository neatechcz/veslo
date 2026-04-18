# Settings Tabs in Developer Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore `model` and `advanced` Settings tabs whenever developer mode is enabled, while keeping them hidden otherwise.

**Architecture:** The fix is a small contract repair in the shared settings visibility helper plus the Settings page tab list. Existing render branches and navigation entry points already exist, so the implementation should only restore visibility rules and update tests/docs to match.

**Tech Stack:** SolidJS, TypeScript, Node test runner

---

### Task 1: Restore the developer-mode Settings tab contract

**Files:**
- Modify: `packages/app/src/app/pages/settings-tabs-layout.test.ts`
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`
- Modify: `packages/app/src/app/lib/settings-tab-label.ts`
- Modify: `packages/app/src/app/pages/settings.tsx`
- Test: `packages/app/src/app/pages/settings-tabs-layout.test.ts`
- Test: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Write the failing test**

- Change the tests so developer mode expects `model` and `advanced` to remain visible.
- Keep non-developer mode expectations unchanged.

**Step 2: Run test to verify it fails**

Run: `node --test --import=tsx/esm src/app/pages/settings-tabs-layout.test.ts src/app/pages/dashboard-menu-navigation.test.ts`

Expected: FAIL because the current helper maps `model` and `advanced` to `general`, and the Settings tab list omits both tabs.

**Step 3: Write minimal implementation**

- Restore `model` and `advanced` in the developer-mode visible tab helper.
- Restore `settings.model` and `settings.advanced` label mappings.
- Add `model` and `advanced` back to the developer-mode Settings tab list.

**Step 4: Run test to verify it passes**

Run: `node --test --import=tsx/esm src/app/pages/settings-tabs-layout.test.ts src/app/pages/dashboard-menu-navigation.test.ts`

Expected: PASS

### Task 2: Update shipped Settings documentation

**Files:**
- Modify: `docs/features/settings-and-preferences.md`

**Step 1: Update docs**

- Document that developer mode exposes `model`, `advanced`, and `debug` in addition to the always-visible tabs.

**Step 2: Verify docs match code**

- Cross-check the updated doc against `packages/app/src/app/pages/settings.tsx` and the shared visibility helper.
