# Sidebar Primary Actions Overflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Promote `New` and `Add directory / project` to the only always-visible sidebar CTAs, move `Archived items`, `Search`, `By project`, and `Recent` into an overflow menu, and route archive management to the existing settings archive list.

**Architecture:** Keep the change local to the app shell and session sidebar. `WorkspaceSessionList` owns the new three-button top rail and overflow menu, while `session.tsx` and `dashboard.tsx` pass through a new archived-items navigation callback that reuses the existing `openSettings("general")` flow. Removing the old sidebar archive toggle also removes its local-storage preference so archived sessions are never shown inline in the sidebar anymore.

**Tech Stack:** SolidJS (`createSignal`, `createMemo`, JSX), `lucide-solid`, app i18n locale tables, Node test runner (`node --test --import=tsx/esm`), Tauri desktop runtime, WebdriverIO e2e.

---

Execution notes:

- Apply `@using-git-worktrees` before the first implementation commit.
- Apply `@test-driven-development` for each behavior change below.
- Consult `.opencode/skills/solidjs-patterns/SKILL.md` before editing SolidJS UI.
- Apply `@verification-before-completion` before claiming the feature is done.
- Follow `AGENTS.md` feature workflow: sync remotes/submodules, use a worktree, start Docker dev stack, test the real Tauri desktop app, and capture screenshots in-repo.
- Never run the web app from `packages/web`; desktop verification must use `packages/desktop`.

Pre-flight commands:

```bash
git fetch --all --prune
git submodule update --init --recursive
git worktree add ../Veslo-sidebar-primary-actions-overflow -b codex/sidebar-primary-actions-overflow
cd ../Veslo-sidebar-primary-actions-overflow
```

### Task 1: Lock The New Top-Rail Contract In Tests

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts`
- Create: `packages/app/src/app/components/session/workspace-session-list-overflow-menu.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`

**Step 1: Write the failing test**

Update the existing source-contract tests so they expect the new top-level control order and create a focused overflow-menu contract test:

```ts
// workspace-session-list-layout.test.ts
assert.match(
  source,
  /data-tooltip=\{tr\("sidebar\.new_session"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.add_directory_or_project"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.more_actions"\)\}/,
  "control row should keep new, add-directory-or-project, and overflow actions in order",
);

assert.doesNotMatch(
  source,
  /data-tooltip=\{tr\("sidebar\.by_project"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.recent"\)\}/,
  "by-project and recent should no longer be top-level controls",
);
```

```ts
// workspace-session-list-overflow-menu.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("overflow menu contains only the approved secondary actions", () => {
  assert.match(
    source,
    /tr\("sidebar\.archived_items"\)[\s\S]*tr\("session\.command_palette_search_sessions"\)[\s\S]*tr\("sidebar\.by_project"\)[\s\S]*tr\("sidebar\.recent"\)/,
  );
  assert.doesNotMatch(source, /tr\("sidebar\.show_archived"\)/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-layout.test.ts \
  src/app/components/session/workspace-session-list-controls-tooltips.test.ts \
  src/app/components/session/workspace-session-list-overflow-menu.test.ts
```

Expected: FAIL because the current top rail still renders `By project`, `Recent`, `Search`, and `Show archived` as standalone controls.

**Step 3: Write minimal implementation**

Refactor the control rail in `workspace-session-list.tsx` so it renders exactly three top-level buttons:

```tsx
const [moreMenuOpen, setMoreMenuOpen] = createSignal(false);

<div class="mb-3 flex flex-nowrap items-center gap-1" ref={(el) => (sidebarControlsRef = el)}>
  <button data-tooltip={tr("sidebar.new_session")} ...>...</button>
  <Show when={props.onAddDirectorySession}>
    <button data-tooltip={tr("sidebar.add_directory_or_project")} ...>
      <FolderPlus size={12} />
      <span>{tr("sidebar.add_directory_or_project")}</span>
    </button>
  </Show>
  <div class="relative shrink-0">
    <button data-tooltip={tr("sidebar.more_actions")} ...>
      <MoreHorizontal size={14} />
      <span class="sr-only">{tr("sidebar.more_actions")}</span>
    </button>
    <Show when={moreMenuOpen()}>
      <div class="absolute right-0 top-full mt-2 ...">
        {/* Archived items / Search / By project / Recent */}
      </div>
    </Show>
  </div>
</div>
```

Implementation requirements:

- keep the current `New` button behavior, including the create-worker dropdown fallback
- give the three visible buttons the same height and chrome
- move `Search`, `By project`, and `Recent` into the overflow menu
- keep `Search` hidden when `props.onOpenSessionSearch` is absent
- render `By project` and `Recent` as mutually exclusive menu choices using the existing `setSidebarMode(...)`

**Step 4: Run test to verify it passes**

Run the same command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/components/session/workspace-session-list.tsx \
  packages/app/src/app/components/session/workspace-session-list-layout.test.ts \
  packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts \
  packages/app/src/app/components/session/workspace-session-list-overflow-menu.test.ts
git commit -m "feat(app): move sidebar secondary controls into overflow"
```

### Task 2: Remove Sidebar Archived-Filter State And Persistence

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`

**Step 1: Write the failing test**

Add assertions that the sidebar no longer hydrates or persists archived visibility:

```ts
// workspace-session-list-interactions.test.ts
test("sidebar list no longer uses archived visibility local storage", () => {
  assert.doesNotMatch(source, /readShowArchivedSessions/);
  assert.doesNotMatch(source, /writeShowArchivedSessions/);
  assert.doesNotMatch(source, /showArchivedSessions\(\)/);
  assert.match(source, /!isSessionArchived\(row\.session\.id\)/);
});
```

Then remove the old show-archived round-trip tests from `workspace-session-list-prefs.test.ts` so the file fails on stale imports/exports.

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-prefs.test.ts \
  src/app/components/session/workspace-session-list-interactions.test.ts
```

Expected: FAIL because `readShowArchivedSessions`, `writeShowArchivedSessions`, and the sidebar archive toggle still exist.

**Step 3: Write minimal implementation**

Delete the archived-visibility preference from `workspace-session-list-prefs.ts`:

```ts
export const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
export const SIDEBAR_COLLAPSED_PROJECTS_KEY = "veslo.sidebar-collapsed-projects.v1";
export const SIDEBAR_PROJECT_ORDER_KEY = "veslo.sidebar-project-order.v1";

// remove:
// export const SIDEBAR_SHOW_ARCHIVED_KEY = ...
// export const readShowArchivedSessions = ...
// export const writeShowArchivedSessions = ...
```

Then simplify the sidebar filtering logic in `workspace-session-list.tsx` so archived sessions are always excluded from the list:

```tsx
const rowVisible = (row: FlatSessionRow) => !isSessionArchived(row.session.id);
```

Also remove:

- the `showArchivedSessions` signal
- `toggleShowArchived`
- the top-level archive toggle button
- any now-dead imports or persisted preference tests

**Step 4: Run test to verify it passes**

Run the same command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/components/session/workspace-session-list.tsx \
  packages/app/src/app/components/session/workspace-session-list-prefs.ts \
  packages/app/src/app/components/session/workspace-session-list-prefs.test.ts \
  packages/app/src/app/components/session/workspace-session-list-interactions.test.ts
git commit -m "refactor(app): remove sidebar archived visibility preference"
```

### Task 3: Wire `Archived items` To The Existing Settings Archive Surface

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Create: `packages/app/src/app/pages/sidebar-archived-items-navigation.test.ts`

**Step 1: Write the failing test**

Create a new wiring test that proves both parent views pass an archived-items callback into `WorkspaceSessionList` and route it to the existing settings/general flow:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

test("session wires archived items into settings general", () => {
  assert.match(sessionSource, /onOpenArchivedSessions=\{\(\) => openSettings\("general"\)\}/);
});

test("dashboard wires archived items into settings general", () => {
  assert.match(dashboardSource, /onOpenArchivedSessions=\{\(\) => openSettings\("general"\)\}/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/sidebar-archived-items-navigation.test.ts
```

Expected: FAIL because `WorkspaceSessionList` has no archived-items callback and neither parent passes one.

**Step 3: Write minimal implementation**

Add a dedicated prop to `WorkspaceSessionList`:

```ts
type Props = {
  ...
  onOpenArchivedSessions?: () => void;
};
```

Use that prop in the overflow menu:

```tsx
<button
  type="button"
  class="w-full ..."
  onClick={() => {
    props.onOpenArchivedSessions?.();
    setMoreMenuOpen(false);
  }}
>
  {tr("sidebar.archived_items")}
</button>
```

Pass the callback from both parent views:

```tsx
<WorkspaceSessionList
  ...
  onOpenArchivedSessions={() => openSettings("general")}
/>
```

Important:

- do not add a new settings tab
- do not route through a sidebar archive toggle
- reuse the existing `openSettings("general")` helper already present in `session.tsx` and `dashboard.tsx`

**Step 4: Run test to verify it passes**

Run the same command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/components/session/workspace-session-list.tsx \
  packages/app/src/app/pages/session.tsx \
  packages/app/src/app/pages/dashboard.tsx \
  packages/app/src/app/pages/sidebar-archived-items-navigation.test.ts
git commit -m "feat(app): route archived items to settings archive list"
```

### Task 4: Localize The New CTA And Overflow Copy

**Files:**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`

**Step 1: Write the failing test**

Reference the new translation keys from the component and rely on parity to catch missing locale entries:

```tsx
data-tooltip={tr("sidebar.add_directory_or_project")}
data-tooltip={tr("sidebar.more_actions")}
{tr("sidebar.archived_items")}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
pnpm test:i18n
```

Expected: FAIL because one or more locale files are missing the new sidebar keys, or the removed `sidebar.show_archived` key has not been cleaned up consistently.

**Step 3: Write minimal implementation**

Add the new locale keys to each existing sidebar locale table:

```ts
// en.ts
"sidebar.add_directory_or_project": "Add directory / project",
"sidebar.more_actions": "More actions",
"sidebar.archived_items": "Archived items",
```

```ts
// cs.ts
"sidebar.add_directory_or_project": "Přidat adresář / projekt",
"sidebar.more_actions": "Další akce",
"sidebar.archived_items": "Archivované položky",
```

```ts
// zh.ts
"sidebar.add_directory_or_project": "添加目录 / 项目",
"sidebar.more_actions": "更多操作",
"sidebar.archived_items": "已归档项目",
```

Then remove the obsolete `sidebar.show_archived` entry if nothing references it anymore.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
pnpm test:i18n
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/i18n/locales/en.ts \
  packages/app/src/i18n/locales/cs.ts \
  packages/app/src/i18n/locales/zh.ts \
  packages/app/src/app/components/session/workspace-session-list.tsx
git commit -m "feat(app): localize sidebar overflow actions"
```

### Task 5: Verify The Desktop Flow And Capture Review Evidence

**Files:**
- Create: `packages/e2e/specs/sidebar-primary-actions-overflow.spec.ts`
- Create: `docs/plans/assets/2026-04-12-sidebar-primary-actions-overflow/sidebar-overflow-desktop.png`
- Create: `docs/plans/assets/2026-04-12-sidebar-primary-actions-overflow/archived-items-settings.png`

**Step 1: Write the failing test**

Create a WebdriverIO spec that verifies the real desktop behavior:

```ts
import { expect } from "@wdio/globals";
import { navigateToHash } from "../helpers/app-launcher.js";

describe("Sidebar primary actions overflow", () => {
  it("shows only new, add-directory-or-project, and overflow in the top rail", async () => {
    await navigateToHash("/session");
    await expect(await $('button[data-tooltip="New session"]')).toExist();
    await expect(await $('button[data-tooltip="Add directory / project"]')).toExist();
    await expect(await $('button[data-tooltip="More actions"]')).toExist();
  });

  it("opens archived items from overflow into dashboard settings", async () => {
    // click overflow, click Archived items, assert #/dashboard/settings
  });
});
```

**Step 2: Run test to verify it fails**

Run the required Veslo desktop flow:

```bash
./packaging/docker/dev-up.sh

cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/sidebar-primary-actions-overflow.spec.ts
```

Expected: FAIL until the UI implementation and selectors are complete.

**Step 3: Write minimal implementation**

Finish the WDIO spec and capture screenshots after it passes.

Manual verification requirements:

- use the Chrome MCP workflow from `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`
- verify the top rail visually in the desktop runtime
- verify the overflow menu contains only `Archived items`, `Search`, `By project`, and `Recent`
- verify `Archived items` lands in the existing archived-session settings section
- save screenshots under `docs/plans/assets/2026-04-12-sidebar-primary-actions-overflow/`

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/**/*.test.ts src/app/**/**/*.test.ts
pnpm test:i18n
pnpm typecheck

cd ../desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/sidebar-primary-actions-overflow.spec.ts
```

Expected: PASS for the focused unit/type/i18n checks and the new desktop e2e spec.

**Step 5: Commit**

```bash
git add \
  packages/e2e/specs/sidebar-primary-actions-overflow.spec.ts \
  docs/plans/assets/2026-04-12-sidebar-primary-actions-overflow/sidebar-overflow-desktop.png \
  docs/plans/assets/2026-04-12-sidebar-primary-actions-overflow/archived-items-settings.png
git commit -m "test(e2e): verify sidebar primary actions overflow flow"
```
