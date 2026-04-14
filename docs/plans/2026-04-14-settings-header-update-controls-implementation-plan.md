# Settings Header Update Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the compact update status and primary update action from the settings body into the dashboard settings header next to the `Settings` title.

**Architecture:** Keep the update state derivation in `SettingsView`, expose a small header-only cluster when the dashboard tab is `settings`, and remove the duplicate inline row from the General settings content. Preserve the detailed update card for toggles and metadata.

**Tech Stack:** SolidJS, TypeScript, node:test contract tests

---

### Task 1: Lock the new header placement with tests

**Files:**
- Modify: `packages/app/src/app/pages/settings-tabs-layout.test.ts`
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Write the failing test**
- Update the settings layout test to expect the old compact update row to be absent from `settings.tsx`.
- Update the dashboard header test to expect update controls to exist in the settings header path.

**Step 2: Run test to verify it fails**
Run: `cd packages/app && node --test --import=tsx/esm src/app/pages/settings-tabs-layout.test.ts src/app/pages/dashboard-menu-navigation.test.ts`
Expected: FAIL because the current implementation still renders the old row in `settings.tsx` and does not render the new header cluster.

**Step 3: Write minimal implementation**
- Move the compact update status/action rendering into the dashboard header path for `tab === "settings"`.
- Remove the old duplicate row from the General settings content.

**Step 4: Run test to verify it passes**
Run: `cd packages/app && node --test --import=tsx/esm src/app/pages/settings-tabs-layout.test.ts src/app/pages/dashboard-menu-navigation.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add packages/app/src/app/pages/settings.tsx \
  packages/app/src/app/pages/settings-tabs-layout.test.ts \
  packages/app/src/app/pages/dashboard-menu-navigation.test.ts

git commit -m "fix: move settings update controls into header"
```
