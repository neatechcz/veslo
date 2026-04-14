# Sidebar Overflow Button Sizing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the top-right `More actions` button compact and circular, and use the reclaimed width to enlarge the middle `Add directory / project` CTA while increasing its folder icon.

**Architecture:** Keep the change inside the existing sidebar top-rail markup and source-contract tests. Do not alter overflow menu behavior, callbacks, or accessibility semantics beyond the layout wrapper classes needed for the compact button.

**Tech Stack:** SolidJS, TypeScript, Tailwind utility classes, Node source-contract tests

---

### Task 1: Lock the Expected Rail Shape in Tests

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`
- Verify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Write the failing test**

- Add assertions that the `More actions` wrapper is fixed-width instead of `flex-1`.
- Add assertions that the `More actions` button uses a compact square/round class instead of the shared full-width rail button class.
- Add assertions that `FolderPlus` renders with a larger size than `Plus`.

**Step 2: Run test to verify it fails**

Run:

```bash
node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: FAIL because the current rail still gives `More actions` equal width and keeps `FolderPlus` at the same size family as `Plus`.

### Task 2: Implement the Minimal Layout Change

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Verify: `packages/app/src/app/components/session/workspace-session-list.tsx`

**Step 1: Update the top rail**

- Split the shared rail button styling so the full-width text buttons and compact overflow button can differ.
- Keep `New session` unchanged.
- Keep `Add directory / project` full-width and enlarge `FolderPlus`.
- Change the `More actions` wrapper to fixed width and the button to a compact round icon control.

**Step 2: Run the targeted test to verify it passes**

Run:

```bash
node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: PASS

### Task 3: Re-run the Focused Sidebar Suite

**Files:**
- Verify: `packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts`
- Verify: `packages/app/src/app/components/session/workspace-session-list-overflow-menu.test.ts`

**Step 1: Run focused verification**

Run:

```bash
node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts src/app/components/session/workspace-session-list-controls-tooltips.test.ts src/app/components/session/workspace-session-list-overflow-menu.test.ts
```

Expected: PASS

**Step 2: Commit**

```bash
git add docs/plans/2026-04-14-sidebar-overflow-button-sizing-design.md docs/plans/2026-04-14-sidebar-overflow-button-sizing-implementation-plan.md packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-layout.test.ts
git commit -m "fix: tighten sidebar overflow button sizing"
```
