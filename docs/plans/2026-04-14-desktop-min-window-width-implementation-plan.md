# Desktop Min Window Width Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce a `390px` minimum width for the main Veslo desktop window and document where that value lives.

**Architecture:** Keep native enforcement in `tauri.conf.json`, add a tiny desktop contract module for documentation and test reuse, and extend the existing Tauri config test to pin the minimum width. Leave the Solid UI layout thresholds untouched because they model responsive center-column behavior, not native window constraints.

**Tech Stack:** Tauri config JSON, Node.js test runner, ESM utility module, Markdown docs

---

### Task 1: Capture the Desktop Window Contract in Docs

**Files:**
- Create: `docs/plans/2026-04-14-desktop-min-window-width-design.md`
- Create: `docs/plans/2026-04-14-desktop-min-window-width-implementation-plan.md`

**Step 1: Write the approved design down**

- Record the chosen `390px` minimum width.
- Record where the value is enforced, documented, and tested.
- Record which existing `360/392` UI thresholds stay separate.

### Task 2: Write the Failing Desktop Config Test

**Files:**
- Modify: `packages/desktop/scripts/tauri-config.test.mjs`

**Step 1: Add the missing minimum-width expectation**

- Assert that every configured desktop window has `minWidth`.
- Assert that the value equals `390`.

**Step 2: Run test to verify it fails**

Run:

```bash
node --test packages/desktop/scripts/tauri-config.test.mjs
```

Expected: FAIL because the current Tauri config does not set `minWidth`.

### Task 3: Implement the Desktop Contract

**Files:**
- Create: `packages/desktop/scripts/window-size-contract.mjs`
- Modify: `packages/desktop/src-tauri/tauri.conf.json`
- Modify: `packages/desktop/scripts/tauri-config.test.mjs`

**Step 1: Add the named contract and native minimum**

- Export `APP_WINDOW_MIN_WIDTH = 390` from the new contract module.
- Document in that module that Tauri config mirrors the value because static JSON cannot import JS.
- Set `app.windows[0].minWidth` to `390` in `tauri.conf.json`.
- Make the desktop config test import the named contract and assert against it.

**Step 2: Run test to verify it passes**

Run:

```bash
node --test packages/desktop/scripts/tauri-config.test.mjs
```

Expected: PASS

### Task 4: Final Focused Verification

**Files:**
- Verify: `packages/desktop/scripts/tauri-config.test.mjs`

**Step 1: Re-run the focused verification**

Run:

```bash
node --test packages/desktop/scripts/tauri-config.test.mjs
```

Expected: PASS

**Step 2: Commit**

```bash
git add docs/plans/2026-04-14-desktop-min-window-width-design.md docs/plans/2026-04-14-desktop-min-window-width-implementation-plan.md packages/desktop/scripts/window-size-contract.mjs packages/desktop/scripts/tauri-config.test.mjs packages/desktop/src-tauri/tauri.conf.json
git commit -m "fix: enforce desktop minimum window width"
```
