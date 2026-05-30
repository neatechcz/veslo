# Settings Dashboard Link Tabs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Settings tab-bar links for Automations, Soul, Skills, and Extensions that navigate to the existing dashboard pages while removing the legacy Settings `Skills & MCP` tab.

**Architecture:** Keep the existing dashboard pages and left menu unchanged. Extend `SettingsView` with link-style tab entries that call back into `DashboardView`, where the existing dashboard navigation handler already knows how to open each dashboard tab. Keep `SettingsTab` for Settings-owned content only, so removed or invalid Settings tabs fall back to `general`.

**Tech Stack:** SolidJS, TypeScript, node:test source-level UI tests, existing Veslo i18n helpers.

---

### Task 1: Add Failing Settings Tab-Bar Tests

**Files:**
- Modify: `packages/app/src/app/pages/settings-tabs-layout.test.ts`
- Modify: `packages/app/src/app/pages/settings-archived-sessions.test.ts`
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Update the Settings layout test expectations**

In `packages/app/src/app/pages/settings-tabs-layout.test.ts`, change the first test to expect `general` and `archived` as the only real Settings tabs, and add assertions for dashboard link tabs:

```ts
assert.match(source, /const tabs: SettingsTab\[\] = \["general", "archived"\]/);
assert.match(source, /kind:\s*"dashboard"[\s\S]*tab:\s*"scheduled"/);
assert.match(source, /kind:\s*"dashboard"[\s\S]*tab:\s*"soul"/);
assert.match(source, /kind:\s*"dashboard"[\s\S]*tab:\s*"skills"/);
assert.match(source, /kind:\s*"dashboard"[\s\S]*tab:\s*"mcp"/);
assert.match(source, /props\.onOpenDashboardTab\?\.\(item\.tab\)/);
assert.doesNotMatch(source, /<ExtensionsOverview/);
assert.doesNotMatch(source, /<Match when=\{activeTab\(\) === "extensions"\}>/);
```

Update the locale-label test name from archived-only to Settings and dashboard labels. Keep the `settings.archived` checks and add source assertions that dashboard link labels use `nav.automations`, `nav.soul`, `nav.skills`, and `nav.extensions`.

**Step 2: Update archived sessions test**

In `packages/app/src/app/pages/settings-archived-sessions.test.ts`, change:

```ts
assert.match(source, /const tabs: SettingsTab\[] = \["general", "extensions", "archived"\]/);
```

to:

```ts
assert.match(source, /const tabs: SettingsTab\[] = \["general", "archived"\]/);
assert.doesNotMatch(source, /const tabs: SettingsTab\[] = \["general", "extensions", "archived"\]/);
assert.doesNotMatch(source, /<Match when=\{activeTab\(\) === "extensions"\}>/);
```

**Step 3: Update dashboard navigation tests**

In `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`, update the Settings label expectations:

```ts
assert.match(
  settingsTabLabelSource,
  /const visibleSettingsTabs: SettingsTab\[] = \["general", "archived"\]/,
);
assert.doesNotMatch(settingsTabLabelSource, /extensions:\s*"settings\.extensions"/);
```

Add an assertion that `DashboardView` passes a callback into `SettingsView`:

```ts
assert.match(
  dashboardSource,
  /<SettingsView[\s\S]*onOpenDashboardTab=\{\(nextTab\)\s*=>\s*handleDashboardTabSelection\(nextTab\)\}/,
);
```

**Step 4: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/pages/settings-tabs-layout.test.ts \
  src/app/pages/settings-archived-sessions.test.ts \
  src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: FAIL because the Settings tab list still includes `extensions`, `SettingsView` still renders `ExtensionsOverview`, and there is no dashboard-link callback prop yet.

**Step 5: Commit failing tests**

```bash
git add packages/app/src/app/pages/settings-tabs-layout.test.ts \
  packages/app/src/app/pages/settings-archived-sessions.test.ts \
  packages/app/src/app/pages/dashboard-menu-navigation.test.ts
git commit -m "test: cover settings dashboard link tabs"
```

---

### Task 2: Add Dashboard Link Tabs To Settings

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/lib/settings-tab-label.ts`
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`

**Step 1: Narrow the SettingsTab type**

In `packages/app/src/app/types.ts`, remove `extensions` from `SettingsTab`:

```ts
export type SettingsTab = "general" | "archived" | "advanced" | "debug";
```

Leave `advanced` and `debug` in the type because `settings.tsx` still contains developer-only branches that are intentionally hidden by `resolveVisibleSettingsTab`.

**Step 2: Remove the legacy Settings label**

In `packages/app/src/app/lib/settings-tab-label.ts`, remove the `extensions` label mapping and change visible tabs:

```ts
const settingsTabLabelKeyByTab: Partial<Record<SettingsTab, string>> = {
  general: "settings.general",
  archived: "settings.archived",
  advanced: "settings.advanced",
  debug: "settings.debug",
};

const visibleSettingsTabs: SettingsTab[] = ["general", "archived"];
```

**Step 3: Add dashboard link tab types in SettingsView**

In `packages/app/src/app/pages/settings.tsx`, remove:

```ts
import ExtensionsOverview from "./extensions-overview";
```

Change the type import to include `DashboardTab`:

```ts
import type { DashboardTab, OpencodeConnectStatus, SessionArchiveItem, SettingsTab, StartupPreference } from "../types";
```

Add the callback prop:

```ts
onOpenDashboardTab?: (tab: DashboardTab) => void;
```

Remove the now-unused `workspaces` prop from `SettingsViewProps` if no other Settings-owned section uses it:

```ts
// remove:
workspaces: WorkspaceInfo[];
```

Then remove `WorkspaceInfo` from the Tauri type import in `settings.tsx` if it becomes unused.

Add local nav item types near `SettingsViewProps`:

```ts
type SettingsNavItem =
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "dashboard"; tab: Extract<DashboardTab, "scheduled" | "soul" | "skills" | "mcp"> };
```

**Step 4: Build the mixed tab list**

Replace the current `availableTabs` memo with:

```ts
const settingsTabs = createMemo<SettingsTab[]>(() => {
  const tabs: SettingsTab[] = ["general", "archived"];
  return tabs;
});

const dashboardLinkTabs = createMemo<SettingsNavItem[]>(() => [
  { kind: "dashboard", tab: "scheduled" },
  { kind: "dashboard", tab: "soul" },
  { kind: "dashboard", tab: "skills" },
  { kind: "dashboard", tab: "mcp" },
]);

const availableTabs = createMemo<SettingsNavItem[]>(() => [
  ...settingsTabs().map((tab): SettingsNavItem => ({ kind: "settings", tab })),
  ...dashboardLinkTabs(),
]);
```

Add a label helper:

```ts
const resolveDashboardTabLabel = (tab: Extract<DashboardTab, "scheduled" | "soul" | "skills" | "mcp">) => {
  switch (tab) {
    case "scheduled":
      return translate("nav.automations");
    case "soul":
      return translate("nav.soul");
    case "skills":
      return translate("nav.skills");
    case "mcp":
      return translate("nav.extensions");
  }
};

const resolveNavItemLabel = (item: SettingsNavItem) =>
  item.kind === "settings" ? resolveSettingsTabLabel(item.tab) : resolveDashboardTabLabel(item.tab);
```

Add a click helper:

```ts
const selectNavItem = (item: SettingsNavItem) => {
  if (item.kind === "settings") {
    props.setSettingsTab(item.tab);
    return;
  }
  props.onOpenDashboardTab?.(item.tab);
};
```

**Step 5: Render mixed tabs**

In the tab button loop, replace direct `activeTab() === tab` checks with:

```tsx
activeTab() === item.tab
```

only for Settings items:

```tsx
const active = item.kind === "settings" && activeTab() === item.tab;
```

Then use:

```tsx
onClick={() => selectNavItem(item)}
```

and:

```tsx
{resolveNavItemLabel(item)}
```

Keep dashboard link tabs visually identical to the existing tab buttons, but they should never render as active while the app is still on the Settings page.

**Step 6: Remove legacy ExtensionsOverview branch**

Delete this branch from `settings.tsx`:

```tsx
<Match when={activeTab() === "extensions"}>
  <ExtensionsOverview workspaces={props.workspaces} />
</Match>
```

**Step 7: Wire DashboardView**

In `packages/app/src/app/pages/dashboard.tsx`, pass the callback to `SettingsView`:

```tsx
onOpenDashboardTab={(nextTab) => handleDashboardTabSelection(nextTab)}
```

Remove the old SettingsView prop pass if Task 2 removed it:

```tsx
// remove:
workspaces={props.workspaces}
```

**Step 8: Run focused tests and verify pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/pages/settings-tabs-layout.test.ts \
  src/app/pages/settings-archived-sessions.test.ts \
  src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: PASS.

**Step 9: Commit implementation**

```bash
git add packages/app/src/app/types.ts \
  packages/app/src/app/lib/settings-tab-label.ts \
  packages/app/src/app/pages/settings.tsx \
  packages/app/src/app/pages/dashboard.tsx
git commit -m "feat: add settings dashboard link tabs"
```

---

### Task 3: Remove Legacy Settings Extensions Copy And Update Docs

**Files:**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Modify: `docs/features/settings-and-preferences.md`
- Modify: `docs/features/extensions-and-integrations.md`

**Step 1: Remove unused Settings extension label**

Remove the `settings.extensions` key from each locale file if `rg "settings\\.extensions"` shows no runtime references after Task 2.

Run:

```bash
rg -n "settings\\.extensions" packages/app/src docs
```

Expected before removal: locale keys and tests only. Expected after removal: no matches outside historical `docs/plans`.

**Step 2: Update Settings documentation**

In `docs/features/settings-and-preferences.md`, change the visible tabs list from:

```md
- `general`
- `archived`
- `model` when developer mode is enabled
- `advanced` when developer mode is enabled
- `debug` when developer mode is enabled
```

to:

```md
- `general`
- `archived`
```

Add a short section:

```md
## Settings Link Tabs

Settings also shows link-style tabs for the main dashboard surfaces:

- `Automations`
- `Soul`
- `Skills`
- `Extensions`

These are navigation links, not Settings-owned content sections. They open the
same dashboard pages as the left menu and do not duplicate page content inside
Settings.
```

Remove the legacy `Extensions Overview` section or replace it with:

```md
The previous Settings `Skills & MCP` overview has been removed. Skills and
MCP/Extensions remain first-class dashboard pages reached from the left menu
or from the Settings link tabs.
```

**Step 3: Update extensions documentation**

In `docs/features/extensions-and-integrations.md`, update the source-of-truth wording so it does not imply Settings contains the legacy overview. Keep Skills and MCP source-of-truth entries pointing at existing pages.

**Step 4: Run i18n and focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/pages/settings-tabs-layout.test.ts \
  src/app/pages/settings-archived-sessions.test.ts \
  src/app/pages/dashboard-menu-navigation.test.ts \
  src/app/extensions-screen-simplification.test.ts
```

Expected: PASS.

**Step 5: Commit docs and locale cleanup**

```bash
git add packages/app/src/i18n/locales/en.ts \
  packages/app/src/i18n/locales/cs.ts \
  packages/app/src/i18n/locales/zh.ts \
  docs/features/settings-and-preferences.md \
  docs/features/extensions-and-integrations.md
git commit -m "docs: document settings dashboard link tabs"
```

---

### Task 4: Final Verification

**Files:**
- No source edits unless verification exposes an issue.

**Step 1: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 2: Run unit tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Decide whether desktop runtime is needed**

This change is app navigation composition and can be covered by source-level tests and typecheck. Do not start `packages/web`, raw Vite, or `pnpm -w dev:ui`.

If interactive verification is requested or source tests are insufficient, use the desktop runtime procedure from `docs/dev/testing-playbook.md`:

1. run the Veslo desktop process preflight
2. build the desktop e2e binary if needed
3. verify in the real Tauri runtime

**Step 4: Commit any verification fixes**

If fixes are needed, commit only the files changed for this task:

```bash
git add <changed-files>
git commit -m "fix: stabilize settings dashboard link tabs"
```

**Step 5: Report verification**

Final report should include:

- Settings tab bar now shows `General`, `Archived`, `Automations`, `Soul`, `Skills`, `Extensions`
- left menu remains unchanged
- `Automations`, `Soul`, `Skills`, and `Extensions` Settings tabs navigate to the existing dashboard pages
- commands run and whether they passed
