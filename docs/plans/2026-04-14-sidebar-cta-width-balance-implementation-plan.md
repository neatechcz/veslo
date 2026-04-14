# Sidebar CTA Width Balance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore `New session` to its original natural width while keeping `Add directory / project` as the single expanding CTA and increasing the directory icon size.

**Architecture:** Limit the change to the existing sidebar top-rail markup and the layout source-contract test. Avoid altering overflow behavior, callbacks, or unrelated sidebar logic.

**Tech Stack:** SolidJS, TypeScript, Tailwind utility classes, Node source-contract tests

---

### Task 1: Lock the Correct Width Distribution in Tests

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Write the failing test**

- Assert that the `New session` wrapper is `shrink-0` instead of `flex-1`.
- Assert that the middle `Add directory / project` wrapper remains `flex-1`.
- Assert that the directory icon is larger than before.

**Step 2: Run test to verify it fails**

Run:

```bash
node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: FAIL because the current layout still stretches `New session` and keeps the icon at the previous follow-up size.

### Task 2: Implement the Minimal Layout Correction

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`

**Step 1: Update the rail wrappers and icon**

- Give `New session` a content-width wrapper/button.
- Keep `Add directory / project` as the only `flex-1` CTA.
- Increase the `FolderPlus` icon again.

**Step 2: Run the layout test**

Run:

```bash
node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: PASS

### Task 3: Re-run Focused Sidebar Verification

**Files:**
- Verify: `packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts`
- Verify: `packages/app/src/app/components/session/workspace-session-list-overflow-menu.test.ts`

**Step 1: Run focused verification**

Run:

```bash
node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts src/app/components/session/workspace-session-list-controls-tooltips.test.ts src/app/components/session/workspace-session-list-overflow-menu.test.ts
```

Expected: PASS
