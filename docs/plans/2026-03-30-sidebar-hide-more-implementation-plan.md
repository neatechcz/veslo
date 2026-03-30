# Sidebar Hide More Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a reversible sidebar pagination UX so users can both show more sessions and hide expanded rows back to defaults, while updating localized copy (`Načti další`, `Skryj další`).

**Architecture:** Keep all behavior inside the existing `WorkspaceSessionList` view-window layer. Reuse existing paging/windowing signals (`recentVisibleCount`, `projectVisibleByKey`, `workspaceSessionPagingById`) and add a small set of derived booleans plus reset handlers for hide actions. Do not change server-side pagination contracts or app-level sidebar fetch orchestration.

**Tech Stack:** SolidJS, TypeScript, Node test runner (`node --test` via `tsx/esm`), pnpm, Tauri desktop runtime, Docker dev stack, Chrome MCP

---

## Prerequisites

- Use `@superpowers:test-driven-development` while executing this plan.
- Follow `AGENTS.md` new-feature workflow (sync repos/submodules, worktree, Docker + Chrome MCP verification, screenshots).
- Never run Next.js web app (`packages/web`). Use desktop/Tauri workflow and Docker dev stack where required.

### Task 1: Sync repo + create isolated worktree

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync remotes and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: repository and submodules are synced with remotes.

**Step 2: Create worktree for this feature**

Run:

```bash
git worktree add .worktrees/codex/sidebar-hide-more -b codex/sidebar-hide-more origin/main
cd .worktrees/codex/sidebar-hide-more
```

Expected: clean worktree on branch `codex/sidebar-hide-more`.

**Step 3: Baseline checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-windowing.test.ts \
  src/app/components/session/workspace-session-list-windowing-layout.test.ts
```

Expected: PASS baseline before feature edits.

### Task 2: Add failing UI contract tests for hide-more controls

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts`

**Step 1: Add assertions for hide-more localization key usage**

Add new expectations that `WorkspaceSessionList` references:

```ts
assert.match(source, /tr\("sidebar\.hide_more"\)/);
```

for both recent and by-project control sections.

**Step 2: Add assertions for dual-control visibility logic**

Add expectations for explicit dual control render conditions:

```ts
assert.match(source, /recentCanLoadMore\(\)/);
assert.match(source, /recentCanHideMore\(\)/);
assert.match(source, /projectCanLoadMore\(\)/);
assert.match(source, /projectCanHideMore\(\)/);
```

**Step 3: Run targeted test (expect FAIL)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-windowing-layout.test.ts
```

Expected: FAIL because `sidebar.hide_more` and hide-more conditions are not implemented yet.

**Step 4: Commit failing test**

```bash
git add packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts
git commit -m "test: define sidebar hide-more control contracts"
```

### Task 3: Implement hide-more behavior in WorkspaceSessionList

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Test: `packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts`

**Step 1: Add recent-mode derived state + reset handler**

Add memos/handlers near existing recent window logic:

```ts
const recentDefaultVisibleCount = () =>
  computeInitialRecentVisibleCount(scrollContainerRef?.clientHeight ?? 0, RECENT_ESTIMATED_ROW_HEIGHT);

const recentCanHideMore = createMemo(() => recentVisibleCount() > recentDefaultVisibleCount());

const hideRecentRows = () => {
  const nextDefault = recentDefaultVisibleCount();
  setRecentVisibleCount(Math.min(recentRows().length, nextDefault));
};
```

**Step 2: Add by-project derived state + reset handler**

In project section, derive hide predicate and handler:

```ts
const canHideProjectRows = () => visibleCount() > PROJECT_VISIBLE_DEFAULT;

const hideProjectRows = () => {
  setProjectVisibleByKey((current) => ({
    ...current,
    [project.key]: PROJECT_VISIBLE_DEFAULT,
  }));
};
```

**Step 3: Render hide-more controls alongside load-more controls**

Update both control blocks so they can render together:

```tsx
<Show when={recentCanLoadMore()}>
  <button ...>{tr("sidebar.load_more")}</button>
</Show>
<Show when={recentCanHideMore()}>
  <button ...>{tr("sidebar.hide_more")}</button>
</Show>
```

and analogous block under each project.

Disabled rules:
- `recent`: disable both buttons when `recentLoadingMore()`.
- `project`: disable both buttons when `projectPaging().loadingMore`.

**Step 4: Run targeted tests (expect PASS)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-windowing-layout.test.ts \
  src/app/components/session/workspace-session-list-windowing.test.ts
```

Expected: PASS.

**Step 5: Commit implementation**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx \
        packages/app/src/app/components/session/workspace-session-list-windowing-layout.test.ts
git commit -m "feat: add sidebar hide-more controls for session lists"
```

### Task 4: Add failing localization contract tests

**Files:**
- Create: `packages/app/src/i18n/locales/sidebar-session-controls-localization.test.ts`
- Test: `packages/app/src/i18n/locales/sidebar-session-controls-localization.test.ts`

**Step 1: Add assertions for updated and new locale keys**

Create file with static assertions:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cs = readFileSync(new URL("./cs.ts", import.meta.url), "utf8");
const en = readFileSync(new URL("./en.ts", import.meta.url), "utf8");
const zh = readFileSync(new URL("./zh.ts", import.meta.url), "utf8");

test("czech load-more copy uses imperative form", () => {
  assert.match(cs, /"sidebar\.load_more": "Načti další"/);
});

test("hide-more key exists across locales", () => {
  assert.match(cs, /"sidebar\.hide_more": "Skryj další"/);
  assert.match(en, /"sidebar\.hide_more": "Hide more"/);
  assert.match(zh, /"sidebar\.hide_more": "收起更多"/);
});
```

**Step 2: Run targeted test (expect FAIL)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/i18n/locales/sidebar-session-controls-localization.test.ts
```

Expected: FAIL until locale files are updated.

**Step 3: Commit failing test**

```bash
git add packages/app/src/i18n/locales/sidebar-session-controls-localization.test.ts
git commit -m "test: specify sidebar session control locale copy"
```

### Task 5: Implement locale updates and verify parity

**Files:**
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/i18n/locales/sidebar-session-controls-localization.test.ts`

**Step 1: Update locale strings**

Apply:

```ts
// cs.ts
"sidebar.load_more": "Načti další",
"sidebar.hide_more": "Skryj další",

// en.ts
"sidebar.hide_more": "Hide more",

// zh.ts
"sidebar.hide_more": "收起更多",
```

Leave existing `sidebar.loading_more` unchanged.

**Step 2: Run localization tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/i18n/locales/sidebar-session-controls-localization.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 3: Commit locale implementation**

```bash
git add packages/app/src/i18n/locales/cs.ts \
        packages/app/src/i18n/locales/en.ts \
        packages/app/src/i18n/locales/zh.ts \
        packages/app/src/i18n/locales/sidebar-session-controls-localization.test.ts
git commit -m "feat: localize sidebar hide-more controls"
```

### Task 6: Run regression suite for sidebar session flows

**Files:**
- Modify: none (verification only)

**Step 1: Run targeted regression tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-windowing.test.ts \
  src/app/components/session/workspace-session-list-windowing-layout.test.ts \
  src/app/pages/sidebar-directory-session-wiring.test.ts \
  src/i18n/locales/sidebar-session-controls-localization.test.ts
```

Expected: PASS.

**Step 2: Run sidebar behavior script guard**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:sidebar-flat
```

Expected: PASS (no regression in grouped session listing behavior).

### Task 7: E2E gate with Docker stack + Chrome MCP + screenshots

**Files:**
- Create: `packages/app/pr/screenshots/sidebar-load-more-hide-more-dual-controls.png`
- Create: `packages/app/pr/screenshots/sidebar-load-more-hide-more-reset.png`

**Step 1: Start Docker dev stack**

Run from repo root:

```bash
packaging/docker/dev-up.sh
```

Expected: printed Web UI URL, server URL, token file path, and exact `docker compose -p ... down` stop command.

**Step 2: Validate flow via Chrome MCP**

Use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`:
1. Open printed Web UI URL.
2. Go to session surface.
3. Expand sessions with `Načti další`.
4. Confirm `Skryj další` appears.
5. If more sessions are still available, confirm both controls are visible together.
6. Click `Skryj další` and verify list collapses to defaults.

**Step 3: Capture screenshots**

Store screenshots:
- `packages/app/pr/screenshots/sidebar-load-more-hide-more-dual-controls.png`
- `packages/app/pr/screenshots/sidebar-load-more-hide-more-reset.png`

**Step 4: Stop stack**

Run exact stop command printed by `dev-up.sh`:

```bash
docker compose -p <project-from-output> -f packaging/docker/docker-compose.dev.yml down
```

Expected: containers removed cleanly.

### Task 8: Final hygiene and handoff

**Files:**
- Modify: optional PR notes/changelog docs if repo convention requires

**Step 1: Final status + commit list**

Run:

```bash
git status --short
git log --oneline --max-count=8
```

Expected: clean tree and clear commit stack for review.

**Step 2: Prepare reviewer notes**

Include:
- Commands run + results.
- E2E evidence (Chrome MCP screenshots).
- Any skipped gates with exact reproduction commands.
