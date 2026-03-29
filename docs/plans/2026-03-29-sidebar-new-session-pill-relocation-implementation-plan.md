# Sidebar New Session Pill Relocation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the New Session action into the sidebar control row as an oval `+ new` pill with responsive label expansion (`>=300px`) and tooltip coverage on all five related controls.

**Architecture:** Refactor `WorkspaceSessionList` so the primary new-session action lives in the same control row as folder/recent/search/add-directory actions. Keep existing create-session behavior intact by reusing the current `onQuickNewSession` vs dropdown-branch logic. Use a local `ResizeObserver` in `WorkspaceSessionList` to switch the new button label between compact and expanded text based on component width.

**Tech Stack:** SolidJS (`createSignal`, `createMemo`, lifecycle cleanup), TypeScript, Tailwind utility classes, lucide-solid icons, Node test runner (`node --test --import=tsx/esm`), Veslo Tauri desktop runtime.

---

### Task 1: Prepare Isolated Worktree and Baseline

**Files:**
- Create: none
- Modify: none
- Test: none

**Step 1: Sync main and submodules/references before feature work**

Run:
```bash
git fetch --all --prune
pnpm install
```
Expected: fetch and dependency install complete without errors.

**Step 2: Create a dedicated feature worktree**

Run:
```bash
git worktree add ../Veslo-sidebar-new-pill -b codex/sidebar-new-pill origin/main
```
Expected: new worktree folder created and checked out on `codex/sidebar-new-pill`.

**Step 3: Move into the worktree and confirm clean status**

Run:
```bash
cd ../Veslo-sidebar-new-pill
git status --short --branch
```
Expected: clean working tree on `codex/sidebar-new-pill`.

**Step 4: Capture baseline behavior quickly (no edits yet)**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```
Expected: PASS on current baseline.

**Step 5: Commit only if setup script or metadata changed**

Run:
```bash
git status --short
```
Expected: no commit needed for setup-only task unless files changed unexpectedly.

### Task 2: Add Failing Tests for Responsive New-Label Threshold

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`

**Step 1: Write failing tests for width-threshold helper**

Add tests like:
```ts
test("shouldUseExpandedNewSessionLabel returns true at threshold and above", () => {
  assert.equal(shouldUseExpandedNewSessionLabel(300), true);
  assert.equal(shouldUseExpandedNewSessionLabel(420), true);
});

test("shouldUseExpandedNewSessionLabel returns false below threshold", () => {
  assert.equal(shouldUseExpandedNewSessionLabel(299), false);
  assert.equal(shouldUseExpandedNewSessionLabel(0), false);
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-model.test.ts
```
Expected: FAIL because helper does not exist yet.

**Step 3: Implement minimal helper in model file**

Add implementation:
```ts
export const NEW_SESSION_LABEL_EXPAND_WIDTH = 300;

export const shouldUseExpandedNewSessionLabel = (width: number): boolean =>
  Number.isFinite(width) && width >= NEW_SESSION_LABEL_EXPAND_WIDTH;
```

**Step 4: Re-run model test**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-model.test.ts
```
Expected: PASS.

**Step 5: Commit**

Run:
```bash
git add packages/app/src/app/components/session/workspace-session-list-model.ts packages/app/src/app/components/session/workspace-session-list-model.test.ts
git commit -m "test: cover sidebar new-button label threshold"
```

### Task 3: Refactor Sidebar Control Row (Layout + Placement)

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Write failing layout assertions for required order and placement**

Update layout test with assertions for:
```ts
assert.match(source, /Folder[\s\S]*List[\s\S]*sidebar\.new[\s\S]*Search[\s\S]*FolderPlus/);
assert.doesNotMatch(source, /class="w-full flex items-center justify-center[\s\S]*sidebar\.new_session/);
```

**Step 2: Run layout test to verify failure**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```
Expected: FAIL before JSX refactor.

**Step 3: Implement minimal JSX refactor**

In `workspace-session-list.tsx`:
1. Remove the top standalone full-width new-session button block.
2. Add a new oval button inside the left pill cluster after `recents`.
3. Keep `search` and `add-directory` in the right cluster.

**Step 4: Re-run layout test**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```
Expected: PASS.

**Step 5: Commit**

Run:
```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-layout.test.ts
git commit -m "feat: move new-session action into sidebar control row"
```

### Task 4: Implement Width Observation and Responsive Label Switching

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Add failing assertion for threshold-driven label usage**

Add regex checks for helper usage and compact/expanded labels in source.

**Step 2: Run layout test to verify failure**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```
Expected: FAIL until observer/logic exists.

**Step 3: Implement observer + derived label state**

Add local signals and observer wiring in `WorkspaceSessionList`:
```ts
const [listWidth, setListWidth] = createSignal(0);
const expandedNewLabel = createMemo(() => shouldUseExpandedNewSessionLabel(listWidth()));
```
Then attach `ResizeObserver` to component root and switch rendered label between `tr("sidebar.new")` and `tr("sidebar.new_session")`.

**Step 4: Re-run layout test**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```
Expected: PASS.

**Step 5: Commit**

Run:
```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-layout.test.ts
git commit -m "feat: expand sidebar new pill label at 300px width"
```

### Task 5: Add Tooltips and i18n Key Coverage

**Files:**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Create: `packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts`

**Step 1: Write failing tooltip coverage test**

Create test asserting `title` + `aria-label` coverage on all five controls.

**Step 2: Run tooltip test to verify failure**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-controls-tooltips.test.ts
```
Expected: FAIL before all attributes and key(s) are present.

**Step 3: Implement i18n + tooltip wiring**

1. Add new i18n key:
```ts
"sidebar.new": "New"
```
and Czech equivalent:
```ts
"sidebar.new": "Nová"
```
2. Apply `title` + `aria-label` to folder, recents, new, search, new-folder controls.
3. Use `sidebar.new_session` as tooltip/aria label for the new button.

**Step 4: Re-run tooltip test + i18n parity**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-controls-tooltips.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```
Expected: PASS.

**Step 5: Commit**

Run:
```bash
git add packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-controls-tooltips.test.ts
git commit -m "feat: add sidebar new-pill label + tooltip localization"
```

### Task 6: Regression Test Sweep for Sidebar Session List

**Files:**
- Modify: none
- Test: existing session-list tests

**Step 1: Run focused session-list test bundle**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list*.test.ts
```
Expected: PASS.

**Step 2: Run sidebar wiring tests**

Run:
```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-directory-session-wiring.test.ts src/app/pages/session-sidebar-navigation-layout.test.ts src/app/pages/dashboard-sidebar-navigation-layout.test.ts
```
Expected: PASS.

**Step 3: Run typecheck for safety**

Run:
```bash
pnpm --filter @neatech/veslo-ui typecheck
```
Expected: PASS.

**Step 4: Review diff for unintended changes**

Run:
```bash
git status --short
git diff --stat
```
Expected: only intended files changed.

**Step 5: Commit any final test-only adjustments**

Run:
```bash
git add -A
git commit -m "test: verify sidebar new-pill relocation regression suite"
```
Expected: commit may be skipped if no additional file edits were needed.

### Task 7: End-to-End Desktop Verification (Required Feature Gate)

**Files:**
- Create: `evidence/sidebar-new-session-pill/*.png`
- Modify: PR notes when PR is prepared

**Step 1: Start Veslo Docker dev stack from repo root**

Run:
```bash
packaging/docker/dev-up.sh
```
Expected: containers/services healthy.

**Step 2: Launch Tauri desktop app (not web app)**

Run:
```bash
pnpm --filter @neatech/veslo dev
```
Expected: desktop shell starts and connects to dev stack.

**Step 3: Validate flow via Chrome MCP skill**

Use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` to verify:
1. control order is `folder • recents • nová • search • new folder`
2. hover tooltips appear for all five controls
3. label changes from short to full around 300px sidebar width
4. new-button click behavior matches existing flow

**Step 4: Capture screenshots for evidence**

Capture and save:
1. compact width (`+ nová`)
2. expanded width (`+ nová relace`)
3. tooltip examples

Suggested paths:
```text
evidence/sidebar-new-session-pill/compact.png
evidence/sidebar-new-session-pill/expanded.png
evidence/sidebar-new-session-pill/tooltips.png
```

**Step 5: Commit evidence and summarize QA results**

Run:
```bash
git add evidence/sidebar-new-session-pill
git commit -m "docs: add sidebar new-pill UI verification evidence"
```

### Task 8: Final Review and PR Readiness

**Files:**
- Modify: PR description/checklist

**Step 1: Prepare concise change summary**

Include:
1. moved new-session control
2. responsive label threshold
3. tooltip coverage
4. unchanged create-session branching

**Step 2: Attach evidence references**

Reference screenshot paths in PR summary.

**Step 3: Include test command transcript in PR**

List exact commands from Tasks 2-7 with PASS/FAIL result.

**Step 4: Confirm no AGENTS.md gate is skipped**

Checklist:
1. Tauri used (not web app)
2. Docker stack used
3. Chrome MCP flow tested
4. screenshots captured

**Step 5: Final clean-state verification**

Run:
```bash
git status --short --branch
```
Expected: clean branch ready for review.
