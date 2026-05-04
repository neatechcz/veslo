# Remove Development Mode Entry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove every clickable or launch-parameter path that can enter Developer Mode in Veslo.

**Architecture:** Developer mode remains a disabled internal gate, but no UI, route, storage value, search parameter, or prop callback can enable it. The Settings UI exposes only normal user tabs, and dashboard direct navigation continues to fall back to the normal dashboard when developer-only views are requested.

**Tech Stack:** SolidJS app shell, TypeScript source-level tests with `node:test`, WebdriverIO desktop E2E specs.

---

### Task 1: Add Failing App Tests For Removed Developer Mode Entry

**Files:**
- Modify: `packages/app/src/app/pages/settings-tabs-layout.test.ts`
- Modify: `packages/app/src/app/pages/settings-archived-sessions.test.ts`
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Write the failing tests**

Update the existing settings tests so they expect:

```ts
assert.doesNotMatch(source, /toggleDeveloperMode/);
assert.doesNotMatch(generalSection, /Developer mode|Enable Developer Mode|Disable Developer Mode/);
assert.doesNotMatch(source, /if \(props\.developerMode\) tabs\.push\("advanced", "debug"\);/);
```

Update the tab helper expectations so legacy truthy developer mode does not expose hidden tabs:

```ts
assert.equal(resolveVisibleSettingsTab("advanced", true), "general");
assert.equal(resolveVisibleSettingsTab("debug", true), "general");
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- settings-tabs-layout settings-archived-sessions dashboard-menu-navigation
```

Expected: FAIL because Developer Mode controls and truthy developer tab behavior still exist.

### Task 2: Remove Settings Toggle And Developer Tab Entry Plumbing

**Files:**
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/lib/settings-tab-label.ts`

**Step 1: Implement the minimal code**

Remove `toggleDeveloperMode` from `SettingsView` and `DashboardView` props and call sites.

Remove the Settings general-tab Developer Mode card.

Change the settings tab helper to always allow only normal visible tabs:

```ts
export const resolveVisibleSettingsTab = (settingsTab: SettingsTab, _developerMode: boolean) => {
  return visibleSettingsTabs.includes(settingsTab) ? settingsTab : "general";
};
```

Change `SettingsView` available tabs so it only returns `["general", "archived"]`.

Replace the app-level writable developer signal with a non-enablable accessor, or otherwise remove all setter paths:

```ts
const developerMode = () => false;
```

Remove reset-time calls to `setDeveloperMode(false)`.

**Step 2: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- settings-tabs-layout settings-archived-sessions dashboard-menu-navigation
```

Expected: PASS.

### Task 3: Cover Launch/Search/Stored Attempts

**Files:**
- Modify: `packages/app/src/app/pages/settings-tabs-layout.test.ts`
- Modify: `packages/e2e/specs/navigation.spec.ts`
- Modify: `packages/e2e/specs/den-managed-openai-anthropic.spec.ts`

**Step 1: Write or adjust tests**

Add source-level assertions that the app no longer reads or writes the legacy storage key or developer search terms:

```ts
assert.doesNotMatch(appSource, /veslo\.developerMode/);
assert.doesNotMatch(appSource, /setDeveloperMode/);
```

Update E2E navigation to assert Settings does not show the enable/disable Developer Mode controls. For direct config navigation, remove the helper that clicks the old toggle and expect the route to fall back away from config.

Update the managed AI E2E helper so it does not try to enable Developer Mode.

**Step 2: Run tests to verify failures before implementation if any old paths remain**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- settings-tabs-layout
```

Expected before implementation: FAIL if stale setter/storage/parameter paths remain.

**Step 3: Implement minimal fixes**

Remove stale E2E toggle helpers and stale `veslo.developerMode` diagnostic capture.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- settings-tabs-layout
```

Expected: PASS.

### Task 4: Final Verification

**Files:**
- No new implementation files unless tests identify a missed path.

**Step 1: Run app checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Run desktop/E2E focused check if the desktop binary is available**

Follow the desktop preflight from `docs/dev/testing-playbook.md`, then run the focused navigation spec against the real Tauri runtime:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/navigation.spec.ts
```

Expected: PASS.

**Step 3: Document verification**

Record exact commands, pass/fail status, and any desktop verification gaps in the final response.
