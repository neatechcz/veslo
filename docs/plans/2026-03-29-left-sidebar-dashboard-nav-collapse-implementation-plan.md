# Left Sidebar Dashboard Nav Collapse Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Hide the left-sidebar dashboard nav group (`Automations`, `Soul`, `Skills`, `Extensions`) by default, add a tiny expand/collapse arrow on the divider above the settings/status block, and persist that state globally.

**Architecture:** Keep behavior centralized in `SidebarDashboardNav` so both Dashboard and Session inherit the same UX. Add a dedicated localStorage preference helper with a versioned key, gate nav button rendering behind a local collapsed signal, and keep existing sidebar composition order (`WorkspaceSessionList` -> `SidebarDashboardNav` -> `SidebarStatusControls`) unchanged.

**Tech Stack:** SolidJS, TypeScript, lucide-solid, Node test runner (`node --test` via `tsx/esm`), pnpm, Tauri desktop app, Docker dev stack, Chrome MCP

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Use an isolated worktree because the current repo state already has unrelated dirty changes.
- Never run `packages/web`; verify only through the Tauri desktop app.
- Use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` for end-to-end UI verification.

### Task 1: Prepare a clean isolated worktree

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync remotes and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: commands finish without errors and all tracked submodules are initialized.

**Step 2: Create and enter a dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/left-sidebar-dashboard-nav-collapse -b codex/left-sidebar-dashboard-nav-collapse origin/main
cd .worktrees/codex/left-sidebar-dashboard-nav-collapse
```

Expected: a clean worktree opens on branch `codex/left-sidebar-dashboard-nav-collapse`.

**Step 3: Install dependencies**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: install completes successfully.

**Step 4: Run baseline sidebar layout tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-sidebar-navigation-layout.test.ts src/app/pages/session-sidebar-navigation-layout.test.ts
```

Expected: PASS on untouched baseline.

**Step 5: Confirm clean baseline**

Run:

```bash
git status --short
```

Expected: no tracked changes in the new worktree.

### Task 2: Add failing tests for the new global collapsed preference helper

**Files:**
- Create: `packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.test.ts`
- Test: `packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.test.ts`

**Step 1: Write the failing preference helper tests**

Create `packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED,
  SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY,
  readSidebarDashboardNavCollapsed,
  writeSidebarDashboardNavCollapsed,
} from "./sidebar-dashboard-nav-prefs.js";

type MemoryStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  snapshot: () => Record<string, string>;
};

const createMemoryStorage = (initial?: Record<string, string>): MemoryStorage => {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    snapshot() {
      return Object.fromEntries(map.entries());
    },
  };
};

test("defaults to collapsed when storage is empty", () => {
  const storage = createMemoryStorage();
  assert.equal(readSidebarDashboardNavCollapsed(storage), DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED);
});

test("reads persisted false correctly", () => {
  const storage = createMemoryStorage({
    [SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY]: "false",
  });
  assert.equal(readSidebarDashboardNavCollapsed(storage), false);
});

test("falls back to default when payload is invalid", () => {
  const storage = createMemoryStorage({
    [SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY]: "invalid",
  });
  assert.equal(readSidebarDashboardNavCollapsed(storage), DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED);
});

test("writes normalized boolean strings", () => {
  const storage = createMemoryStorage();
  writeSidebarDashboardNavCollapsed(false, storage);
  assert.equal(storage.snapshot()[SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY], "false");
});
```

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-dashboard-nav-prefs.test.ts
```

Expected: FAIL because `sidebar-dashboard-nav-prefs.ts` does not exist yet.

**Step 3: Commit failing test**

```bash
git add packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.test.ts
git commit -m "test: specify dashboard nav collapsed prefs"
```

### Task 3: Implement the preference helper and make tests pass

**Files:**
- Create: `packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.ts`
- Test: `packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.test.ts`

**Step 1: Implement read/write helpers**

Create `packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.ts`:

```ts
export type SidebarDashboardNavPrefsStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export const SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY = "veslo.sidebar-dashboard-nav.collapsed.v1";
export const DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED = true;

const resolveStorage = (
  storage?: SidebarDashboardNavPrefsStorage | null,
): SidebarDashboardNavPrefsStorage | null => {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
};

export const readSidebarDashboardNavCollapsed = (
  storage?: SidebarDashboardNavPrefsStorage | null,
): boolean => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED;
  try {
    const raw = resolvedStorage.getItem(SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED;
  } catch {
    return DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED;
  }
};

export const writeSidebarDashboardNavCollapsed = (
  value: boolean,
  storage?: SidebarDashboardNavPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;
  try {
    resolvedStorage.setItem(SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY, value ? "true" : "false");
  } catch {
    // ignore storage failures
  }
};
```

**Step 2: Run helper test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-dashboard-nav-prefs.test.ts
```

Expected: PASS.

**Step 3: Commit helper implementation**

```bash
git add packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.ts packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.test.ts
git commit -m "feat: add persisted dashboard nav collapse prefs"
```

### Task 4: Add a failing source-contract test for collapsed nav rendering and arrow toggle

**Files:**
- Create: `packages/app/src/app/components/session/sidebar-dashboard-nav-layout.test.ts`
- Test: `packages/app/src/app/components/session/sidebar-dashboard-nav-layout.test.ts`

**Step 1: Write failing source-contract assertions**

Create `packages/app/src/app/components/session/sidebar-dashboard-nav-layout.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sidebar-dashboard-nav.tsx", import.meta.url), "utf8");

test("sidebar dashboard nav reads and writes collapsed preference", () => {
  assert.match(source, /readSidebarDashboardNavCollapsed/);
  assert.match(source, /writeSidebarDashboardNavCollapsed/);
  assert.match(source, /createSignal<\s*boolean\s*>\(\s*readSidebarDashboardNavCollapsed\(\)\s*\)/);
});

test("sidebar dashboard nav conditionally renders nav items when expanded", () => {
  assert.match(source, /<Show when=\{!collapsed\(\)\}>/);
  assert.match(source, /t\("nav\.automations"/);
  assert.match(source, /t\("nav\.soul"/);
  assert.match(source, /t\("nav\.skills"/);
  assert.match(source, /t\("nav\.extensions"/);
});

test("sidebar dashboard nav renders tiny arrow toggle above status block divider", () => {
  assert.match(source, /aria-label=\{collapsed\(\)\s*\?\s*"Expand dashboard menu"\s*:\s*"Collapse dashboard menu"\}/);
  assert.match(source, /<ChevronDown size=\{12\}/);
  assert.match(source, /transition-transform/);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-dashboard-nav-layout.test.ts
```

Expected: FAIL because `sidebar-dashboard-nav.tsx` does not yet contain the collapsed-state and arrow-toggle logic.

**Step 3: Commit failing source-contract test**

```bash
git add packages/app/src/app/components/session/sidebar-dashboard-nav-layout.test.ts
git commit -m "test: specify collapsible dashboard nav layout"
```

### Task 5: Implement collapsible nav UI in `SidebarDashboardNav`

**Files:**
- Modify: `packages/app/src/app/components/session/sidebar-dashboard-nav.tsx`
- Test: `packages/app/src/app/components/session/sidebar-dashboard-nav-layout.test.ts`
- Test: `packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.test.ts`

**Step 1: Add collapsed signal and toggle persistence wiring**

Update imports and state initialization in `sidebar-dashboard-nav.tsx`:

```ts
import { Show, createSignal } from "solid-js";
import { Box, ChevronDown, HeartPulse, History, Zap } from "lucide-solid";

import {
  readSidebarDashboardNavCollapsed,
  writeSidebarDashboardNavCollapsed,
} from "./sidebar-dashboard-nav-prefs";

const [collapsed, setCollapsed] = createSignal<boolean>(readSidebarDashboardNavCollapsed());

const toggleCollapsed = () => {
  const next = !collapsed();
  setCollapsed(next);
  writeSidebarDashboardNavCollapsed(next);
};
```

**Step 2: Gate nav buttons behind expanded-only rendering**

Wrap the existing 4 nav buttons:

```tsx
<Show when={!collapsed()}>
  <div class="mt-1.5 space-y-0 border-t border-gray-6/70 pt-1.5">
    {/* existing Automations/Soul/Skills/Extensions buttons unchanged */}
  </div>
</Show>
```

Implementation requirement: keep existing button order, icons, and `isActiveTab(...)` behavior unchanged.

**Step 3: Add compact divider arrow control**

Add divider row with tiny center arrow button:

```tsx
<div class={`${collapsed() ? "mt-1.5" : "mt-1"} relative border-t border-gray-6/70 pt-0`}>
  <button
    type="button"
    class="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 h-4 w-4 inline-flex items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-9 transition-colors hover:bg-gray-2 hover:text-gray-11"
    onClick={toggleCollapsed}
    title={collapsed() ? "Expand dashboard menu" : "Collapse dashboard menu"}
    aria-label={collapsed() ? "Expand dashboard menu" : "Collapse dashboard menu"}
  >
    <ChevronDown
      size={12}
      class={`transition-transform ${collapsed() ? "rotate-180" : ""}`.trim()}
    />
  </button>
</div>
```

Implementation requirement: keep this control at the bottom of `SidebarDashboardNav` so it stays directly above `SidebarStatusControls`.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-dashboard-nav-prefs.test.ts src/app/components/session/sidebar-dashboard-nav-layout.test.ts
```

Expected: PASS.

**Step 5: Commit feature implementation**

```bash
git add packages/app/src/app/components/session/sidebar-dashboard-nav.tsx packages/app/src/app/components/session/sidebar-dashboard-nav-layout.test.ts packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.ts packages/app/src/app/components/session/sidebar-dashboard-nav-prefs.test.ts
git commit -m "feat: add collapsible left sidebar dashboard nav"
```

### Task 6: Run regression checks for shared Dashboard/Session sidebar composition

**Files:**
- Modify: none (verification only)
- Test: `packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts`
- Test: `packages/app/src/app/pages/session-sidebar-navigation-layout.test.ts`
- Test: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Run typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 2: Run targeted regression tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-dashboard-nav-prefs.test.ts src/app/components/session/sidebar-dashboard-nav-layout.test.ts src/app/pages/dashboard-sidebar-navigation-layout.test.ts src/app/pages/session-sidebar-navigation-layout.test.ts src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: PASS.

**Step 3: Capture verification checkpoint**

Run:

```bash
git status --short
```

Expected: only intended feature files are modified if not yet committed; otherwise clean.

### Task 7: Execute end-to-end Tauri verification and capture screenshots

**Files:**
- Create: `packages/app/pr/screenshots/sidebar-dashboard-nav-collapsed-default.png`
- Create: `packages/app/pr/screenshots/sidebar-dashboard-nav-expanded.png`

**Step 1: Start Veslo Docker dev stack (repo root)**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: local Veslo services are up.

**Step 2: Launch Tauri desktop app**

Run in a separate terminal:

```bash
pnpm dev
```

Expected: native app opens; do not run `next dev`.

**Step 3: Verify the flow with Chrome MCP**

Using `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`, verify:

- left sidebar nav group starts collapsed by default
- tiny arrow is visible on divider directly above gear/status block
- clicking arrow expands and collapses the four-item nav group
- tab behavior for `Automations`, `Soul`, `Skills`, and `Extensions` remains correct when expanded
- collapse state persists after reload and stays collapsed even when active tab belongs to this group

**Step 4: Save screenshots into repo**

Save:

- `packages/app/pr/screenshots/sidebar-dashboard-nav-collapsed-default.png`
- `packages/app/pr/screenshots/sidebar-dashboard-nav-expanded.png`

**Step 5: Commit screenshots if retained in PR**

```bash
git add packages/app/pr/screenshots/sidebar-dashboard-nav-collapsed-default.png packages/app/pr/screenshots/sidebar-dashboard-nav-expanded.png
git commit -m "docs: add collapsible dashboard nav screenshots"
```

### Task 8: Final handoff and reviewer instructions

**Files:**
- Modify: none

**Step 1: Summarize evidence**

Record exact commands and outcomes for:

- targeted node tests
- `pnpm --filter @neatech/veslo-ui typecheck`
- `packaging/docker/dev-up.sh`
- `pnpm dev`
- Chrome MCP verification

**Step 2: If any end-to-end step is blocked, report explicitly**

Document:

- which AGENTS.md steps (4-8) were blocked
- why they were blocked
- what was verified instead
- exact commands reviewers should run to complete the gate

**Step 3: Final branch check**

Run:

```bash
git status --short
git log --oneline --decorate -5
```

Expected: branch contains only intended commits for this feature.
