# Resizable Chat Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the top Chat control and make the bottom Chaty section the working, resizable, collapsible chat surface.

**Architecture:** Keep by-project project rows in the existing scroll region and keep Chaty anchored at the bottom. Persist Chaty height/collapse state with the other sidebar preferences. Put the numeric sizing rules in the windowing helper module so tests can verify threshold behavior directly.

**Tech Stack:** SolidJS signals and JSX, localStorage sidebar prefs, Node test runner source/unit tests, pnpm workspace commands.

---

### Task 1: Write failing tests for layout and button wiring

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`

**Steps:**

1. Assert the top rail no longer has a `sidebar.new_chat` tooltip or `naturalTopRailButtonClass`.
2. Assert the Chaty section still renders `sidebar.chats`, owns `sidebar.new_chat`, and calls a shared `startQuickChat` handler.
3. Assert the Chaty button is not disabled by `props.newTaskDisabled`.
4. Assert the collapsed Chaty row uses an upward chevron and only appears in by-project mode.
5. Run the focused tests and confirm they fail on the current implementation.

### Task 2: Write failing tests for prefs and sizing rules

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-windowing.test.ts`

**Steps:**

1. Add preference tests for reading/writing Chaty height and collapsed state.
2. Add sizing tests for default height, clamping, restore height, and collapse threshold.
3. Run the focused tests and confirm they fail because helpers do not exist yet.

### Task 3: Implement helpers and prefs

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-windowing.ts`

**Steps:**

1. Add storage keys and normalized read/write helpers for Chaty height and collapsed state.
2. Add constants and pure helpers for minimum height, default height, max height, clamp, and collapse threshold.
3. Re-run the focused prefs/windowing tests and confirm they pass.

### Task 4: Update the Solid sidebar component

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`

**Steps:**

1. Remove the top Chat button and its label helper/class.
2. Keep the add-directory menu ref only around the add-directory control and preserve the fallback workspace menu behavior if the quick-chat action is unavailable.
3. Add Chaty height/collapse signals from prefs.
4. Add pointer-driven resize handlers on the Chaty divider.
5. Render expanded Chaty with a fixed list height and collapsed Chaty as a compact row with `ChevronUp`.
6. Wire the Chaty button to the same quick-chat handler and do not gate it on `newTaskDisabled`.
7. Re-run the focused layout/interactions tests and fix mismatches.

### Task 5: Verify and commit

**Files:**
- All touched files

**Steps:**

1. Run the focused sidebar tests.
2. Run `pnpm --filter @neatech/veslo-ui test:unit`.
3. Run `pnpm typecheck`.
4. Check git status.
5. Commit the implementation on `dev_vaclav`.
