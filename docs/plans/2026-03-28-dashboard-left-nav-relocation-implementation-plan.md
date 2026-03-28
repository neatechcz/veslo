# Dashboard Left Nav Relocation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move `Automations`, `Soul`, `Skills`, and `Extensions` from the right desktop dashboard sidebar into the left sidebar above the `Settings` / login-status block while keeping the existing sidebar visibility logic unchanged.

**Architecture:** Keep the dashboard tab model exactly as-is and treat this as a layout redistribution inside `packages/app/src/app/pages/dashboard.tsx`. Add a dedicated left-sidebar nav block between `WorkspaceSessionList` and `SidebarStatusControls`, reuse the existing `navItem(...)` helper and icon wiring, and shrink the right sidebar content down to `Advanced` in developer mode only. Use source-contract tests that read `dashboard.tsx` so the placement and item distribution stay explicit without introducing unnecessary runtime abstractions.

**Tech Stack:** SolidJS, TypeScript, lucide-solid, Tailwind utility classes, Node test runner (`node --test` via `tsx/esm`), pnpm, Tauri desktop app

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Do the implementation in a dedicated worktree. The current workspace already has unrelated dirty changes.
- Follow the Veslo rule to verify in the Tauri desktop app, not `packages/web`.
- For the end-to-end gate, use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`.

### Task 1: Create a clean worktree and capture the baseline

**Files:**
- Modify: none (environment preparation only)

**Step 1: Sync the repo and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: both commands finish without errors.

**Step 2: Create and enter a dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/dashboard-left-nav-relocation -b codex/dashboard-left-nav-relocation origin/main
cd .worktrees/codex/dashboard-left-nav-relocation
```

Expected: a clean worktree opens on branch `codex/dashboard-left-nav-relocation`.

**Step 3: Verify the baseline before edits**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/sidebar-status-controls.model.test.ts src/app/components/titlebar-menu-layout.test.ts
```

Expected: PASS before feature changes.

**Step 4: Commit the worktree setup checkpoint**

```bash
git status --short
```

Expected: no tracked changes in the new worktree.

### Task 2: Add a failing dashboard sidebar source-contract test

**Files:**
- Create: `packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts`
- Test: `packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts`

**Step 1: Write a failing source-contract test for nav placement**

Create `dashboard-sidebar-navigation-layout.test.ts` with assertions that read `dashboard.tsx` and verify all of the following:

- the left sidebar contains a nav block between `WorkspaceSessionList` and `SidebarStatusControls`
- that left nav block renders:
  - `navItem("scheduled", ...)`
  - `navItem("soul", ...)`
  - `navItem("skills", ...)`
  - `navItem("mcp", ...)`
- the right sidebar no longer renders those four items
- the right sidebar still renders `navItem("config", ...)`
- the mobile bottom nav still contains the four product buttons

Use a structure like:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

test("dashboard places product nav in the left sidebar above settings", () => {
  assert.match(
    source,
    /<WorkspaceSessionList[\s\S]*<\/div>\s*<div class="mt-3 space-y-1 border-t border-gray-6\/70 pt-3">[\s\S]*navItem\("scheduled"/,
  );
  assert.match(source, /navItem\("soul"/);
  assert.match(source, /navItem\("skills"/);
  assert.match(source, /navItem\("mcp"/);
  assert.match(source, /<\/div>\s*<SidebarStatusControls/);
});

test("dashboard keeps the right sidebar reserved for developer-mode advanced nav", () => {
  assert.match(source, /<Show when=\{rightSidebarVisible\(\)\}>[\s\S]*navItem\("config"/);
  assert.doesNotMatch(source, /<Show when=\{rightSidebarVisible\(\)\}>[\s\S]*navItem\("scheduled"/);
});
```

**Step 2: Run the targeted test and confirm it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-sidebar-navigation-layout.test.ts
```

Expected: FAIL because `dashboard.tsx` still renders the four product nav items in the right sidebar and has no left-sidebar nav block.

**Step 3: Commit the failing test**

```bash
git add packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts
git commit -m "test: specify dashboard sidebar nav relocation"
```

### Task 3: Relocate the desktop dashboard nav in `dashboard.tsx`

**Files:**
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts`

**Step 1: Insert the new left-sidebar nav block**

In the left sidebar section of `dashboard.tsx`, add a dedicated nav block between the `WorkspaceSessionList` wrapper and `SidebarStatusControls`.

Target structure:

```tsx
<div class="min-h-0 flex-1">
  <WorkspaceSessionList ... />
</div>
<div class="mt-3 space-y-1 border-t border-gray-6/70 pt-3">
  {navItem("scheduled", t("nav.automations", currentLocale()), <History size={18} />)}
  {navItem("soul", t("nav.soul", currentLocale()), <HeartPulse size={18} class={soulNavIconClass()} />)}
  {navItem("skills", t("nav.skills", currentLocale()), <Zap size={18} />)}
  {navItem("mcp", t("nav.extensions", currentLocale()), <Box size={18} />)}
</div>
<SidebarStatusControls ... />
```

Implementation requirements:

- keep the current item order
- keep the current `navItem(...)` helper untouched unless a tiny style tweak is required
- keep `Extensions` wired to `mcp`, relying on the existing `navItem` active-state special case for `plugins`

**Step 2: Remove the four product nav items from the right sidebar**

Reduce the right sidebar content to developer-mode `Advanced` only.

Target structure:

```tsx
<Show when={rightSidebarVisible()}>
  <aside class="w-56 hidden md:flex flex-col bg-dls-sidebar border-l border-dls-border p-4">
    <Show when={props.developerMode}>
      <div class="space-y-1 pt-2">
        {navItem("config", t("nav.advanced", currentLocale()), <SlidersHorizontal size={18} />)}
      </div>
    </Show>
  </aside>
</Show>
```

Implementation requirements:

- do not change `rightSidebarVisible()`
- do not change `toggleSidebarMenu("right")`
- do not change localStorage persistence for docked sidebar visibility

**Step 3: Run the targeted dashboard test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-sidebar-navigation-layout.test.ts
```

Expected: PASS.

**Step 4: Run typecheck and a small regression set**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-sidebar-navigation-layout.test.ts src/app/components/sidebar-status-controls.model.test.ts src/app/components/titlebar-menu-layout.test.ts
```

Expected: PASS.

**Step 5: Commit the layout change**

```bash
git add packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts
git commit -m "feat: move dashboard nav into left sidebar"
```

### Task 4: Verify the desktop flow end-to-end and capture screenshots

**Files:**
- Create: `packages/app/pr/screenshots/dashboard-left-nav-relocation-default.png`
- Create: `packages/app/pr/screenshots/dashboard-left-nav-relocation-developer.png`

**Step 1: Start the Veslo Docker dev stack**

Run from the repo root:

```bash
packaging/docker/dev-up.sh
```

Expected: the script prints the assigned dev endpoints and keeps the required services running.

**Step 2: Launch the Tauri desktop app**

Run in a separate terminal from the repo root:

```bash
pnpm dev
```

Expected: the native Veslo desktop app launches in dev mode.

**Step 3: Run the UI verification with Chrome MCP**

Use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` and verify:

- the left sidebar shows `Automations`, `Soul`, `Skills`, and `Extensions` above `Settings`
- clicking each item swaps the main content correctly
- `Settings` still works separately
- toggling the right sidebar still works
- in non-developer mode the right sidebar may be empty
- in developer mode the right sidebar shows `Advanced`
- mobile bottom nav is unchanged if a mobile-width check is part of the flow

**Step 4: Save screenshots into the repo**

Save at least:

- `packages/app/pr/screenshots/dashboard-left-nav-relocation-default.png`
- `packages/app/pr/screenshots/dashboard-left-nav-relocation-developer.png`

**Step 5: Commit the verification artifacts if they are intended to stay in the branch**

```bash
git add packages/app/pr/screenshots/dashboard-left-nav-relocation-default.png packages/app/pr/screenshots/dashboard-left-nav-relocation-developer.png
git commit -m "docs: add dashboard nav relocation screenshots"
```

### Task 5: Final verification and handoff

**Files:**
- Modify: none

**Step 1: Summarize what was run**

Record the exact commands and outcomes for:

- `pnpm --filter @neatech/veslo-ui typecheck`
- targeted Node tests
- `packaging/docker/dev-up.sh`
- `pnpm dev`
- Chrome MCP flow verification

**Step 2: If any end-to-end step is blocked, report it explicitly**

Include:

- which of steps 4-8 from `AGENTS.md` could not run
- why they could not run
- what was verified instead
- the exact commands the reviewer should run to complete the gate

**Step 3: Prepare the branch for review**

Run:

```bash
git status --short
git log --oneline --decorate -5
```

Expected: only the intended commits for the feature appear in the worktree.
