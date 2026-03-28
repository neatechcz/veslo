# Left Sidebar Drag Resize Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement shared drag-resize behavior for the left sidebar in Session and Dashboard, with persisted width (`220..420`, default `260`) and no visual redesign.

**Architecture:** Introduce a shared width preference helper (constants + clamp + localStorage read/write) and consume it from both pages. Parameterize Session width calculations so responsive mode uses current left width instead of fixed `260`. Add invisible pointer hit area on the right edge of the left sidebar in both pages to drive resize interactions, persisting on drag end.

**Tech Stack:** SolidJS, TypeScript, Tailwind utility classes, Node test runner (`node --test` via `tsx/esm`), pnpm

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Run implementation in a dedicated worktree before touching feature code.
- Keep UI visual style unchanged (no permanent visible grip decoration).

### Task 1: Create worktree and baseline verification

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync repository state**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: completes without errors.

**Step 2: Create and enter feature worktree**

Run:

```bash
git worktree add .worktrees/codex/left-sidebar-drag-resize -b codex/left-sidebar-drag-resize
cd .worktrees/codex/left-sidebar-drag-resize
```

Expected: new worktree is created and branch is checked out.

**Step 3: Capture baseline health**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS before feature edits.

### Task 2: Add failing tests for shared left sidebar width preferences

**Files:**
- Create: `packages/app/src/app/components/layout/left-sidebar-width-prefs.test.ts`
- Test: `packages/app/src/app/components/layout/left-sidebar-width-prefs.test.ts`

**Step 1: Write failing tests for constants and clamping**

Add tests asserting:

```ts
assert.equal(LEFT_SIDEBAR_WIDTH_MIN, 220);
assert.equal(LEFT_SIDEBAR_WIDTH_DEFAULT, 260);
assert.equal(LEFT_SIDEBAR_WIDTH_MAX, 420);
assert.equal(clampLeftSidebarWidth(10), 220);
assert.equal(clampLeftSidebarWidth(999), 420);
assert.equal(clampLeftSidebarWidth(301), 301);
```

**Step 2: Write failing tests for storage read fallback behavior**

Use storage stubs to assert:
- missing value => default
- invalid JSON => default
- non-number payload => default
- out-of-range payload => clamped

**Step 3: Write failing tests for storage writes**

Assert writes are clamped and serialized correctly.

**Step 4: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/layout/left-sidebar-width-prefs.test.ts
```

Expected: FAIL because module does not exist yet.

**Step 5: Commit failing tests**

```bash
git add packages/app/src/app/components/layout/left-sidebar-width-prefs.test.ts
git commit -m "test: add left sidebar width preference specs"
```

### Task 3: Implement shared width preference helper

**Files:**
- Create: `packages/app/src/app/components/layout/left-sidebar-width-prefs.ts`
- Modify: `packages/app/src/app/components/layout/left-sidebar-width-prefs.test.ts` (only if minor assertion adjustments are needed)
- Test: `packages/app/src/app/components/layout/left-sidebar-width-prefs.test.ts`

**Step 1: Implement constants and clamp helper**

Implement:

```ts
export const LEFT_SIDEBAR_WIDTH_MIN = 220;
export const LEFT_SIDEBAR_WIDTH_DEFAULT = 260;
export const LEFT_SIDEBAR_WIDTH_MAX = 420;
export const LEFT_SIDEBAR_WIDTH_KEY = "veslo.global.sidebar.left-width.v1";

export const clampLeftSidebarWidth = (value: number): number => {
  if (!Number.isFinite(value)) return LEFT_SIDEBAR_WIDTH_DEFAULT;
  return Math.min(LEFT_SIDEBAR_WIDTH_MAX, Math.max(LEFT_SIDEBAR_WIDTH_MIN, Math.round(value)));
};
```

**Step 2: Implement `readLeftSidebarWidth` / `writeLeftSidebarWidth`**

Requirements:
- SSR-safe (`typeof window === "undefined"`)
- JSON parse safety
- always clamp before returning/writing

**Step 3: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/layout/left-sidebar-width-prefs.test.ts
```

Expected: PASS.

**Step 4: Commit helper implementation**

```bash
git add packages/app/src/app/components/layout/left-sidebar-width-prefs.ts packages/app/src/app/components/layout/left-sidebar-width-prefs.test.ts
git commit -m "feat: add shared left sidebar width preferences"
```

### Task 4: Add failing tests for Session width calculation parameterization

**Files:**
- Modify: `packages/app/src/app/pages/session-layout-width.test.ts`
- Test: `packages/app/src/app/pages/session-layout-width.test.ts`

**Step 1: Add failing tests for custom left width input**

Add assertions such as:

```ts
assert.equal(availableChatWidthForLayout(1400, state, 320), 800);
assert.equal(availableChatWidthForLayout(1400, state, 220), 900);
```

(Using existing right sidebar width assumptions from current tests.)

**Step 2: Verify legacy behavior still covered**

Keep existing tests for narrow/wide docked preference behavior.

**Step 3: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-layout-width.test.ts
```

Expected: FAIL until function signature/logic is updated.

**Step 4: Commit failing tests**

```bash
git add packages/app/src/app/pages/session-layout-width.test.ts
git commit -m "test: cover session layout width with dynamic left sidebar"
```

### Task 5: Implement Session width calculation update

**Files:**
- Modify: `packages/app/src/app/pages/session-layout-width.ts`
- Modify: `packages/app/src/app/pages/session-layout-width.test.ts` (if needed)
- Test: `packages/app/src/app/pages/session-layout-width.test.ts`

**Step 1: Parameterize left docked width**

Update function signature to accept optional `leftSidebarWidth`:

```ts
export const availableChatWidthForLayout = (
  rootWidth: number,
  state: SidebarLayoutState,
  leftSidebarWidth = LEFT_SIDEBAR_DOCKED_WIDTH,
) => { /* ... */ }
```

Use clamped/finite-safe value before subtraction.

**Step 2: Keep backward compatibility**

Default behavior remains unchanged when third argument is omitted.

**Step 3: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-layout-width.test.ts
```

Expected: PASS.

**Step 4: Commit implementation**

```bash
git add packages/app/src/app/pages/session-layout-width.ts packages/app/src/app/pages/session-layout-width.test.ts
git commit -m "feat: support dynamic left width in session layout math"
```

### Task 6: Add failing source-contract tests for Session drag-resize integration

**Files:**
- Create: `packages/app/src/app/pages/session-left-sidebar-resize.test.ts`
- Test: `packages/app/src/app/pages/session-left-sidebar-resize.test.ts`

**Step 1: Add failing assertions for shared width helper usage**

Assert `session.tsx` imports and uses:
- `readLeftSidebarWidth`
- `writeLeftSidebarWidth`
- clamp helper/constants as needed

**Step 2: Add failing assertions for dynamic left sidebar width render**

Assert source contains dynamic inline width style for left sidebar/overlay instead of fixed `w-[260px]`.

**Step 3: Add failing assertions for invisible drag hit area and pointer handlers**

Assert presence of:
- right-edge absolute hit area
- `onPointerDown` hookup
- pointer move/up lifecycle handlers

**Step 4: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-left-sidebar-resize.test.ts
```

Expected: FAIL until Session integration is implemented.

**Step 5: Commit failing tests**

```bash
git add packages/app/src/app/pages/session-left-sidebar-resize.test.ts
git commit -m "test: specify session left sidebar drag resize contract"
```

### Task 7: Implement Session drag-resize behavior without visual redesign

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Test: `packages/app/src/app/pages/session-left-sidebar-resize.test.ts`
- Test: `packages/app/src/app/pages/session-layout-width.test.ts`

**Step 1: Add reactive left width state initialized from shared helper**

Use a signal initialized by `readLeftSidebarWidth()`.

**Step 2: Add drag lifecycle**

Implement pointer drag state:
- store `startX` + `startWidth`
- on move => compute `startWidth + deltaX`, clamp, set signal
- on end/cancel => cleanup listeners + persist with `writeLeftSidebarWidth`

**Step 3: Apply dynamic widths**

- docked left sidebar width uses signal
- overlay left sidebar width uses same signal with viewport cap (`min(width, 100vw - 32px)`)
- pass current left width to `availableChatWidthForLayout(...)`

**Step 4: Keep UI visually unchanged**

- drag area remains invisible at rest
- no permanent decorative grip line/icon

**Step 5: Run targeted tests + typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-left-sidebar-resize.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-layout-width.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 6: Commit Session implementation**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-left-sidebar-resize.test.ts packages/app/src/app/pages/session-layout-width.ts packages/app/src/app/pages/session-layout-width.test.ts
git commit -m "feat: add session left sidebar drag resize"
```

### Task 8: Add failing source-contract tests for Dashboard shared drag-resize

**Files:**
- Create: `packages/app/src/app/pages/dashboard-left-sidebar-resize.test.ts`
- Test: `packages/app/src/app/pages/dashboard-left-sidebar-resize.test.ts`

**Step 1: Add failing assertions for shared width helper usage**

Assert `dashboard.tsx` imports/uses same shared width helper.

**Step 2: Add failing assertions for dynamic left width render**

Assert fixed `w-64` left width is replaced by dynamic inline width style.

**Step 3: Add failing assertions for invisible drag hit area + pointer handlers**

Assert source includes right-edge drag zone with pointerdown handling.

**Step 4: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-left-sidebar-resize.test.ts
```

Expected: FAIL until Dashboard integration is implemented.

**Step 5: Commit failing tests**

```bash
git add packages/app/src/app/pages/dashboard-left-sidebar-resize.test.ts
git commit -m "test: specify dashboard left sidebar drag resize contract"
```

### Task 9: Implement Dashboard drag-resize behavior with shared persistence

**Files:**
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/src/app/pages/dashboard-left-sidebar-resize.test.ts`

**Step 1: Add reactive left width state from shared helper**

Initialize from `readLeftSidebarWidth()` and keep in local signal.

**Step 2: Add pointer drag lifecycle (same behavior as Session)**

- invisible right-edge hit area
- clamp updates during pointer move
- persist on end/cancel via `writeLeftSidebarWidth`

**Step 3: Apply width to left sidebar container**

Replace static width class usage with dynamic style width while keeping existing layout visibility logic.

**Step 4: Run targeted tests + typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-left-sidebar-resize.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit Dashboard implementation**

```bash
git add packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/dashboard-left-sidebar-resize.test.ts
git commit -m "feat: add dashboard left sidebar drag resize"
```

### Task 10: Final verification and integration checkpoint

**Files:**
- Modify: none (verification)

**Step 1: Run focused regression suite**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:sidebar-flat
```

Expected: PASS.

**Step 2: Manual desktop verification (Tauri only)**

Run app via Tauri (never web-only server), then verify:
- Session left sidebar drags within `220..420`
- Dashboard left sidebar matches same width
- width persists after app restart
- no visible redesign of sidebar chrome

**Step 3: Commit verification notes (if docs updated)**

If additional verification notes/screenshots were added, commit them with a dedicated message.
