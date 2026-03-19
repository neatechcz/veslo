# Global Native Titlebar Sidebars + Session Width Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move left/right menu toggles into native titlebar areas (macOS + Windows), make sidebars globally available using current Session sidebar content, and set Session chat column max width to `325px` with left sidebar visible by default.

**Architecture:** Introduce a global layout shell in `app.tsx` that owns sidebar state, titlebar controls, and docked/overlay rendering. Keep behavior deterministic via a pure global sidebar layout model and a persistence helper that initializes left-visible defaults and migrates existing session-scoped preferences. Implement platform-aware native titlebar behavior through Tauri window APIs and a Windows-specific native titlebar integration path, with safe fallback to in-app controls.

**Tech Stack:** SolidJS, TypeScript, Tauri 2, Rust (desktop host), Tailwind CSS, Node test runner (`node --test`), pnpm, Docker, Chrome MCP

---

## Prerequisites

- Use `@superpowers:using-git-worktrees` before editing.
- Use `@superpowers:test-driven-development` for every behavior change.
- Respect `@solidjs-patterns` from `.opencode/skills/solidjs-patterns/SKILL.md`.
- Final execution must include Docker + Chrome MCP gate from `AGENTS.md`.

### Task 1: Prepare isolated worktree and baseline

**Files:**
- Modify: none (environment prep)

**Step 1: Sync submodules/remotes**

Run:

```bash
git submodule update --init --recursive
git fetch --all --prune
```

Expected: no errors.

**Step 2: Create and enter dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/global-titlebar-sidebars -b codex/global-titlebar-sidebars
cd .worktrees/codex/global-titlebar-sidebars
```

Expected: new worktree is created and checked out on `codex/global-titlebar-sidebars`.

**Step 3: Install deps if needed**

Run:

```bash
pnpm install
```

Expected: lockfile-compatible install completes.

**Step 4: Capture baseline checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-layout-model.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS before feature edits.

### Task 2: Add failing tests for global sidebar layout model

**Files:**
- Create: `packages/app/src/app/components/layout/global-sidebar-layout-model.test.ts`
- Test: `packages/app/src/app/components/layout/global-sidebar-layout-model.test.ts`

**Step 1: Write failing default-state test**

```ts
test("initial global sidebar state defaults left visible", () => {
  const state = createInitialGlobalSidebarState({ left: true, right: true });
  assert.equal(state.docked.left, true);
  assert.equal(state.docked.right, true);
  assert.equal(state.mode, "wide");
});
```

**Step 2: Write failing hysteresis test**

```ts
test("global model enters narrow below threshold and exits only at exit threshold", () => {
  let state = createInitialGlobalSidebarState({ left: true, right: true });
  state = applyGlobalAvailableWidth(state, GLOBAL_CHAT_MIN_WIDTH - 1);
  assert.equal(state.mode, "narrow");
  state = applyGlobalAvailableWidth(state, GLOBAL_CHAT_MIN_WIDTH_EXIT - 1);
  assert.equal(state.mode, "narrow");
  state = applyGlobalAvailableWidth(state, GLOBAL_CHAT_MIN_WIDTH_EXIT);
  assert.equal(state.mode, "wide");
});
```

**Step 3: Write failing narrow toggle rule test**

```ts
test("narrow mode keeps one overlay and blocks opposite toggle while open", () => {
  let state = createInitialGlobalSidebarState({ left: true, right: true });
  state = applyGlobalAvailableWidth(state, GLOBAL_CHAT_MIN_WIDTH - 1);
  state = toggleGlobalSidebarFromButton(state, "left");
  const unchanged = toggleGlobalSidebarFromButton(state, "right");
  assert.deepEqual(unchanged, state);
});
```

**Step 4: Run tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/layout/global-sidebar-layout-model.test.ts
```

Expected: FAIL with missing module/symbol errors.

**Step 5: Commit failing tests**

```bash
git add packages/app/src/app/components/layout/global-sidebar-layout-model.test.ts
git commit -m "test: add global sidebar layout model specs"
```

### Task 3: Implement global sidebar layout model

**Files:**
- Create: `packages/app/src/app/components/layout/global-sidebar-layout-model.ts`
- Modify: `packages/app/src/app/components/layout/global-sidebar-layout-model.test.ts` (only if assertion correction needed)
- Test: `packages/app/src/app/components/layout/global-sidebar-layout-model.test.ts`

**Step 1: Add constants/types**

```ts
export const GLOBAL_CHAT_MIN_WIDTH = 760;
export const GLOBAL_CHAT_MIN_WIDTH_EXIT = 784;
export type GlobalSidebarSide = "left" | "right";
export type GlobalLayoutMode = "wide" | "narrow";
```

**Step 2: Implement initial state + hysteresis reducer**

```ts
export const createInitialGlobalSidebarState = (dockedPreference: { left: boolean; right: boolean }) => ({
  mode: "wide" as const,
  docked: { ...dockedPreference },
  dockedPreference: { ...dockedPreference },
  overlay: null as GlobalSidebarSide | null,
});
```

**Step 3: Implement toggle reducer rules**

```ts
export const toggleGlobalSidebarFromButton = (state: GlobalSidebarState, side: GlobalSidebarSide): GlobalSidebarState => {
  // wide: toggle docked side and keep preference
  // narrow: allow same-side close/open, opposite-side no-op while overlay is open
};
```

**Step 4: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/layout/global-sidebar-layout-model.test.ts
```

Expected: PASS.

**Step 5: Commit model**

```bash
git add packages/app/src/app/components/layout/global-sidebar-layout-model.ts packages/app/src/app/components/layout/global-sidebar-layout-model.test.ts
git commit -m "feat: add global sidebar layout model"
```

### Task 4: Add persistence helper with migration + default-left-visible behavior

**Files:**
- Create: `packages/app/src/app/components/layout/global-sidebar-prefs.ts`
- Create: `packages/app/src/app/components/layout/global-sidebar-prefs.test.ts`
- Test: `packages/app/src/app/components/layout/global-sidebar-prefs.test.ts`

**Step 1: Write failing tests for defaults/migration**

```ts
test("returns left-visible defaults when storage is empty", () => {
  const result = readGlobalSidebarDockedPrefs(fakeStorage());
  assert.deepEqual(result, { left: true, right: true });
});

test("migrates legacy session key once", () => {
  const storage = fakeStorage({
    "veslo.session.sidebar.docked.v1": JSON.stringify({ left: false, right: true }),
  });
  const result = readGlobalSidebarDockedPrefs(storage);
  assert.deepEqual(result, { left: false, right: true });
});
```

**Step 2: Implement helper**

```ts
export const GLOBAL_SIDEBAR_DOCKED_PREF_KEY = "veslo.global.sidebar.docked.v1";
export const LEGACY_SESSION_SIDEBAR_DOCKED_PREF_KEY = "veslo.session.sidebar.docked.v1";
```

**Step 3: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/layout/global-sidebar-prefs.test.ts
```

Expected: PASS.

**Step 4: Commit persistence layer**

```bash
git add packages/app/src/app/components/layout/global-sidebar-prefs.ts packages/app/src/app/components/layout/global-sidebar-prefs.test.ts
git commit -m "feat: add global sidebar preference migration and defaults"
```

### Task 5: Add titlebar integration abstraction (macOS overlay + Windows native path)

**Files:**
- Create: `packages/app/src/app/components/layout/titlebar-integration.ts`
- Create: `packages/app/src/app/components/layout/titlebar-integration.test.ts`
- Modify: `packages/app/src/app/lib/tauri.ts`
- Modify: `packages/desktop/src-tauri/src/commands/window.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Test: `packages/app/src/app/components/layout/titlebar-integration.test.ts`

**Step 1: Write failing platform strategy tests**

```ts
test("macOS strategy requests overlay titlebar", () => {
  const config = resolveTitlebarIntegrationStrategy("macos");
  assert.equal(config.mode, "native-overlay");
});

test("windows strategy requests native caption integration", () => {
  const config = resolveTitlebarIntegrationStrategy("windows");
  assert.equal(config.mode, "native-caption");
});
```

**Step 2: Implement pure strategy resolver**

```ts
export const resolveTitlebarIntegrationStrategy = (platform: "macos" | "windows" | "linux" | "web") => {
  if (platform === "macos") return { mode: "native-overlay" as const };
  if (platform === "windows") return { mode: "native-caption" as const };
  return { mode: "in-app-fallback" as const };
};
```

**Step 3: Add Tauri commands/API wrappers needed by strategy**

```ts
// tauri.ts
export async function setWindowTitleBarStyle(style: "visible" | "transparent" | "overlay"): Promise<void> {
  // invoke Rust command wrapper around Tauri window API
}
```

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/layout/titlebar-integration.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit titlebar abstraction**

```bash
git add packages/app/src/app/components/layout/titlebar-integration.ts packages/app/src/app/components/layout/titlebar-integration.test.ts packages/app/src/app/lib/tauri.ts packages/desktop/src-tauri/src/commands/window.rs packages/desktop/src-tauri/src/lib.rs
git commit -m "feat: add platform titlebar integration abstraction"
```

### Task 6: Extract global sidebar content components from existing Session content

**Files:**
- Create: `packages/app/src/app/components/layout/global-left-sidebar-content.tsx`
- Create: `packages/app/src/app/components/layout/global-right-sidebar-content.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/src/app/components/session/composer-controls-layout.test.ts` (if expectations shift)

**Step 1: Move left sidebar content composition into reusable component**

```tsx
export default function GlobalLeftSidebarContent(props: GlobalLeftSidebarContentProps) {
  return (
    <>
      <WorkspaceSessionList {...props.workspaceSessionListProps} />
      <SidebarStatusControls {...props.statusProps} />
    </>
  );
}
```

**Step 2: Move right sidebar content composition into reusable component**

```tsx
export default function GlobalRightSidebarContent(props: GlobalRightSidebarContentProps) {
  return <ArtifactsPanel {...props.artifactsProps} />;
}
```

**Step 3: Update Session and Dashboard to consume extracted components**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 4: Commit extraction**

```bash
git add packages/app/src/app/components/layout/global-left-sidebar-content.tsx packages/app/src/app/components/layout/global-right-sidebar-content.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx
git commit -m "refactor: extract reusable global sidebar content components"
```

### Task 7: Implement GlobalChrome and GlobalSidebarsHost components

**Files:**
- Create: `packages/app/src/app/components/layout/global-chrome.tsx`
- Create: `packages/app/src/app/components/layout/global-sidebars-host.tsx`
- Create: `packages/app/src/app/components/layout/global-chrome-layout.test.ts`
- Modify: `packages/app/src/app/components/session/sidebar-toggle-icons.tsx` (reuse icons)
- Test: `packages/app/src/app/components/layout/global-chrome-layout.test.ts`

**Step 1: Write failing layout test for titlebar controls**

```ts
test("global chrome renders left and right menu toggles with accessible labels", () => {
  const source = readFileSync("src/app/components/layout/global-chrome.tsx", "utf8");
  assert.match(source, /aria-label=\"Toggle left menu\"/);
  assert.match(source, /aria-label=\"Toggle right menu\"/);
});
```

**Step 2: Implement `GlobalChrome` with toggle controls and drag-safe regions**

```tsx
<div class="pointer-events-auto flex items-center gap-2">
  <button aria-label="Toggle left menu" onClick={() => props.onToggle("left")} />
  <button aria-label="Toggle right menu" onClick={() => props.onToggle("right")} />
</div>
```

**Step 3: Implement `GlobalSidebarsHost` for docked/overlay rendering**

```tsx
<Show when={props.leftDockedVisible}><aside class="w-[260px]">...</aside></Show>
<Show when={props.rightDockedVisible}><aside class="w-[280px]">...</aside></Show>
```

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/layout/global-chrome-layout.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit global shell components**

```bash
git add packages/app/src/app/components/layout/global-chrome.tsx packages/app/src/app/components/layout/global-sidebars-host.tsx packages/app/src/app/components/layout/global-chrome-layout.test.ts packages/app/src/app/components/session/sidebar-toggle-icons.tsx
git commit -m "feat: add global chrome and sidebar host components"
```

### Task 8: Integrate global shell in `app.tsx`

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/src/app/components/layout/global-sidebar-layout-model.test.ts`

**Step 1: Wire global state in `app.tsx`**

```ts
const [globalSidebarState, setGlobalSidebarState] = createSignal(
  createInitialGlobalSidebarState(readGlobalSidebarDockedPrefs(window.localStorage)),
);
```

**Step 2: Wrap Session/Dashboard views in global shell**

```tsx
<GlobalChrome ... />
<GlobalSidebarsHost ...>
  <Switch>{/* session/dashboard content */}</Switch>
</GlobalSidebarsHost>
```

**Step 3: Remove duplicate page-local sidebar wrappers**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 4: Commit integration**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx
git commit -m "feat: move sidebar controls and state to global app shell"
```

### Task 9: Apply Session chat column width = `325px`

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/components/session/message-list.tsx` (if wrapper constraints need alignment)
- Create: `packages/app/src/app/pages/session-layout-width.test.ts`
- Test: `packages/app/src/app/pages/session-layout-width.test.ts`

**Step 1: Add failing width assertion test**

```ts
test("session center column uses 325px max width", () => {
  const source = readFileSync("src/app/pages/session.tsx", "utf8");
  assert.match(source, /max-w-\\[325px\\]/);
});
```

**Step 2: Update width wrappers from `650px` to `325px`**

```tsx
<div class="max-w-[325px] mx-auto w-full">
```

**Step 3: Align related wrappers (`68ch` rails if needed) to avoid mismatch**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-layout-width.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 4: Commit width change**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/components/session/message-list.tsx packages/app/src/app/pages/session-layout-width.test.ts
git commit -m "feat: reduce session chat column width to 325px"
```

### Task 10: Desktop-host verification (required by AGENTS new-feature workflow)

**Files:**
- Create: `evidence/2026-03-19-global-titlebar-sidebars/` (screenshots)
- Modify: docs only if needed for verification notes

**Step 1: Start dev stack via Docker (repo root)**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: stack starts and app/dev endpoints become reachable.

**Step 2: Run Chrome MCP flow**

Follow: `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`

Required checks:
- Titlebar controls visible and functional on both sides.
- Sidebars toggle globally on non-session views.
- Left sidebar visible on first run.
- Session chat column visually constrained to `325px`.

**Step 3: Capture and save screenshots**

Place artifacts under:

```text
evidence/2026-03-19-global-titlebar-sidebars/
```

Minimum captures:
- macOS titlebar area with controls.
- Windows titlebar area with controls.
- Non-session view showing global sidebars.
- Session view showing `325px` center column.

**Step 4: Commit evidence (if tracked)**

```bash
git add evidence/2026-03-19-global-titlebar-sidebars
git commit -m "test: capture global titlebar sidebar verification screenshots"
```

### Task 11: Final verification and integration summary

**Files:**
- Modify: optional docs if verification caveats are needed

**Step 1: Run focused automated checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/layout/global-sidebar-layout-model.test.ts src/app/components/layout/global-sidebar-prefs.test.ts src/app/components/layout/titlebar-integration.test.ts src/app/components/layout/global-chrome-layout.test.ts src/app/pages/session-layout-width.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 2: Rebuild desktop binary if server-side desktop code changed**

Run:

```bash
pnpm --filter openwork-server build:bin
```

Expected: build succeeds when `packages/server/src` was modified.

**Step 3: Record final status**

Run:

```bash
git status --short
git log --oneline -n 12
```

Expected: only intended files changed/committed; commit history reflects small TDD increments.

