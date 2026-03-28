# Left Menu Return To Session Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the dashboard left titlebar menu button return to the last selected session for the active workspace on desktop and narrow layouts, while preserving the existing fallback toggle behavior when no session is selected.

**Architecture:** Add a tiny dashboard-only navigation policy helper in `packages/app/src/app/pages/dashboard-menu-navigation.ts`, cover it with focused unit and source-contract tests, and route `dashboard.tsx` through that helper before falling back to `toggleSidebarMenu("left")`. Reuse the existing `selectedSessionId` prop and the current per-workspace persistence in `app.tsx`; do not introduce a new route-history or persistence layer.

**Tech Stack:** SolidJS, TypeScript, Node test runner (`node --test` with `tsx/esm`), pnpm, Tauri desktop app, Docker dev stack, Chrome MCP

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Use `@superpowers:using-git-worktrees` if you need to recreate the isolated branch from scratch.
- Never run `packages/web`; verify via the Tauri desktop app only.
- For the end-to-end gate, use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`.
- The current isolated worktree for this feature is `/Users/vaclavsoukup/AI agent projects/Veslo/.worktrees/menu-return-last-session` on branch `codex/menu-return-last-session`.

### Task 1: Recreate the isolated baseline and verify it is clean

**Files:**
- Modify: none (environment preparation only)

**Step 1: Sync remotes and enter the worktree**

Run:

```bash
git fetch --all --prune
git worktree add .worktrees/menu-return-last-session -b codex/menu-return-last-session origin/main
cd .worktrees/menu-return-last-session
```

Expected: a clean worktree opens on branch `codex/menu-return-last-session`.

**Step 2: Install dependencies**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: install completes successfully. Warnings about missing generated sidecar bins are acceptable at this stage.

**Step 3: Verify the existing navigation layout baseline**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-sidebar-navigation-layout.test.ts src/app/pages/session-sidebar-navigation-layout.test.ts
```

Expected: PASS before feature changes.

**Step 4: Confirm the worktree is clean before edits**

Run:

```bash
git status --short
```

Expected: no tracked changes in the worktree.

### Task 2: Add failing tests for the unified left-menu return behavior

**Files:**
- Create: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`
- Test: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Write the failing helper and wiring tests**

Create `packages/app/src/app/pages/dashboard-menu-navigation.test.ts` with focused assertions like:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveLeftMenuAction } from "./dashboard-menu-navigation.js";

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

test("returns to selected session for automations on desktop widths", () => {
  const result = resolveLeftMenuAction({
    tab: "scheduled",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
});

test("returns to selected session for extensions too", () => {
  const result = resolveLeftMenuAction({
    tab: "mcp",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
});

test("falls back to sidebar toggle when no session is selected", () => {
  const result = resolveLeftMenuAction({
    tab: "skills",
    selectedSessionId: null,
  });

  assert.deepEqual(result, { kind: "toggle-left-sidebar" });
});

test("dashboard routes the left titlebar button through the helper", () => {
  assert.match(dashboardSource, /const action = resolveLeftMenuAction\\(\\{/);
  assert.match(dashboardSource, /selectedSessionId: props\\.selectedSessionId/);
  assert.match(dashboardSource, /props\\.setView\\(\"session\", action\\.sessionId\\)/);
  assert.doesNotMatch(dashboardSource, /matchMedia\\(\"\\(max-width: 767px\\)\"\\)/);
});
```

This test should deliberately fail at first because:

- `dashboard-menu-navigation.ts` does not exist on `origin/main`
- `dashboard.tsx` still calls `toggleSidebarMenu("left")` directly

**Step 2: Run the targeted test and confirm it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: FAIL with a missing-module error and/or wiring assertion failures.

**Step 3: Commit the failing test checkpoint**

```bash
git add packages/app/src/app/pages/dashboard-menu-navigation.test.ts
git commit -m "test: specify left menu return-to-session behavior"
```

### Task 3: Implement the navigation helper and wire `dashboard.tsx`

**Files:**
- Create: `packages/app/src/app/pages/dashboard-menu-navigation.ts`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Create the new helper module**

Add `packages/app/src/app/pages/dashboard-menu-navigation.ts` with the minimal policy surface:

```ts
import type { DashboardTab } from "../types";

export type LeftMenuAction =
  | { kind: "toggle-left-sidebar" }
  | { kind: "return-to-session"; sessionId: string };

type ResolveLeftMenuActionInput = {
  tab: DashboardTab;
  selectedSessionId: string | null | undefined;
};

const SESSION_RETURN_TABS = new Set<DashboardTab>([
  "scheduled",
  "soul",
  "skills",
  "plugins",
  "mcp",
  "config",
  "settings",
]);

export function resolveLeftMenuAction(input: ResolveLeftMenuActionInput): LeftMenuAction {
  if (!SESSION_RETURN_TABS.has(input.tab)) {
    return { kind: "toggle-left-sidebar" };
  }

  const sessionId = input.selectedSessionId?.trim() ?? "";
  if (!sessionId) {
    return { kind: "toggle-left-sidebar" };
  }

  return { kind: "return-to-session", sessionId };
}
```

Implementation requirements:

- do not add viewport arguments
- keep the return-tab set explicit in this module
- keep the public API small so tests stay stable

**Step 2: Route the dashboard left menu through the helper**

Update `packages/app/src/app/pages/dashboard.tsx` to import the helper and replace the direct sidebar-toggle callback.

Target structure:

```ts
import { resolveLeftMenuAction } from "./dashboard-menu-navigation";

const handleLeftMenuToggle = () => {
  const action = resolveLeftMenuAction({
    tab: props.tab,
    selectedSessionId: props.selectedSessionId,
  });

  if (action.kind === "return-to-session") {
    props.setView("session", action.sessionId);
    return;
  }

  toggleSidebarMenu("left");
};
```

Then wire it into the titlebar button:

```tsx
<TitlebarMenuToggles
  leftActive={leftSidebarVisible()}
  rightActive={rightSidebarVisible()}
  hideTitlebar={props.hideTitlebar}
  onToggleLeft={handleLeftMenuToggle}
  onToggleRight={() => toggleSidebarMenu("right")}
/>
```

Implementation requirements:

- remove any `matchMedia("(max-width: 767px)")` logic from this flow
- keep `toggleSidebarMenu("right")` unchanged
- do not touch `selectedSessionId` persistence in `app.tsx`

**Step 3: Run the focused test and confirm it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: PASS.

**Step 4: Commit the implementation**

```bash
git add packages/app/src/app/pages/dashboard-menu-navigation.ts packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/dashboard-menu-navigation.test.ts
git commit -m "feat: return dashboard menu to the selected session"
```

### Task 4: Run the regression set for dashboard navigation

**Files:**
- Modify: none (verification only)
- Test: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`
- Test: `packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts`
- Test: `packages/app/src/app/pages/session-sidebar-navigation-layout.test.ts`

**Step 1: Run typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 2: Run the focused regression suite**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-menu-navigation.test.ts src/app/pages/dashboard-sidebar-navigation-layout.test.ts src/app/pages/session-sidebar-navigation-layout.test.ts
```

Expected: PASS.

**Step 3: Record the verification checkpoint**

```bash
git status --short
```

Expected: only the intended feature files are present if you have not committed yet; otherwise the worktree is clean.

### Task 5: Verify the user flow in the Tauri app and capture screenshots

**Files:**
- Create: `packages/app/pr/screenshots/left-menu-return-to-session-desktop.png`
- Create: `packages/app/pr/screenshots/left-menu-return-to-session-narrow.png`

**Step 1: Start the Veslo Docker dev stack**

Run from the repo root:

```bash
packaging/docker/dev-up.sh
```

Expected: the local Veslo services come up successfully.

**Step 2: Launch the native Tauri desktop app**

Run from the repo root in a separate terminal:

```bash
pnpm dev
```

Expected: the Tauri app launches. Do not run `packages/web`.

**Step 3: Verify the flow with Chrome MCP**

Using `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`, verify:

- open a session in a workspace
- navigate to `Automations`, `Soul`, `Skills`, and `Extensions`
- click the left titlebar menu button and confirm it returns to the last selected session
- repeat in a narrow-width layout and confirm the same result
- clear selection or use a workspace with no selected session and confirm the button still toggles the left sidebar

**Step 4: Save screenshots into the repo**

Save at least:

- `packages/app/pr/screenshots/left-menu-return-to-session-desktop.png`
- `packages/app/pr/screenshots/left-menu-return-to-session-narrow.png`

**Step 5: Commit the verification artifacts if they belong in the branch**

```bash
git add packages/app/pr/screenshots/left-menu-return-to-session-desktop.png packages/app/pr/screenshots/left-menu-return-to-session-narrow.png
git commit -m "docs: add left menu return-to-session verification captures"
```
