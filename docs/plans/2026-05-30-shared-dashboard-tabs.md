# Shared Dashboard Tabs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reuse the Settings tab rail on the dashboard pages linked by that rail.

**Architecture:** Move the tab rail into a shared Solid component. Settings and dashboard page rendering call the same component with the active tab and existing navigation callbacks.

**Tech Stack:** SolidJS, TypeScript, Node test runner, source-level layout tests, WebdriverIO selector contract.

---

### Task 1: Failing Coverage

**Files:**
- Modify: `packages/app/src/app/pages/settings-tabs-layout.test.ts`
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Steps:**
1. Add assertions that Settings imports and renders a shared tab component instead of a private tab list.
2. Add assertions that dashboard non-Settings pages render the same component.
3. Run:
   `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/settings-tabs-layout.test.ts src/app/pages/dashboard-menu-navigation.test.ts`
4. Expected: FAIL because the shared component does not exist yet.

### Task 2: Shared Component

**Files:**
- Create: `packages/app/src/app/components/dashboard-tab-rail.tsx`
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`

**Steps:**
1. Move the Settings tab rail item model, labels, and button markup into the shared component.
2. Preserve `data-settings-nav-kind`, `data-settings-nav-tab`, and `aria-current`.
3. Wire Settings to open `General` and `Archived` through `setSettingsTab`.
4. Wire dashboard pages to open dashboard tabs through `handleDashboardTabSelection`.
5. Run focused tests and typecheck.
6. Commit the implementation.

### Task 3: Final Verification

**Files:**
- Test only unless verification finds a regression.

**Steps:**
1. Run focused Settings/dashboard tests.
2. Run `pnpm --filter @neatech/veslo-ui typecheck`.
3. Run `pnpm --filter @neatech/veslo-ui test:i18n`.
4. Run `pnpm --filter @neatech/veslo-e2e exec tsc -p tsconfig.json --noEmit`.
5. Report any desktop E2E gap if the required single-tenant preflight is blocked.
