# Dashboard + Session Titlebar Context Swap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move titlebar context so `Veslo by Neatech` stays on the left and the centered titlebar slot shows session directory/workspace context (Session) or current area including concrete settings subsection (Dashboard).

**Architecture:** Keep `TitlebarMenuToggles` unchanged as a shared shell and only change what each page passes into `leftContent`/`centerContent`. Session will pass existing `sessionTitlebarContext()` into `centerContent`; Dashboard will compute `dashboardTitlebarContext()` from `tab` + `settingsTab` and pass it into `centerContent`.

**Tech Stack:** SolidJS (`createMemo`, JSX props), TypeScript, Node test runner (`node --test --import=tsx/esm`), pnpm workspace scripts.

---

Execution notes:

- Apply `@test-driven-development` for each behavior change.
- Apply `@verification-before-completion` before claiming done.

### Task 1: Session Titlebar Slot Swap

**Files:**
- Modify: `packages/app/src/app/pages/session-titlebar-layout.test.ts`
- Modify: `packages/app/src/app/pages/session.tsx`
- Test: `packages/app/src/app/pages/session-titlebar-layout.test.ts`

**Step 1: Write the failing test**

Update `session-titlebar-layout.test.ts` expectations so Session requires center slot context and rejects left-slot override:

```ts
test("session routes the current directory into the centered titlebar slot", () => {
  assert.match(
    source,
    /<TitlebarMenuToggles[\s\S]*centerContent=\{sessionTitlebarContext\(\)\}/,
  );
});

test("session keeps shared brand fallback in the left titlebar slot", () => {
  assert.doesNotMatch(source, /leftContent=\{/);
  assert.doesNotMatch(source, /showBrand=\{false\}/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/session-titlebar-layout.test.ts
```

Expected: FAIL because `session.tsx` still passes `leftContent` + `showBrand={false}` and does not pass `centerContent`.

**Step 3: Write minimal implementation**

In `session.tsx`, update `TitlebarMenuToggles` props:

```tsx
<TitlebarMenuToggles
  leftActive={leftSidebarToggleActive()}
  rightActive={rightSidebarToggleActive()}
  centerContent={sessionTitlebarContext()}
  hideTitlebar={props.hideTitlebar}
  onToggleLeft={() => toggleSidebarMenu("left")}
  onToggleRight={() => toggleSidebarMenu("right")}
/>
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/session-titlebar-layout.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-titlebar-layout.test.ts
git commit -m "feat(session): center session context in titlebar"
```

### Task 2: Dashboard Center Context + Settings Subsection Label

**Files:**
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`

**Step 1: Write the failing test**

Add source-contract assertions in `dashboard-menu-navigation.test.ts`:

```ts
test("dashboard passes contextual center content into titlebar", () => {
  assert.match(dashboardSource, /centerContent=\{dashboardTitlebarContext\(\)\}/);
});

test("dashboard titlebar resolves concrete settings subsection labels", () => {
  assert.match(dashboardSource, /const\s+settingsTitlebarSection\s*=\s*createMemo/);
  assert.match(dashboardSource, /case\s+"general":[\s\S]*return\s+"General"/);
  assert.match(dashboardSource, /case\s+"model":[\s\S]*return\s+"Model"/);
  assert.match(dashboardSource, /case\s+"advanced":[\s\S]*return\s+"Advanced"/);
  assert.match(dashboardSource, /case\s+"debug":[\s\S]*return\s+"Debug"/);
  assert.match(dashboardSource, /default:[\s\S]*return\s+"General"/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: FAIL because `dashboard.tsx` currently does not define `dashboardTitlebarContext` and does not pass `centerContent`.

**Step 3: Write minimal implementation**

In `dashboard.tsx`, add memos and pass center content:

```tsx
const settingsTitlebarSection = createMemo(() => {
  switch (props.settingsTab) {
    case "model":
      return "Model";
    case "advanced":
      return "Advanced";
    case "debug":
      return "Debug";
    case "general":
    default:
      return "General";
  }
});

const dashboardTitlebarContext = createMemo(() =>
  props.tab === "settings" ? settingsTitlebarSection() : title(),
);
```

And in JSX:

```tsx
<TitlebarMenuToggles
  leftActive={leftMenuActive()}
  rightActive={rightSidebarVisible()}
  centerContent={dashboardTitlebarContext()}
  hideTitlebar={props.hideTitlebar}
  leftLabel={leftMenuLabel()}
  onToggleLeft={handleLeftMenuToggle}
  onToggleRight={() => toggleSidebarMenu("right")}
/>
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/dashboard-menu-navigation.test.ts
git commit -m "feat(dashboard): show centered titlebar area context"
```

### Task 3: Cross-Check + Desktop Runtime Smoke

**Files:**
- Test: `packages/app/src/app/pages/session-titlebar-layout.test.ts`
- Test: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`
- Verify runtime: `packages/desktop`

**Step 1: Run focused regression tests**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/pages/session-titlebar-layout.test.ts \
  src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: PASS for both files.

**Step 2: Run broader app unit suite**

Run:

```bash
cd packages/app
pnpm test:unit
```

Expected: PASS; if unrelated pre-existing failures appear, capture exact failing tests and treat as out-of-scope baseline.

**Step 3: Run typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS; if baseline failures already exist, record them explicitly in handoff notes.

**Step 4: Manual desktop smoke (required app runtime rule)**

Run:

```bash
cd packages/desktop
pnpm tauri dev
```

Manual checks:

1. Session: left titlebar shows `Veslo by Neatech`, center shows directory/workspace label.
2. Dashboard Skills/Extensions/Advanced: center shows current section.
3. Dashboard Settings: center changes with subsection (`General`, `Model`, `Advanced`, `Debug`).

Expected: behavior matches acceptance criteria without layout overlap.

**Step 5: Commit verification notes (only if files changed)**

```bash
git status --short
git add <only files changed during verification>
git commit -m "test: verify titlebar context swap behavior"
```

If no files changed in verification, skip this commit.

## Acceptance Gate

1. Session no longer overrides left titlebar content; brand fallback is visible.
2. Session context renders in centered titlebar slot.
3. Dashboard passes centered context.
4. Dashboard `settings` center label reflects concrete subsection with safe fallback to `General`.
5. Updated tests enforce this contract.
