# Archived Sessions Settings Tab Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a first-class `Archived` settings tab, move the archived-session management UI into it, and route sidebar `Archived items` navigation directly to that tab.

**Architecture:** Keep archive storage and archive loading untouched. The change stays in the app shell: extend the settings-tab model and localization, move the existing archived-session block from the `General` branch to a new `Archived` branch in `settings.tsx`, and update the sidebar parent surfaces to call `openSettings("archived")` instead of `openSettings("general")`.

**Tech Stack:** SolidJS (`createMemo`, `Switch`, `Match`, JSX), app i18n locale tables, source-contract tests with Node test runner (`node --test --import=tsx/esm`), Tauri desktop runtime, WebdriverIO e2e.

---

Execution notes:

- Apply `@using-git-worktrees` before the first implementation commit.
- Apply `@test-driven-development` for each task below.
- Consult `.opencode/skills/solidjs-patterns/SKILL.md` before editing `packages/app/src/app/pages/settings.tsx`.
- Apply `@verification-before-completion` before claiming the feature is complete.
- Follow `AGENTS.md` feature workflow during execution: sync remotes/submodules, use a worktree, start the Docker dev stack, test the real desktop runtime, and save screenshots in-repo.
- Never run the web app from `packages/web`.

Pre-flight commands:

```bash
git fetch --all --prune
git submodule update --init --recursive
git worktree add ../Veslo-archived-settings-tab -b codex/archived-settings-tab
cd ../Veslo-archived-settings-tab
```

### Task 1: Extend The Settings Tab Model And Labels

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/lib/settings-tab-label.ts`
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write the failing test**

Extend `packages/app/src/app/pages/dashboard-menu-navigation.test.ts` so it proves `archived` is a first-class settings tab and that localization exists in all shipped locales:

```ts
test("settings tab labels include archived and keep debug gated", () => {
  assert.equal(resolveVisibleSettingsTab("archived", false), "archived");
  assert.equal(resolveVisibleSettingsTab("archived", true), "archived");
  assert.equal(resolveVisibleSettingsTab("debug", false), "general");
  assert.equal(resolveVisibleSettingsTab("debug", true), "debug");

  assert.match(settingsTabLabelSource, /archived:\s*"settings\.archived"/);
  assert.match(
    settingsTabLabelSource,
    /const visibleSettingsTabs: SettingsTab\[] = \["general", "archived", "model", "advanced"\]/,
  );

  const enLocale = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
  const csLocale = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
  const zhLocale = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

  assert.match(enLocale, /"settings\.archived":\s*"Archived"/);
  assert.match(csLocale, /"settings\.archived":\s*"Archivované"/);
  assert.match(zhLocale, /"settings\.archived":\s*"已归档"/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: FAIL because `SettingsTab` and the shared label helper do not yet know about `archived`, and the locale key does not exist.

**Step 3: Write minimal implementation**

Update the settings tab model and label resolver:

```ts
// types.ts
export type SettingsTab = "general" | "archived" | "model" | "advanced" | "debug";
```

```ts
// settings-tab-label.ts
const settingsTabLabelKeyByTab: Record<SettingsTab, string> = {
  general: "settings.general",
  archived: "settings.archived",
  model: "settings.model",
  advanced: "settings.advanced",
  debug: "settings.debug",
};

const visibleSettingsTabs: SettingsTab[] = ["general", "archived", "model", "advanced"];
```

Then add locale entries to `en.ts`, `cs.ts`, and `zh.ts` for `settings.archived`.

**Step 4: Run test to verify it passes**

Run the same command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/types.ts \
  packages/app/src/app/lib/settings-tab-label.ts \
  packages/app/src/app/pages/dashboard-menu-navigation.test.ts \
  packages/app/src/i18n/locales/en.ts \
  packages/app/src/i18n/locales/cs.ts \
  packages/app/src/i18n/locales/zh.ts
git commit -m "feat(app): add archived settings tab metadata"
```

### Task 2: Move Archived Session Management Into Its Own Settings Tab

**Files:**
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/pages/settings-archived-sessions.test.ts`

**Step 1: Write the failing test**

Expand `packages/app/src/app/pages/settings-archived-sessions.test.ts` so it proves the archive block lives in the `archived` branch and no longer lives in `general`:

```ts
test("settings renders archived sessions inside the archived tab only", () => {
  const archivedMatch = source.match(/<Match when=\{activeTab\(\) === "archived"\}>[\s\S]*?<\/Match>/);
  const generalMatch = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/);

  assert.ok(archivedMatch, "archived tab branch should exist");
  assert.ok(generalMatch, "general tab branch should exist");
  assert.match(archivedMatch[0], /settings\.archived_sessions_label/);
  assert.match(archivedMatch[0], /props\.sessionArchives/);
  assert.match(archivedMatch[0], /props\.onUnarchiveSession/);
  assert.doesNotMatch(generalMatch[0], /settings\.archived_sessions_label/);
});

test("settings tab list includes archived between general and model", () => {
  assert.match(source, /const tabs: SettingsTab\[] = \["general", "archived", "model", "advanced"\]/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/settings-archived-sessions.test.ts
```

Expected: FAIL because the archived-session block still renders inside the `general` branch and the available tab list does not include `archived`.

**Step 3: Write minimal implementation**

Update `settings.tsx` in three places:

1. Add `archived` to `availableTabs()`:

```tsx
const availableTabs = createMemo<SettingsTab[]>(() => {
  const tabs: SettingsTab[] = ["general", "archived", "model", "advanced"];
  if (props.developerMode) tabs.push("debug");
  return tabs;
});
```

2. Remove the archived-session block from the `general` tab.
3. Add a dedicated branch:

```tsx
<Match when={activeTab() === "archived"}>
  <div class="space-y-6">
    <Show when={props.sessionArchives !== undefined}>
      {/* existing archived session card, unchanged logic */}
    </Show>
  </div>
</Match>
```

Keep all existing helpers and UI copy for:

- `archivedSessionRows()`
- `formatArchivedSessionTitle(...)`
- `formatArchivedSessionLocation(...)`
- `handleUnarchiveArchivedSession(...)`

Do not change the archive data source or the unarchive handler contract.

**Step 4: Run test to verify it passes**

Run the same command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/pages/settings.tsx \
  packages/app/src/app/pages/settings-archived-sessions.test.ts
git commit -m "refactor(app): move archived sessions into dedicated settings tab"
```

### Task 3: Rewire Sidebar Archived Navigation To The New Tab

**Files:**
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Create: `packages/app/src/app/pages/sidebar-archived-settings-navigation.test.ts`

**Step 1: Write the failing test**

Create `packages/app/src/app/pages/sidebar-archived-settings-navigation.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("dashboard routes archived items to settings archived", () => {
  assert.match(dashboardSource, /onOpenArchivedSessions=\{\(\) => openSettings\("archived"\)\}/);
  assert.doesNotMatch(dashboardSource, /onOpenArchivedSessions=\{\(\) => openSettings\("general"\)\}/);
});

test("session routes archived items to settings archived", () => {
  assert.match(sessionSource, /onOpenArchivedSessions=\{\(\) => openSettings\("archived"\)\}/);
  assert.doesNotMatch(sessionSource, /onOpenArchivedSessions=\{\(\) => openSettings\("general"\)\}/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/sidebar-archived-settings-navigation.test.ts
```

Expected: FAIL because both parent surfaces still call `openSettings("general")`.

**Step 3: Write minimal implementation**

Update both parent views:

```tsx
// dashboard.tsx
onOpenArchivedSessions={() => openSettings("archived")}

// session.tsx
onOpenArchivedSessions={() => openSettings("archived")}
```

Do not change any other sidebar action wiring in this task.

**Step 4: Run test to verify it passes**

Run the same command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/pages/dashboard.tsx \
  packages/app/src/app/pages/session.tsx \
  packages/app/src/app/pages/sidebar-archived-settings-navigation.test.ts
git commit -m "feat(app): route archived items to archived settings tab"
```

### Task 4: Lock The Desktop Flow With E2E And Capture Screenshots

**Files:**
- Modify: `packages/e2e/specs/sidebar-primary-actions-overflow.spec.ts`
- Create: `docs/plans/assets/2026-04-14-archived-settings-tab-sidebar.png`
- Create: `docs/plans/assets/2026-04-14-archived-settings-tab-settings.png`

**Step 1: Write the failing test**

Tighten `packages/e2e/specs/sidebar-primary-actions-overflow.spec.ts` so it proves the archived-items action no longer lands on `General`:

```ts
it("shows the approved top rail and routes archived items to the archived settings tab", async () => {
  // existing top-rail assertions stay

  await clickOverflowMenuItem(copy.archivedItems);

  await browser.waitUntil(
    async () => (await browser.getUrl()).includes('#/dashboard/settings'),
    { timeout: 10000, interval: 250 },
  );

  await browser.waitUntil(
    async () => bodyContainsLabel(copy.archivedSection),
    { timeout: 10000, interval: 250 },
  );

  expect(await bodyContainsLabel('Providers')).toBe(false);
});
```

This should fail against the current implementation because archived items still open `General`, where the `Providers` card is visible.

**Step 2: Run desktop E2E to verify it fails**

Run:

```bash
./packaging/docker/dev-up.sh
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/sidebar-primary-actions-overflow.spec.ts
```

Expected: FAIL in the WebdriverIO assertion because `Providers` is still visible after selecting `Archived items`.

**Step 3: Write minimal implementation**

No new app code should be needed in this task if Tasks 1-3 are complete. Only keep the updated e2e assertion and, if needed, add a small helper assertion that confirms the new archived tab body is visible without depending on localized tab-button internals.

Then perform the required manual runtime verification from `AGENTS.md`:

- use the real desktop runtime, not `packages/web`
- verify the overflow menu
- verify `Archived items` opens the archived tab
- verify the archived tab shows either archived rows or the archived empty state
- capture screenshots into:
  - `docs/plans/assets/2026-04-14-archived-settings-tab-sidebar.png`
  - `docs/plans/assets/2026-04-14-archived-settings-tab-settings.png`

Use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` for the Chrome MCP manual pass.

**Step 4: Run verification to verify it passes**

Run the same commands from Step 2.

Expected:

- Tauri debug build succeeds
- the WebdriverIO spec passes
- manual desktop verification confirms the archived-tab destination
- screenshots are present in `docs/plans/assets/`

**Step 5: Commit**

```bash
git add \
  packages/e2e/specs/sidebar-primary-actions-overflow.spec.ts \
  docs/plans/assets/2026-04-14-archived-settings-tab-sidebar.png \
  docs/plans/assets/2026-04-14-archived-settings-tab-settings.png
git commit -m "test(e2e): verify archived settings tab navigation"
```
