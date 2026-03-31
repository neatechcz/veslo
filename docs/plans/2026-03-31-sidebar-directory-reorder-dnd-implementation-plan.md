# Sidebar Directory Reorder DnD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent, global drag-and-drop reordering of directory groups in the left sidebar when the view mode is **By project**.

**Architecture:** Keep `buildProjectGroups()` unchanged as the grouping source, then apply a UI-side ordering layer using stored project-group keys. Add native HTML5 drag-and-drop handlers in `workspace-session-list.tsx` with local transient drag state and persist order in `workspace-session-list-prefs.ts`. Scope behavior to By project mode only so Recent mode remains unchanged.

**Tech Stack:** SolidJS, TypeScript, native HTML5 Drag and Drop, localStorage-backed sidebar prefs, Node test runner (`node --test --import=tsx/esm`).

---

### Task 1: Preflight + Isolated Workspace

**Files:**
- Modify: none
- Test: none

**Step 1: Create a dedicated worktree from latest `main`**

```bash
git fetch origin
git worktree add .worktrees/sidebar-directory-reorder origin/main -b codex/sidebar-directory-reorder
```

**Step 2: Install deps in the worktree (if missing)**

```bash
cd .worktrees/sidebar-directory-reorder
pnpm install
```

**Step 3: Record clean baseline state**

Run: `git status --short`
Expected: no changes

**Step 4: Commit checkpoint note (optional if no file changes)**

No commit required in this step unless local project policy asks for a marker commit.

---

### Task 2: Add Persistent Project-Order Preferences (TDD)

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefs.test.ts`

**Step 1: Write failing tests for project order prefs**

Add tests in `workspace-session-list-prefs.test.ts` for:

```ts
test("project order defaults to empty array", () => {
  const storage = createMemoryStorage();
  assert.deepEqual(readProjectOrder(storage), []);
});

test("project order reads valid string array", () => {
  const storage = createMemoryStorage({
    "veslo.sidebar-project-order.v1": JSON.stringify(["project:a", "project:b"]),
  });
  assert.deepEqual(readProjectOrder(storage), ["project:a", "project:b"]);
});

test("project order ignores invalid payload", () => {
  const storage = createMemoryStorage({
    "veslo.sidebar-project-order.v1": JSON.stringify(["project:a", 123, ""]),
  });
  assert.deepEqual(readProjectOrder(storage), ["project:a"]);
});

test("writeProjectOrder persists normalized string array", () => {
  const storage = createMemoryStorage();
  writeProjectOrder(["project:a", "", "project:b"], storage);
  assert.equal(
    storage.snapshot()["veslo.sidebar-project-order.v1"],
    JSON.stringify(["project:a", "project:b"]),
  );
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefs.test.ts
```

Expected: FAIL with missing exports (`readProjectOrder` / `writeProjectOrder`).

**Step 3: Implement minimal prefs API**

Add in `workspace-session-list-prefs.ts`:

```ts
export const SIDEBAR_PROJECT_ORDER_KEY = "veslo.sidebar-project-order.v1";

const normalizeProjectOrder = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (!key) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
};

export const readProjectOrder = (storage?: SidebarPrefsStorage | null): string[] => { /* mirror existing read pattern */ };
export const writeProjectOrder = (order: string[], storage?: SidebarPrefsStorage | null): void => { /* mirror existing write pattern */ };
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefs.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list-prefs.ts \
  packages/app/src/app/components/session/workspace-session-list-prefs.test.ts
git commit -m "feat(sidebar): persist project group order preferences"
```

---

### Task 3: Add Pure Ordering Helpers (TDD, DRY)

**Files:**
- Create: `packages/app/src/app/components/session/workspace-session-list-order.ts`
- Create: `packages/app/src/app/components/session/workspace-session-list-order.test.ts`

**Step 1: Write failing tests for reorder/merge logic**

Add tests for:

```ts
test("applyProjectOrder applies stored key order and appends unknown keys", () => {
  // stored: [b, a], incoming: [a, c, b] => [b, a, c]
});

test("reorderProjectKeys inserts source before target", () => {
  // [a, b, c], move c before a => [c, a, b]
});

test("reorderProjectKeys returns original for self drop", () => {
  // source===target => unchanged
});

test("mergeVisibleOrder keeps hidden stored keys stable", () => {
  // stored: [x, a, b, y], visible reordered: [b, a] => [x, b, a, y]
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/workspace-session-list-order.test.ts
```

Expected: FAIL because helper module does not exist yet.

**Step 3: Implement minimal helper module**

Implement in `workspace-session-list-order.ts`:

```ts
export const applyProjectOrder = <T extends { key: string }>(groups: T[], storedOrder: string[]): T[] => { /* stable merge */ };
export const reorderProjectKeys = (keys: string[], sourceKey: string, targetKey: string): string[] => { /* move before target */ };
export const mergeVisibleOrder = (storedOrder: string[], visibleOrderedKeys: string[]): string[] => { /* keep hidden keys */ };
```

**Step 4: Run tests to verify pass**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/workspace-session-list-order.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list-order.ts \
  packages/app/src/app/components/session/workspace-session-list-order.test.ts
git commit -m "feat(sidebar): add project-group ordering helpers"
```

---

### Task 4: Wire DnD Reorder Into Sidebar By-Project View (TDD)

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts` (if selector/structure assertion updates are needed)
- Optional Modify (if adding i18n label):
  - `packages/app/src/i18n/locales/en.ts`
  - `packages/app/src/i18n/locales/cs.ts`
  - `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write failing interaction assertions**

Add source assertions checking:

```ts
assert.match(source, /GripVertical/);
assert.match(source, /draggable/);
assert.match(source, /onDragStart=\{\(event\) => handleProjectDragStart\(event, project\.key\)\}/);
assert.match(source, /onDragOver=\{\(event\) => handleProjectDragOver\(event, project\.key\)\}/);
assert.match(source, /onDrop=\{\(event\) => handleProjectDrop\(event, project\.key\)\}/);
assert.match(source, /if \(sourceKey === targetKey\) return;/);
```

**Step 2: Run tests to verify fail**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-interactions.test.ts \
  src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: FAIL until DnD handlers/rendering are implemented.

**Step 3: Implement minimal DnD + ordered rendering in component**

In `workspace-session-list.tsx`:
- Import `GripVertical`, prefs (`readProjectOrder`, `writeProjectOrder`), and ordering helpers.
- Add signals:

```ts
const [projectOrder, setProjectOrder] = createSignal<string[]>(readProjectOrder());
const [draggingProjectKey, setDraggingProjectKey] = createSignal<string | null>(null);
const [dragOverProjectKey, setDragOverProjectKey] = createSignal<string | null>(null);
```

- Add memo:

```ts
const orderedProjectGroups = createMemo(() => applyProjectOrder(projectGroups(), projectOrder()));
```

- Replace `<For each={projectGroups()}>` with `<For each={orderedProjectGroups()}>`.
- Add handlers `handleProjectDragStart/Over/Leave/Drop/End`.
- On drop:
  - guard invalid/self drop,
  - build reordered visible key list,
  - merge with stored global keys,
  - persist via `writeProjectOrder`,
  - clear transient drag states.
- Add drag target styling on group container.

**Step 4: Run tests to verify pass**

Run:

```bash
cd packages/app
node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-interactions.test.ts \
  src/app/components/session/workspace-session-list-layout.test.ts \
  src/app/components/session/workspace-session-list-prefs.test.ts \
  src/app/components/session/workspace-session-list-order.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx \
  packages/app/src/app/components/session/workspace-session-list-interactions.test.ts \
  packages/app/src/app/components/session/workspace-session-list-layout.test.ts \
  packages/app/src/app/components/session/workspace-session-list-prefs.ts \
  packages/app/src/app/components/session/workspace-session-list-prefs.test.ts \
  packages/app/src/app/components/session/workspace-session-list-order.ts \
  packages/app/src/app/components/session/workspace-session-list-order.test.ts \
  packages/app/src/i18n/locales/en.ts \
  packages/app/src/i18n/locales/cs.ts \
  packages/app/src/i18n/locales/zh.ts
git commit -m "feat(sidebar): drag and drop reorder for directory groups"
```

If i18n files were not touched, remove them from `git add`.

---

### Task 5: Regression Verification + Desktop Flow Check

**Files:**
- Modify: none (verification-only)
- Test: existing suites

**Step 1: Run focused sidebar unit tests**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/workspace-session-list*.test.ts
```

Expected: PASS for all `workspace-session-list*` tests.

**Step 2: Run app typecheck**

Run: `cd packages/app && pnpm typecheck`
Expected: PASS with no TypeScript errors.

**Step 3: Run desktop app smoke check (required runtime rule)**

Run from repo root:

```bash
pnpm --filter @neatech/veslo-desktop dev
```

Manual check:
- Open Session view.
- Switch to **By project** mode.
- Drag project group A before B.
- Restart app.
- Confirm order persists globally.
- Switch to **Recent** mode and verify unchanged behavior.

**Step 4: Commit verification note (optional)**

No code commit required if no file changes.

---

### Task 6: Final Integration Commit + PR Notes

**Files:**
- Modify: `docs/plans/2026-03-31-sidebar-directory-reorder-dnd-design.md` (only if final behavior deviated)
- Create: optional evidence screenshots under `evidence/`

**Step 1: Capture UI evidence**
- Save before/after reorder screenshots and persistence-after-restart screenshot.

**Step 2: Prepare final summary**
- Commands run + pass/fail status.
- Known limitations (no outside drop-zone; by-project only).

**Step 3: Final commit if docs/evidence changed**

```bash
git add docs/plans/2026-03-31-sidebar-directory-reorder-dnd-design.md evidence/
git commit -m "docs: attach sidebar directory reorder verification evidence"
```

---

## Implementation Notes
- Apply **@test-driven-development** per task: failing test first, then minimal implementation.
- Apply **@verification-before-completion** before claiming done.
- Keep commits small and isolated (prefs, helpers, wiring, verification artifacts).
- Do not run Next.js (`packages/web`); verify only through Tauri desktop flow.
