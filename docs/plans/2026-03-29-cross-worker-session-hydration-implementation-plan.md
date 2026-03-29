# Cross-Worker Session Hydration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make cross-worker session switching open instantly, render cached or prefetched chat text in the session view, move worker attach plus truth loading into the background, and retry automatically on failure without blocking the rest of the app.

**Architecture:** Split the feature into four layers: immediate navigation semantics, bounded text-only session snapshot caching, inline hydration UI with ready/send gating, and sidebar-driven prefetch plus retry orchestration. Keep pure policy in small helpers with unit tests, wire those helpers into `app.tsx`, `session.tsx`, `workspace-session-list.tsx`, `context/session.ts`, and `context/workspace.ts`, and preserve the existing server truth flow by reusing `activateWorkspace(...)`, `connectToServer(...)`, and `selectSession(...)` behind a new non-blocking orchestration layer.

**Tech Stack:** SolidJS, TypeScript, Solid store, localStorage-backed prefs/snapshot cache helper, Tauri desktop app, Node test runner via `tsx/esm`, pnpm, Docker dev stack, Chrome MCP

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Use `.opencode/skills/solidjs-patterns/SKILL.md` before changing Solid UI state patterns.
- Implement in a dedicated worktree. The current workspace already has unrelated dirty changes.
- Do not run `packages/web`; manual verification must use the Tauri desktop app.
- For the end-to-end gate, start the Veslo dev stack with `packaging/docker/dev-up.sh` and use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`.

### Task 1: Create a clean worktree and verify the baseline

**Files:**
- Modify: none

**Step 1: Sync repository state**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: both commands complete without errors.

**Step 2: Create and enter a dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/cross-worker-session-hydration -b codex/cross-worker-session-hydration origin/main
cd .worktrees/codex/cross-worker-session-hydration
```

Expected: the new worktree is created on branch `codex/cross-worker-session-hydration`.

**Step 3: Verify the targeted baseline**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/pages/session-navigation.test.ts \
  src/app/components/session/workspace-session-list-layout.test.ts \
  src/app/pages/dashboard-menu-navigation.test.ts
```

Expected: PASS before feature edits.

**Step 4: Commit the clean baseline checkpoint**

Run:

```bash
git status --short
```

Expected: no feature changes yet in the new worktree.

### Task 2: Add failing tests for immediate cross-worker session opening

**Files:**
- Modify: `packages/app/src/app/pages/session-navigation.test.ts`
- Modify: `packages/app/src/app/pages/session-navigation.ts`
- Test: `packages/app/src/app/pages/session-navigation.test.ts`

**Step 1: Add failing tests that codify the new open-first semantics**

Extend `session-navigation.test.ts` with scenarios like:

```ts
test("opens the target session immediately before workspace activation resolves", async () => {
  const opened: string[] = [];
  let resolveActivation!: () => void;
  const activation = new Promise<boolean>((resolve) => {
    resolveActivation = () => resolve(true);
  });

  const promise = openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-a",
    workspaceId: "ws-b",
    sessionId: "sess-2",
    activateWorkspace: () => activation,
    openSession: (id) => opened.push(id),
  });

  assert.deepEqual(opened, ["sess-2"]);
  resolveActivation();
  assert.equal(await promise, "opened");
});
```

Add at least:

- immediate open before activation settles
- same-workspace open still opens once and does not activate
- rapid A -> B clicks still leave only the newest activation path alive
- activation failure returns `"blocked"` but does not delay the initial open callback

**Step 2: Run the targeted test to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-navigation.test.ts
```

Expected: FAIL because `openSessionWithWorkspaceActivation(...)` still waits for activation before opening.

**Step 3: Implement the minimal helper change**

In `session-navigation.ts`, change the order so the session opens first and the promise tracks only background activation completion:

```ts
const run = async () => {
  if (token !== openSessionNavigationToken) return "superseded";
  input.openSession(sessionId);

  if (workspaceId !== getActiveWorkspaceId()) {
    const activated = await Promise.resolve(input.activateWorkspace(workspaceId));
    if (!activated) return "blocked";
  }

  if (token !== openSessionNavigationToken) return "superseded";
  return "opened";
};
```

Do not add app-specific hydration state here yet; keep this helper focused on navigation ordering and single-flight semantics.

**Step 4: Re-run the targeted test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-navigation.test.ts
```

Expected: PASS.

**Step 5: Commit the helper change**

```bash
git add packages/app/src/app/pages/session-navigation.ts packages/app/src/app/pages/session-navigation.test.ts
git commit -m "feat: open cross-worker sessions before activation completes"
```

### Task 3: Add failing tests for a bounded text snapshot cache

**Files:**
- Create: `packages/app/src/app/lib/session-snapshot-cache.ts`
- Create: `packages/app/src/app/lib/session-snapshot-cache.test.ts`
- Test: `packages/app/src/app/lib/session-snapshot-cache.test.ts`

**Step 1: Write failing tests for snapshot normalization and storage**

Create `session-snapshot-cache.test.ts` with a storage-double API similar to existing prefs helpers. Cover:

- writing and reading a snapshot by session ID
- keeping only text/timeline-safe message payloads
- trimming snapshots to a bounded recent window
- evicting old snapshots when the global cap is exceeded
- ignoring malformed storage payloads

Example shape:

```ts
const snapshot = {
  sessionId: "sess-1",
  workspaceId: "ws-1",
  updatedAt: 123,
  messages: [{ info: { id: "m1", sessionID: "sess-1" }, parts: [{ id: "p1", type: "text", text: "hello" }] }],
};

writeSessionSnapshot(snapshot, storage);
assert.deepEqual(readSessionSnapshot("sess-1", storage)?.messages.length, 1);
```

**Step 2: Run the new test to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-snapshot-cache.test.ts
```

Expected: FAIL because the cache module does not exist yet.

**Step 3: Implement the cache helper**

Create `session-snapshot-cache.ts` with:

- a serializable `SessionSnapshot` type
- `readSessionSnapshot(sessionId, storage?)`
- `writeSessionSnapshot(snapshot, storage?)`
- `pruneSessionSnapshots(storage?)`
- small bounded constants, for example:

```ts
export const SESSION_SNAPSHOT_MAX_MESSAGES = 80;
export const SESSION_SNAPSHOT_MAX_SESSIONS = 40;
```

Keep this helper storage-only. No Solid signals, no fetch logic, no worker attach logic.

**Step 4: Re-run the snapshot cache test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-snapshot-cache.test.ts
```

Expected: PASS.

**Step 5: Commit the snapshot cache helper**

```bash
git add packages/app/src/app/lib/session-snapshot-cache.ts packages/app/src/app/lib/session-snapshot-cache.test.ts
git commit -m "feat: add bounded session snapshot cache helper"
```

### Task 4: Persist visited-session snapshots from the session store

**Files:**
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/lib/session-snapshot-cache.test.ts`
- Test: `packages/app/src/app/context/select-session-guard.test.ts` (only if guard assertions need updating)

**Step 1: Add failing coverage for snapshot writes on successful session loads**

Extend `session-snapshot-cache.test.ts` or add a new focused test file if needed to cover the normalization boundary that `context/session.ts` must satisfy:

- only selected-session chat data is persisted
- snapshots update after successful `session.messages(...)`
- stale or failed loads do not overwrite newer snapshots

If the integration is easier to test indirectly, add a small pure helper in `context/session.ts` first and test that helper in isolation.

**Step 2: Run the targeted test and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-snapshot-cache.test.ts
```

Expected: FAIL because the session store does not yet write snapshots after successful loads.

**Step 3: Wire snapshot writes into successful message loads**

In `context/session.ts`, after `setMessagesForSession(sessionID, msgs)` succeeds and before returning, normalize and persist a snapshot:

```ts
writeSessionSnapshot({
  sessionId: sessionID,
  workspaceId: options.activeWorkspaceRoot(),
  updatedAt: Date.now(),
  messages: buildSerializableSnapshot(msgs),
});
```

In `app.tsx`, read the latest snapshot for the selected session so the UI can render it before truth loads complete.

**Step 4: Re-run the targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/session-snapshot-cache.test.ts \
  src/app/context/select-session-guard.test.ts
```

Expected: PASS.

**Step 5: Commit the snapshot persistence wiring**

```bash
git add packages/app/src/app/context/session.ts packages/app/src/app/app.tsx packages/app/src/app/lib/session-snapshot-cache.test.ts
git commit -m "feat: persist visited session text snapshots"
```

### Task 5: Add failing tests for inline hydration UI and overlay removal

**Files:**
- Create: `packages/app/src/app/lib/session-hydration-ui.ts`
- Create: `packages/app/src/app/lib/session-hydration-ui.test.ts`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/components/session/message-list.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/lib/session-hydration-ui.test.ts`

**Step 1: Write failing tests for the hydration UI state model**

Create `session-hydration-ui.test.ts` for a small pure helper that maps app state to UI mode:

- `hot` snapshot + pending hydration -> footer status
- `warm` snapshot + pending hydration -> footer status
- `cold` no snapshot + pending hydration -> inline placeholder
- `retrying` -> retry message
- `ready` -> no hydration chrome

Example:

```ts
assert.deepEqual(
  buildSessionHydrationUi({
    phase: "hydrating",
    hasSnapshot: false,
    retrying: false,
  }),
  { mode: "cold-placeholder", footerLabel: "Loading conversation from worker..." },
);
```

**Step 2: Run the test to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-hydration-ui.test.ts
```

Expected: FAIL because the helper does not exist yet.

**Step 3: Implement the UI state helper and wire it into SessionView**

Create `session-hydration-ui.ts` and then:

- remove the app-level `pendingSessionLoad` fullscreen overlay from `app.tsx`
- pass hydration state into `session.tsx`
- render cold placeholder inline in the message area
- use `MessageList.footer` for the subtle `Loading latest state...` / `Retrying...` status row

Use the existing `footer` prop in `message-list.tsx` instead of adding a second global overlay.

**Step 4: Re-run the targeted test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-hydration-ui.test.ts
```

Expected: PASS.

**Step 5: Commit the inline hydration UI**

```bash
git add packages/app/src/app/lib/session-hydration-ui.ts packages/app/src/app/lib/session-hydration-ui.test.ts packages/app/src/app/pages/session.tsx packages/app/src/app/components/session/message-list.tsx packages/app/src/app/app.tsx
git commit -m "feat: move cross-worker hydration state into the message view"
```

### Task 6: Add failing tests for send gating and selected-session readiness

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Create: `packages/app/src/app/lib/session-ready-state.ts`
- Create: `packages/app/src/app/lib/session-ready-state.test.ts`
- Test: `packages/app/src/app/lib/session-ready-state.test.ts`

**Step 1: Write failing tests for the ready-state contract**

Create `session-ready-state.test.ts` and cover:

- session is not ready while worker attach is pending
- session is not ready while truth load is pending
- session becomes ready only after both complete
- send remains blocked during retry

Example:

```ts
assert.equal(
  isSessionReady({ attach: "connected", truth: "loaded" }),
  true,
);
assert.equal(
  isSessionReady({ attach: "retrying", truth: "stale" }),
  false,
);
```

**Step 2: Run the test to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-ready-state.test.ts
```

Expected: FAIL because the ready-state helper does not exist yet.

**Step 3: Implement the helper and wire the composer disable logic**

Create `session-ready-state.ts` and update `session.tsx` / `app.tsx` so:

- composer stays visible
- draft updates still flow
- send button disable state is driven by explicit readiness, not by the old fullscreen loading flow
- the disable reason is visible to the user

**Step 4: Re-run the targeted test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-ready-state.test.ts
```

Expected: PASS.

**Step 5: Commit the ready/send gating**

```bash
git add packages/app/src/app/lib/session-ready-state.ts packages/app/src/app/lib/session-ready-state.test.ts packages/app/src/app/pages/session.tsx packages/app/src/app/app.tsx
git commit -m "feat: gate session sending on hydration readiness"
```

### Task 7: Add failing tests for visible expanded worker prefetch policy

**Files:**
- Create: `packages/app/src/app/components/session/workspace-session-prefetch-model.ts`
- Create: `packages/app/src/app/components/session/workspace-session-prefetch-model.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Test: `packages/app/src/app/components/session/workspace-session-prefetch-model.test.ts`

**Step 1: Write failing tests for prefetch candidate derivation**

Create `workspace-session-prefetch-model.test.ts` and cover:

- collapsed project/workspace groups do not emit prefetch candidates
- expanded but off-screen groups do not emit candidates
- visible expanded groups emit workspace IDs once
- result order prefers on-screen order

Example:

```ts
assert.deepEqual(
  collectPrefetchWorkspaceIds({
    projects: [{ key: "ws-1:/repo", workspaceId: "ws-1" }],
    collapsedByKey: { "ws-1:/repo": false },
    visibleProjectKeys: new Set(["ws-1:/repo"]),
  }),
  ["ws-1"],
);
```

**Step 2: Run the test to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-prefetch-model.test.ts
```

Expected: FAIL because the model module does not exist yet.

**Step 3: Implement the model and emit visible expanded workspace IDs from the sidebar**

Create `workspace-session-prefetch-model.ts`, then in `workspace-session-list.tsx`:

- observe by-project workspace groups with `IntersectionObserver`
- keep a `visibleProjectKeys` signal
- combine it with `collapsedProjects()`
- expose a new prop such as `onVisibleExpandedWorkspaceIdsChange`

Keep the policy helper pure; keep DOM observation inside the component.

**Step 4: Re-run the targeted test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-prefetch-model.test.ts
```

Expected: PASS.

**Step 5: Commit the sidebar prefetch model**

```bash
git add packages/app/src/app/components/session/workspace-session-prefetch-model.ts packages/app/src/app/components/session/workspace-session-prefetch-model.test.ts packages/app/src/app/components/session/workspace-session-list.tsx
git commit -m "feat: derive visible expanded workspace prefetch targets"
```

### Task 8: Implement app-level snapshot prefetch for recent sessions

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/context/session.ts`
- Test: `packages/app/src/app/lib/session-snapshot-cache.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-prefetch-model.test.ts`

**Step 1: Add failing tests for prefetch bounds**

Extend the existing snapshot cache or prefetch model tests to cover:

- at most `3-5` recent sessions are prefetched per eligible workspace
- stale or duplicate prefetch requests are deduped
- a user-selected session can supersede lower-priority prefetch work

If needed, add a small pure helper inside `app.tsx` first, for example:

```ts
export const selectPrefetchSessionIds = (sessions: SidebarSessionItem[], limit = 5) =>
  sessions.slice(0, limit).map((session) => session.id);
```

**Step 2: Run the targeted tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/session-snapshot-cache.test.ts \
  src/app/components/session/workspace-session-prefetch-model.test.ts
```

Expected: FAIL because no prefetch scheduler exists yet.

**Step 3: Implement the scheduler in `app.tsx`**

Add app-level state for desired prefetch workspace IDs and a cancellable scheduler that:

- reads sidebar session groups for those workspaces
- selects the most recent `3-5` sessions
- calls `client.session.messages({ sessionID, limit: SNAPSHOT_PREFETCH_MESSAGE_LIMIT })`
- writes successful text snapshots via `writeSessionSnapshot(...)`

Keep prefetch low-priority and fire-and-forget. Do not let it block explicit session opens.

**Step 4: Re-run the targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/session-snapshot-cache.test.ts \
  src/app/components/session/workspace-session-prefetch-model.test.ts
```

Expected: PASS.

**Step 5: Commit the prefetch scheduler**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/context/session.ts packages/app/src/app/lib/session-snapshot-cache.test.ts packages/app/src/app/components/session/workspace-session-prefetch-model.test.ts
git commit -m "feat: prefetch recent session snapshots for visible expanded workers"
```

### Task 9: Add failing tests for automatic retry policy

**Files:**
- Create: `packages/app/src/app/lib/session-hydration-retry.ts`
- Create: `packages/app/src/app/lib/session-hydration-retry.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/context/session.ts`
- Test: `packages/app/src/app/lib/session-hydration-retry.test.ts`

**Step 1: Write failing tests for retry timing and supersede behavior**

Create `session-hydration-retry.test.ts` covering:

- backoff sequence `500ms -> 1000ms -> 2000ms -> 4000ms -> capped`
- transient retry and hard-failure slow retry
- superseded session selection cancels future retry work

Example:

```ts
assert.equal(nextHydrationRetryDelayMs({ attempt: 1, hardFailure: false }), 500);
assert.equal(nextHydrationRetryDelayMs({ attempt: 5, hardFailure: false }), 8000);
assert.equal(nextHydrationRetryDelayMs({ attempt: 3, hardFailure: true }), 4000);
```

**Step 2: Run the test to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-hydration-retry.test.ts
```

Expected: FAIL because the retry helper does not exist yet.

**Step 3: Implement the helper and wire automatic recovery**

Create `session-hydration-retry.ts`, then use it from `app.tsx` / `workspace.ts` / `context/session.ts` to:

- retry attach failures automatically
- retry selected-session truth loading automatically
- keep the inline UI updated with `Retrying...`
- stop stale retry chains when the user opens another session

Keep retry orchestration keyed by the selected session + active hydration run token.

**Step 4: Re-run the targeted test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-hydration-retry.test.ts
```

Expected: PASS.

**Step 5: Commit the retry orchestration**

```bash
git add packages/app/src/app/lib/session-hydration-retry.ts packages/app/src/app/lib/session-hydration-retry.test.ts packages/app/src/app/context/workspace.ts packages/app/src/app/context/session.ts
git commit -m "feat: retry cross-worker hydration automatically"
```

### Task 10: Run the full verification gate and capture evidence

**Files:**
- Create: `packages/app/pr/screenshots/cross-worker-session-hydration/01-hot-snapshot.png`
- Create: `packages/app/pr/screenshots/cross-worker-session-hydration/02-cold-inline-loading.png`
- Create: `packages/app/pr/screenshots/cross-worker-session-hydration/03-retrying-state.png`
- Modify: `packages/app/pr/cross-worker-session-hydration.md` (optional short verification note)

**Step 1: Run targeted tests and typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/pages/session-navigation.test.ts \
  src/app/lib/session-snapshot-cache.test.ts \
  src/app/lib/session-hydration-ui.test.ts \
  src/app/lib/session-ready-state.test.ts \
  src/app/lib/session-hydration-retry.test.ts \
  src/app/components/session/workspace-session-prefetch-model.test.ts
```

Expected: PASS.

**Step 2: Start the Veslo dev stack**

Run from the repo root:

```bash
packaging/docker/dev-up.sh
```

Expected: Docker services start successfully.

**Step 3: Run the desktop app and verify with Chrome MCP**

Run:

```bash
pnpm --filter @neatech/veslo-desktop tauri dev
```

Then use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` to verify:

- hot cached cross-worker open
- cold cross-worker open with inline message-box loading
- automatic retry state after a forced attach/hydrate failure
- send disabled until ready
- free switching away while hydration continues in the background

**Step 4: Capture screenshots**

Save screenshots to:

- `packages/app/pr/screenshots/cross-worker-session-hydration/01-hot-snapshot.png`
- `packages/app/pr/screenshots/cross-worker-session-hydration/02-cold-inline-loading.png`
- `packages/app/pr/screenshots/cross-worker-session-hydration/03-retrying-state.png`

Optionally add a short PR note in:

- `packages/app/pr/cross-worker-session-hydration.md`

**Step 5: Commit the verification evidence**

```bash
git add packages/app/pr/screenshots/cross-worker-session-hydration packages/app/pr/cross-worker-session-hydration.md
git commit -m "docs: add cross-worker session hydration verification evidence"
```

Plan complete and saved to `docs/plans/2026-03-29-cross-worker-session-hydration-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
