# Titlebar Brand + Session Context + Composer Relayout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Put `Veslo by Neatech` into the shared native titlebar next to the left toggle, move the current session directory leaf into the same titlebar, remove both the workspace label and disclaimer from the composer, and widen the session composer while relocating the disclaimer below the input on the lower-right edge of the center panel.

**Architecture:** Keep the shared titlebar as the only top chrome layer and extend it with explicit left-brand and optional center-content slots. Let `SessionView` derive and pass the directory leaf via the existing workspace-label helper, while `DashboardView` and other pages reuse the same titlebar without center context. Simplify `composer.tsx` back to input/actions only, move disclaimer layout ownership into `session.tsx`, and enforce the new structure through source-contract tests for titlebar, session, and composer layout.

**Tech Stack:** SolidJS, TypeScript, Tailwind utility classes, lucide-solid, Node test runner (`node --test` via `tsx/esm`), pnpm, Tauri desktop app

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Work in the dedicated worktree at `/Users/vaclavsoukup/AI agent projects/Veslo/.worktrees/codex/titlebar-session-composer`.
- Verify the flow in the Tauri desktop app, not `packages/web`.
- For the end-to-end gate, use Docker plus Chrome MCP per `AGENTS.md`.
- Baseline note: targeted titlebar/session unit tests currently pass in this worktree, but `pnpm --filter @neatech/veslo-ui typecheck` already fails on pre-existing unrelated errors in:
  - `packages/app/src/app/app.tsx`
  - `packages/app/src/app/context/workspace.ts`
  - `packages/app/src/app/pages/skills.tsx`
  - `packages/app/src/app/stores/engine-store.ts`

### Task 1: Reconfirm the worktree baseline and record pre-existing failures

**Files:**
- Modify: none (environment preparation only)

**Step 1: Enter the dedicated worktree**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/.worktrees/codex/titlebar-session-composer
git status --short
```

Expected: no feature changes are present yet in this worktree.

**Step 2: Run the targeted session/titlebar regression set**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/components/titlebar-menu-layout.test.ts \
  src/app/components/titlebar-menu-toggles.test.ts \
  src/app/components/session/session-center-width.test.ts \
  src/app/components/session/composer-controls-layout.test.ts \
  src/app/components/session/composer-workspace-label.test.ts \
  src/app/components/session/composer-disclaimer.test.ts
```

Expected: PASS before feature changes.

**Step 3: Re-run typecheck and record the existing unrelated failures**

Run:

```bash
pnpm typecheck
```

Expected: FAIL on the current baseline with the pre-existing errors listed above. Do not fix those errors in this feature unless they block the titlebar/composer change directly.

### Task 2: Add failing source-contract tests for the new titlebar and session layout

**Files:**
- Create: `packages/app/src/app/pages/session-titlebar-layout.test.ts`
- Modify: `packages/app/src/app/components/titlebar-menu-toggles.test.ts`
- Modify: `packages/app/src/app/components/session/composer-controls-layout.test.ts`
- Test: `packages/app/src/app/pages/session-titlebar-layout.test.ts`
- Test: `packages/app/src/app/components/titlebar-menu-toggles.test.ts`
- Test: `packages/app/src/app/components/session/composer-controls-layout.test.ts`

**Step 1: Extend the titlebar source-contract test**

In `packages/app/src/app/components/titlebar-menu-toggles.test.ts`, add assertions that the component source now contains:

- brand text `Veslo by Neatech`
- a left cluster where the brand sits next to the left toggle
- an optional center-content container

Example assertions:

```ts
assert.match(source, /Veslo by Neatech/);
assert.match(source, /<div class=\{layout\.leftOffsetClass\}>[\s\S]*LeftSidebarToggleIcon[\s\S]*Veslo by Neatech/);
assert.match(source, /props\.centerContent/);
```

**Step 2: Add a new session layout source test**

Create `packages/app/src/app/pages/session-titlebar-layout.test.ts` that reads `session.tsx` and verifies:

- `SessionView` passes a center-content prop into `TitlebarMenuToggles`
- the directory label comes from the existing workspace-label helper or a session memo derived from the active workspace path
- the disclaimer text is rendered outside the `<Composer ... />` call, in the session page layout

Suggested structure:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session routes directory leaf into the shared titlebar", () => {
  assert.match(source, /<TitlebarMenuToggles[\s\S]*centerContent=\{/);
});

test("session renders disclaimer outside composer", () => {
  assert.match(source, /<Composer[\s\S]*\/>\s*<\/Show>\s*<div class="[^"]*text-\[11px\][^"]*">[\s\S]*session\.composer_disclaimer/);
});
```

**Step 3: Update the composer layout test to encode the new contract**

In `packages/app/src/app/components/session/composer-controls-layout.test.ts`:

- replace the old expectation that disclaimer renders in the composer rail
- assert that the composer source no longer contains `disclaimerText()`
- assert that the composer fallback rail no longer renders `workspaceLabel().label`
- keep the mode-switch and compact control assertions, but change the layout expectation so the composer rail reads as left/right action groups instead of path + disclaimer

Example assertions:

```ts
assert.doesNotMatch(composerSource, /disclaimerText\(\)/);
assert.doesNotMatch(composerSource, /workspaceLabel\(\)\.label/);
assert.match(composerSource, /class="mt-3 flex items-center justify-between gap-3 pt-2"/);
```

**Step 4: Run the targeted tests and confirm they fail**

Run:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/components/titlebar-menu-toggles.test.ts \
  src/app/components/session/composer-controls-layout.test.ts \
  src/app/pages/session-titlebar-layout.test.ts
```

Expected: FAIL because the current titlebar has no brand/center slots and the current composer still owns the workspace label and disclaimer.

**Step 5: Commit the failing tests**

```bash
git add \
  packages/app/src/app/components/titlebar-menu-toggles.test.ts \
  packages/app/src/app/components/session/composer-controls-layout.test.ts \
  packages/app/src/app/pages/session-titlebar-layout.test.ts
git commit -m "test: specify titlebar session composer relayout"
```

### Task 3: Extend the shared titlebar component to support brand and page-provided center content

**Files:**
- Modify: `packages/app/src/app/components/titlebar-menu-toggles.tsx`
- Modify: `packages/app/src/app/components/titlebar-menu-layout.ts`
- Test: `packages/app/src/app/components/titlebar-menu-toggles.test.ts`
- Test: `packages/app/src/app/components/titlebar-menu-layout.test.ts`

**Step 1: Add explicit titlebar content props**

Update `TitlebarMenuTogglesProps` to accept optional content:

```ts
type TitlebarMenuTogglesProps = {
  leftActive: boolean;
  rightActive: boolean;
  hideTitlebar: boolean;
  centerContent?: JSX.Element;
};
```

Keep the toggle handlers unchanged.

**Step 2: Render the left brand cluster**

In the left titlebar cluster, render:

```tsx
<div class={layout.leftOffsetClass}>
  <div class="flex items-center gap-2.5">
    <button ...>
      <LeftSidebarToggleIcon size={18} />
    </button>
    <span class="truncate text-[13px] font-medium text-gray-12">
      Veslo by Neatech
    </span>
  </div>
</div>
```

Implementation requirements:

- preserve the existing button hit area and ARIA labels
- keep drag-region behavior unchanged
- do not move the right toggle from its current safe-offset side

**Step 3: Add an optional center-content container**

Add a centered or center-column-aware container between left and right offsets. The actual class can be adjusted, but the contract should be:

```tsx
<Show when={props.centerContent}>
  <div class={layout.centerContentClass}>
    <div class="min-w-0 truncate text-[12px] text-gray-10">
      {props.centerContent}
    </div>
  </div>
</Show>
```

Also extend `TitlebarMenuLayout` with a `centerContentClass` that leaves enough safe space from the right toggle on Windows and from traffic-light spacing on macOS.

**Step 4: Run the titlebar tests**

Run:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/components/titlebar-menu-layout.test.ts \
  src/app/components/titlebar-menu-toggles.test.ts
```

Expected: PASS.

**Step 5: Commit the shared titlebar update**

```bash
git add \
  packages/app/src/app/components/titlebar-menu-toggles.tsx \
  packages/app/src/app/components/titlebar-menu-layout.ts \
  packages/app/src/app/components/titlebar-menu-layout.test.ts \
  packages/app/src/app/components/titlebar-menu-toggles.test.ts
git commit -m "feat: add brand and center slot to shared titlebar"
```

### Task 4: Route the session directory leaf into the titlebar and keep non-session views empty

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/components/session/composer-workspace-label.ts`
- Test: `packages/app/src/app/pages/session-titlebar-layout.test.ts`
- Test: `packages/app/src/app/components/session/composer-workspace-label.test.ts`

**Step 1: Make the workspace-label helper safe for titlebar reuse**

If needed, adjust `resolveComposerWorkspaceLabel(...)` so it can support the titlebar use case without implying it belongs to the composer. If the name becomes misleading, rename it and update the test file accordingly.

Keep behavior:

- local workspace path -> last path segment
- remote workspace -> existing remote label fallback
- empty path -> fallback label

**Step 2: Derive session titlebar content in `session.tsx`**

Add a memo like:

```ts
const sessionTitlebarContext = createMemo(() => {
  const label = resolveComposerWorkspaceLabel({
    isRemoteWorkspace: props.activeWorkspaceDisplay.workspaceType === "remote",
    localWorkspacePath: props.activeWorkspaceRoot,
    localLabel: tr("session.local_workspace_label"),
    remoteLabel: tr("session.remote_workspace_label"),
  });

  return label.label.trim() ? (
    <span class={label.usePathStyle ? "font-mono" : "font-medium uppercase tracking-widest"}>
      {label.label}
    </span>
  ) : null;
});
```

Then pass it into:

```tsx
<TitlebarMenuToggles
  ...
  centerContent={sessionTitlebarContext()}
/>
```

**Step 3: Keep non-session pages titlebar-only**

Update `dashboard.tsx` and any other affected call site so `TitlebarMenuToggles` is used without a directory label:

```tsx
<TitlebarMenuToggles
  leftActive={...}
  rightActive={...}
  hideTitlebar={props.hideTitlebar}
  onToggleLeft={...}
  onToggleRight={...}
/>
```

No placeholder center content should be passed on dashboard/settings-like screens.

**Step 4: Run the session titlebar and workspace-label tests**

Run:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/pages/session-titlebar-layout.test.ts \
  src/app/components/session/composer-workspace-label.test.ts
```

Expected: PASS.

**Step 5: Commit the session titlebar context work**

```bash
git add \
  packages/app/src/app/pages/session.tsx \
  packages/app/src/app/pages/dashboard.tsx \
  packages/app/src/app/components/session/composer-workspace-label.ts \
  packages/app/src/app/components/session/composer-workspace-label.test.ts \
  packages/app/src/app/pages/session-titlebar-layout.test.ts
git commit -m "feat: show session directory in titlebar"
```

### Task 5: Remove workspace/disclaimer from the composer and widen the input layout

**Files:**
- Modify: `packages/app/src/app/components/session/composer.tsx`
- Modify: `packages/app/src/app/components/session/composer-controls-layout.test.ts`
- Test: `packages/app/src/app/components/session/composer-controls-layout.test.ts`
- Test: `packages/app/src/app/components/session/session-center-width.test.ts`

**Step 1: Remove titlebar-owned state from the composer rail**

Delete from `composer.tsx`:

- the fallback workspace-label block
- disclaimer container refs and measurement logic
- disclaimer render node
- hidden disclaimer measurement span

The composer should no longer import or call:

```ts
resolveShortComposerDisclaimer
```

unless another remaining behavior still genuinely needs it.

**Step 2: Restructure the lower control rail into left/right action groups**

Refactor the post-editor controls toward:

```tsx
<div class="mt-3 flex items-center justify-between gap-3 pt-2">
  <div class="flex min-w-0 items-center gap-2">
    {/* attachments */}
    {/* mode switch */}
    {/* choose-folder button when allowed */}
  </div>
  <div class="flex shrink-0 items-center gap-2">
    {/* send / stop */}
  </div>
</div>
```

Implementation requirements:

- keep the mode switch behavior unchanged
- keep choose-folder behavior unchanged
- keep attachment behavior unchanged
- visually let the input box occupy more width by removing the old center-cluttered rail contents

**Step 3: Keep the outer composer width generous**

If necessary, adjust the composer wrapper classes so the input reads as nearly full-width within the center panel while staying aligned with the session content width. Do not reintroduce narrow caps like `325px` or old disclaimer/path padding hacks.

**Step 4: Run composer regression tests**

Run:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/components/session/composer-controls-layout.test.ts \
  src/app/components/session/session-center-width.test.ts
```

Expected: PASS.

**Step 5: Commit the composer relayout**

```bash
git add \
  packages/app/src/app/components/session/composer.tsx \
  packages/app/src/app/components/session/composer-controls-layout.test.ts \
  packages/app/src/app/components/session/session-center-width.test.ts
git commit -m "feat: simplify and widen session composer"
```

### Task 6: Move the disclaimer into session layout below the input

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/components/session/composer-disclaimer.ts`
- Modify: `packages/app/src/app/components/session/composer-disclaimer.test.ts`
- Test: `packages/app/src/app/pages/session-titlebar-layout.test.ts`
- Test: `packages/app/src/app/components/session/composer-disclaimer.test.ts`

**Step 1: Keep disclaimer text resolution simple**

Decide whether the short-disclaimer helper is still needed once the text sits outside the composer. If the full localized disclaimer now fits acceptably in the layout, remove the shortening behavior and update tests accordingly. If the helper stays, document that the session footer still uses the shortened first sentence on narrow widths.

**Step 2: Render the disclaimer in `session.tsx` below the composer**

Add a session-level footer block after the `<Composer ... />` section:

```tsx
<div class={`mx-auto w-full ${chatBodyWidthClass()} px-4 pb-3`}>
  <div class="flex justify-end">
    <span class="text-[11px] leading-4 text-gray-9 text-right">
      {tr("session.composer_disclaimer")}
    </span>
  </div>
</div>
```

Tune the width helper if needed so the disclaimer visually sits in the lower-right edge of the center panel directly below the composer.

**Step 3: Update tests**

- `session-titlebar-layout.test.ts` should now pass because the disclaimer exists in session layout instead of the composer.
- `composer-disclaimer.test.ts` should be reduced or rewritten to cover only the text-shortening helper if that helper still exists.

**Step 4: Run the disclaimer/session tests**

Run:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/pages/session-titlebar-layout.test.ts \
  src/app/components/session/composer-disclaimer.test.ts
```

Expected: PASS.

**Step 5: Commit the disclaimer relocation**

```bash
git add \
  packages/app/src/app/pages/session.tsx \
  packages/app/src/app/components/session/composer-disclaimer.ts \
  packages/app/src/app/components/session/composer-disclaimer.test.ts \
  packages/app/src/app/pages/session-titlebar-layout.test.ts
git commit -m "feat: move session disclaimer below composer"
```

### Task 7: Run the regression set and desktop verification flow

**Files:**
- Create: `packages/app/pr/screenshots/session-titlebar-composer-default.png`
- Create: `packages/app/pr/screenshots/session-titlebar-composer-settings.png`

**Step 1: Run the targeted regression suite**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/components/titlebar-menu-layout.test.ts \
  src/app/components/titlebar-menu-toggles.test.ts \
  src/app/components/session/session-center-width.test.ts \
  src/app/components/session/composer-controls-layout.test.ts \
  src/app/components/session/composer-workspace-label.test.ts \
  src/app/components/session/composer-disclaimer.test.ts \
  src/app/pages/session-titlebar-layout.test.ts
```

Expected: PASS.

**Step 2: Re-run `typecheck` and record status honestly**

Run:

```bash
pnpm typecheck
```

Expected:

- either the same pre-existing failures remain with no new titlebar/composer-specific errors, or
- additional new failures appear and must be fixed before continuing

**Step 3: Start the required Veslo local dev stack**

Run from the repo root:

```bash
packaging/docker/dev-up.sh
pnpm dev
```

Expected: Docker services start and the Tauri desktop app launches. Do not use `packages/web` directly.

**Step 4: Perform manual/Chrome MCP verification**

Use the Tauri app and Chrome MCP flow to confirm:

- Session view shows `Veslo by Neatech` next to the left toggle in the titlebar
- Session view shows the directory leaf in the same titlebar
- No extra header row appears below the titlebar
- Composer no longer shows the workspace label inside the input area
- Disclaimer appears below the composer at the lower-right edge of the center panel
- Dashboard keeps the brand in the titlebar
- Settings does not show a meaningless directory label

**Step 5: Save screenshots into the repo**

Save at least:

- `packages/app/pr/screenshots/session-titlebar-composer-default.png`
- `packages/app/pr/screenshots/session-titlebar-composer-settings.png`

**Step 6: Commit the final verification checkpoint**

```bash
git add \
  packages/app/pr/screenshots/session-titlebar-composer-default.png \
  packages/app/pr/screenshots/session-titlebar-composer-settings.png
git commit -m "test: capture titlebar and composer verification"
```
