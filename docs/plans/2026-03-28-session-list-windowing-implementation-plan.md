# Session List Windowing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement scalable sidebar session windowing with per-project default 7 rows (+20 load more), recent-mode fit+3 behavior, infinite scroll, and progressive backend fetches for large session sets.

**Architecture:** Split the solution into a workspace-scoped Data Window and a mode-scoped View Window. Data Window manages progressive fetch limits (+20 batches) and load state in app-level sidebar session state. View Window applies per-project and recent-mode visibility windows inside `WorkspaceSessionList` without changing canonical sort/group logic from `workspace-session-list-model.ts`.

**Tech Stack:** SolidJS, TypeScript, Node test runner (`node --test` via `tsx/esm`), pnpm, Tauri desktop runtime, Docker dev stack

---

## Prerequisites

- Use `@superpowers:test-driven-development` while executing this plan.
- Use a dedicated worktree before implementation.
- Use Veslo runtime rules from `AGENTS.md` (do not run web-only app; validate in Tauri).
- End-to-end verification path should use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`.

### Task 1: Create worktree and capture baseline

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync repository and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: repository and submodules are up to date.

**Step 2: Create feature worktree**

Run:

```bash
git worktree add .worktrees/codex/session-list-windowing -b codex/session-list-windowing
cd .worktrees/codex/session-list-windowing
```

Expected: new worktree checked out on `codex/session-list-windowing`.

**Step 3: Baseline checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: baseline passes before feature edits.

### Task 2: Add failing tests for Data Window pagination helper

**Files:**
- Create: `packages/app/src/app/pages/sidebar-session-pagination.test.ts`
- Test: `packages/app/src/app/pages/sidebar-session-pagination.test.ts`

**Step 1: Add failing tests for limit stepping**

Add tests for behavior such as:

```ts
assert.equal(initialSidebarSessionLimit(), 20);
assert.equal(nextSidebarSessionLimit(20), 40);
assert.equal(nextSidebarSessionLimit(40, 20), 60);
```

**Step 2: Add failing tests for hasMore heuristic**

Add tests such as:

```ts
assert.equal(deriveSidebarHasMore(20, 20), true);
assert.equal(deriveSidebarHasMore(19, 20), false);
```

**Step 3: Run targeted test (expect fail)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-session-pagination.test.ts
```

Expected: FAIL (module not implemented yet).

**Step 4: Commit failing test**

```bash
git add packages/app/src/app/pages/sidebar-session-pagination.test.ts
git commit -m "test: specify sidebar data-window pagination helper"
```

### Task 3: Implement Data Window pagination helper

**Files:**
- Create: `packages/app/src/app/pages/sidebar-session-pagination.ts`
- Modify: `packages/app/src/app/pages/sidebar-session-pagination.test.ts` (only if assertions need minor correction)
- Test: `packages/app/src/app/pages/sidebar-session-pagination.test.ts`

**Step 1: Implement constants and stepping helpers**

Implement:

```ts
export const SIDEBAR_SESSION_PAGE_SIZE = 20;

export const initialSidebarSessionLimit = () => SIDEBAR_SESSION_PAGE_SIZE;

export const nextSidebarSessionLimit = (current: number, step = SIDEBAR_SESSION_PAGE_SIZE) => {
  const safeCurrent = Number.isFinite(current) && current > 0 ? Math.floor(current) : SIDEBAR_SESSION_PAGE_SIZE;
  const safeStep = Number.isFinite(step) && step > 0 ? Math.floor(step) : SIDEBAR_SESSION_PAGE_SIZE;
  return safeCurrent + safeStep;
};

export const deriveSidebarHasMore = (fetchedCount: number, requestedLimit: number) =>
  fetchedCount >= requestedLimit;
```

**Step 2: Run targeted test (expect pass)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-session-pagination.test.ts
```

Expected: PASS.

**Step 3: Commit implementation**

```bash
git add packages/app/src/app/pages/sidebar-session-pagination.ts packages/app/src/app/pages/sidebar-session-pagination.test.ts
git commit -m "feat: add sidebar session pagination helper"
```

### Task 4: Add failing tests for View Window helper

**Files:**
- Create: `packages/app/src/app/components/session/workspace-session-list-windowing.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-windowing.test.ts`

**Step 1: Add failing tests for constants and project increments**

```ts
assert.equal(PROJECT_VISIBLE_DEFAULT, 7);
assert.equal(VIEW_LOAD_MORE_STEP, 20);
assert.equal(nextProjectVisibleCount(7), 27);
```

**Step 2: Add failing tests for recent initial calculation (`fit + 3`)**

```ts
assert.equal(computeInitialRecentVisibleCount(320, 40), 11); // 8 + 3
assert.equal(computeInitialRecentVisibleCount(0, 40), 3);
```

**Step 3: Run targeted test (expect fail)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-windowing.test.ts
```

Expected: FAIL (module not implemented yet).

**Step 4: Commit failing test**

```bash
git add packages/app/src/app/components/session/workspace-session-list-windowing.test.ts
git commit -m "test: define session list view-window behavior"
```

### Task 5: Implement View Window helper module

**Files:**
- Create: `packages/app/src/app/components/session/workspace-session-list-windowing.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-windowing.test.ts` (if needed)
- Test: `packages/app/src/app/components/session/workspace-session-list-windowing.test.ts`

**Step 1: Implement reusable windowing helpers**

Implement helpers:

```ts
export const PROJECT_VISIBLE_DEFAULT = 7;
export const VIEW_LOAD_MORE_STEP = 20;
export const RECENT_OVERSCAN_ROWS = 3;

export const nextProjectVisibleCount = (current: number) =>
  Math.max(PROJECT_VISIBLE_DEFAULT, Math.floor(current || 0) + VIEW_LOAD_MORE_STEP);

export const computeInitialRecentVisibleCount = (
  containerHeight: number,
  estimatedRowHeight: number,
  overscan = RECENT_OVERSCAN_ROWS,
) => {
  const row = Number.isFinite(estimatedRowHeight) && estimatedRowHeight > 0 ? estimatedRowHeight : 40;
  const fit = Number.isFinite(containerHeight) && containerHeight > 0 ? Math.floor(containerHeight / row) : 0;
  return Math.max(overscan, fit + overscan);
};
```

**Step 2: Run targeted test (expect pass)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-windowing.test.ts
```

Expected: PASS.

**Step 3: Commit implementation**

```bash
git add packages/app/src/app/components/session/workspace-session-list-windowing.ts packages/app/src/app/components/session/workspace-session-list-windowing.test.ts
git commit -m "feat: add reusable sidebar session view-window helpers"
```

### Task 6: Add failing contract tests for new sidebar paging wiring

**Files:**
- Modify: `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts`
- Create: `packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts`
- Test: `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts`

**Step 1: Extend wiring tests for new props from pages into component**

Add assertions that `session.tsx` and `dashboard.tsx` wire:

```ts
onLoadMoreWorkspaceSessions={props.loadMoreWorkspaceSidebarSessions}
workspaceSessionPagingById={props.workspaceSessionPagingById}
```

**Step 2: Add failing layout/contract tests for UI controls**

Assert `workspace-session-list.tsx` contains:

- per-project slicing to default 7 rows
- project-level `Load more (+20)` control
- recent sentinel/infinite-scroll hook
- recent fallback button

**Step 3: Run targeted tests (expect fail)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-directory-session-wiring.test.ts src/app/components/session/workspace-session-list-windowing-layout.test.ts
```

Expected: FAIL until plumbing + UI are implemented.

**Step 4: Commit failing tests**

```bash
git add packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts
git commit -m "test: cover sidebar paging prop wiring and windowing UI contracts"
```

### Task 7: Implement app-level Data Window state and page prop plumbing

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts`
- Test: `packages/app/src/app/pages/sidebar-session-pagination.test.ts`

**Step 1: Add per-workspace pagination state in `app.tsx`**

Add signals:

```ts
const [sidebarSessionLimitByWorkspaceId, setSidebarSessionLimitByWorkspaceId] = createSignal<Record<string, number>>({});
const [sidebarSessionHasMoreByWorkspaceId, setSidebarSessionHasMoreByWorkspaceId] = createSignal<Record<string, boolean>>({});
const [sidebarSessionLoadingMoreByWorkspaceId, setSidebarSessionLoadingMoreByWorkspaceId] = createSignal<Record<string, boolean>>({});
```

**Step 2: Update refresh logic to use dynamic request limit**

Use helper:

```ts
const requestLimit = sidebarSessionLimitByWorkspaceId()[id] ?? initialSidebarSessionLimit();
const list = unwrap(await c.session.list({ directory: queryDirectory, roots: false, limit: requestLimit }));
setSidebarSessionHasMoreByWorkspaceId((prev) => ({ ...prev, [id]: deriveSidebarHasMore(list.length, requestLimit) }));
```

**Step 3: Implement `loadMoreWorkspaceSidebarSessions(workspaceId)` in `app.tsx`**

Behavior:

- guard against concurrent calls per workspace
- bump limit with `nextSidebarSessionLimit(current, 20)`
- call `refreshSidebarWorkspaceSessions(workspaceId)`

**Step 4: Thread new props to Session/Dashboard and into `WorkspaceSessionList`**

Add props in `SessionViewProps` and `DashboardViewProps`:

```ts
workspaceSessionPagingById: Record<string, { hasMore: boolean; loadingMore: boolean }>;
loadMoreWorkspaceSidebarSessions: (workspaceId: string) => Promise<void> | void;
```

**Step 5: Run targeted tests (expect pass)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-session-pagination.test.ts src/app/pages/sidebar-directory-session-wiring.test.ts
```

Expected: PASS.

**Step 6: Commit implementation**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx
git commit -m "feat: add progressive workspace sidebar data-window paging"
```

### Task 8: Implement `WorkspaceSessionList` view window + controls + i18n

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts`

**Step 1: Add new props in component for paging metadata + load-more callback**

```ts
workspaceSessionPagingById?: Record<string, { hasMore: boolean; loadingMore: boolean }>;
onLoadMoreWorkspaceSessions?: (workspaceId: string) => Promise<void> | void;
```

**Step 2: Add per-project visible-count state (reset on dataset swap)**

- default visible rows per project = 7
- increase by +20 on project CTA

**Step 3: Add recent visible-count state with fit+3 initialization**

- compute from scroll container size
- on sentinel intersect: reveal local rows first; fetch next page when local rows exhausted and `hasMore=true`
- render fallback `Load more (+20)` button

**Step 4: Add i18n keys**

Add keys in `en.ts`, `cs.ts`, `zh.ts`:

```ts
"sidebar.load_more": "Load more (+20)",
"sidebar.more_ellipsis": "…",
"sidebar.loading_more": "Loading more…",
```

(Localized equivalents for cs/zh.)

**Step 5: Run targeted tests (expect pass)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-interactions.test.ts src/app/components/session/workspace-session-list-recent-layout.test.ts src/app/components/session/workspace-session-list-windowing-layout.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 6: Commit implementation**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-interactions.test.ts packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat: add session list windowing controls for by-project and recent"
```

### Task 9: Full verification, Tauri manual QA, Docker + Chrome MCP, artifacts

**Files:**
- Create: `docs/plans/assets/session-list-windowing/*.png` (or repository screenshot folder used by current PR process)
- Modify: PR description (outside repo file edits) with evidence links

**Step 1: Run full app checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Start Docker dev stack from repo root**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: stack healthy and ready for E2E verification.

**Step 3: Run desktop app (Tauri), not web-only server**

Run:

```bash
pnpm --filter @neatech/veslo dev
```

Expected: desktop app launches and sidebar behavior is manually verifiable.

**Step 4: Execute Chrome MCP E2E flow**

Use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` to validate:

- by-project shows 7 rows per project initially
- project load-more increments by +20
- recent shows fit+3, then infinite scroll
- fallback load-more button works

**Step 5: Capture and store screenshots**

Capture before/after or scenario screenshots into repo path (for example):

```bash
mkdir -p docs/plans/assets/session-list-windowing
```

Store key evidence images and reference them in PR.

**Step 6: Final commit and summary**

```bash
git add docs/plans/assets/session-list-windowing
git commit -m "docs: add session list windowing verification artifacts"
```

(If screenshots are stored outside git by policy, skip commit and include exact local paths in PR notes.)
