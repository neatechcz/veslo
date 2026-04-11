# Cross-Workspace Sidebar Session Prefetch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make transcript prefetch warm every session that is already loaded and directly clickable in the left sidebar across all workspaces, while excluding `Load more` rows and collapsed subagents.

**Architecture:** Replace the viewport-visible prefetch contract with a per-workspace loaded-interest payload containing clicked, selected, loaded top-level, and expanded subagent session IDs. Keep expensive transcript warming on the Veslo server, rebuild a deterministic queue per workspace, and drain the full loaded set in the background without affecting foreground session navigation.

**Tech Stack:** SolidJS, Solid stores, Veslo desktop app, Veslo server (`packages/server`), `node:test`, Bun tests, Tauri 2, WebdriverIO.

---

## Execution Preflight

Run implementation from a dedicated worktree and stay off the default checkout while changing code.

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
git fetch --all --prune
git worktree add ../Veslo-cross-workspace-sidebar-prefetch -b codex/cross-workspace-sidebar-prefetch HEAD
cd ../Veslo-cross-workspace-sidebar-prefetch
git status --short
```

Expected:

- `git status --short` prints nothing
- the branch name is `codex/cross-workspace-sidebar-prefetch`

Use `@using-git-worktrees` if you want a stricter setup checklist before touching code.

### Task 1: Define The Loaded-Interest Model In The App

**Files:**
- Create: `packages/app/src/app/components/session/workspace-session-list-prefetch-interest.ts`
- Create: `packages/app/src/app/components/session/workspace-session-list-prefetch-interest.test.ts`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { deriveLoadedSidebarPrefetchInterest } from "./workspace-session-list-prefetch-interest.js";

test("recent mode groups loaded rows by workspace across the whole sidebar", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: "ws-b-selected",
    clickedSessionId: null,
    loadedTopLevelRows: [
      { workspaceId: "ws-a", sessionId: "ws-a-1", updatedAt: 30 },
      { workspaceId: "ws-b", sessionId: "ws-b-selected", updatedAt: 25 },
      { workspaceId: "ws-a", sessionId: "ws-a-2", updatedAt: 20 },
    ],
    expandedSubagentRows: [],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["ws-a-1", "ws-a-2"],
    expandedSubagentSessionIds: [],
  });
  assert.deepEqual(result.get("ws-b"), {
    clickedSessionId: null,
    selectedSessionId: "ws-b-selected",
    loadedTopLevelSessionIds: ["ws-b-selected"],
    expandedSubagentSessionIds: [],
  });
});

test("expanded subagents are included newest-first and deduplicated per workspace", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: null,
    clickedSessionId: "child-newer",
    loadedTopLevelRows: [{ workspaceId: "ws-a", sessionId: "parent", updatedAt: 80 }],
    expandedSubagentRows: [
      { workspaceId: "ws-a", sessionId: "child-older", updatedAt: 10 },
      { workspaceId: "ws-a", sessionId: "child-newer", updatedAt: 40 },
      { workspaceId: "ws-a", sessionId: "child-newer", updatedAt: 40 },
    ],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: "child-newer",
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["parent"],
    expandedSubagentSessionIds: ["child-newer", "child-older"],
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch/packages/app
pnpm exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch-interest.test.ts
```

Expected: FAIL because the helper and the new type do not exist yet.

**Step 3: Write the minimal implementation**

```ts
export type LoadedSidebarPrefetchInterest = {
  clickedSessionId: string | null;
  selectedSessionId: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
};

export function deriveLoadedSidebarPrefetchInterest(input: {
  selectedSessionId: string | null;
  clickedSessionId: string | null;
  loadedTopLevelRows: Array<{ workspaceId: string; sessionId: string; updatedAt: number }>;
  expandedSubagentRows: Array<{ workspaceId: string; sessionId: string; updatedAt: number }>;
}) {
  // Group rows by workspace, preserve loaded top-level order,
  // sort expanded subagents newest->oldest, and apply selected/clicked
  // only within the workspace that contains that session.
}
```

Add the exported callback/value types to `packages/app/src/app/types.ts`:

```ts
export type LoadedSidebarPrefetchInterest = {
  clickedSessionId: string | null;
  selectedSessionId: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
};

export type LoadedSessionPrefetchInterestChangeHandler = (
  workspaceId: string,
  interest: LoadedSidebarPrefetchInterest,
) => void;
```

**Step 4: Run the test to verify it passes**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch/packages/app
pnpm exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch-interest.test.ts
```

Expected: PASS for cross-workspace grouping, subagent ordering, and dedupe.

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
git add packages/app/src/app/components/session/workspace-session-list-prefetch-interest.ts packages/app/src/app/components/session/workspace-session-list-prefetch-interest.test.ts packages/app/src/app/types.ts
git commit -m "feat(app): derive loaded sidebar prefetch interest"
```

### Task 2: Wire The Sidebar And Pages To Report Loaded Interest

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-prefetch.test.ts`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/types.ts`
- Delete: `packages/app/src/app/components/session/workspace-session-list-prefetch.ts`

**Step 1: Write the failing test**

Extend `packages/app/src/app/components/session/workspace-session-list-prefetch.test.ts` so it asserts the new callback contract and the removal of active-workspace-only gating:

```ts
assert.match(
  listSource,
  /onLoadedSessionPrefetchInterestChange\?:\s*(LoadedSessionPrefetchInterestChangeHandler|\(workspaceId: string, interest: LoadedSidebarPrefetchInterest\) => void);/,
);
assert.match(listSource, /loadedTopLevelSessionIds/);
assert.match(listSource, /expandedSubagentSessionIds/);
assert.match(sessionPageSource, /prefetchSessionTranscripts\(serverWorkspaceId,\s*\{/);
assert.match(sessionPageSource, /loadedTopLevelSessionIds/);
assert.match(dashboardPageSource, /loadedTopLevelSessionIds/);
assert.doesNotMatch(sessionPageSource, /workspaceId === props\.activeWorkspaceId/);
assert.doesNotMatch(dashboardPageSource, /workspaceId === props\.activeWorkspaceId/);
assert.doesNotMatch(listSource, /deriveVisibleSessionPrefetchIds\(/);
```

**Step 2: Run the test to verify it fails**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch/packages/app
pnpm exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch.test.ts
```

Expected: FAIL because the list and pages still use `visibleSessionIds` and the active-workspace hint.

**Step 3: Write the minimal implementation**

In `workspace-session-list.tsx`:

- replace `onVisibleSessionIdsChange` with `onLoadedSessionPrefetchInterestChange`
- derive loaded top-level rows from `recentRowsVisible()` or `visibleProjectRows()`
- derive expanded subagent rows only from rows currently exposed by expansion state
- track the latest clicked session ID and include it in the next payload
- keep reporting and clearing state per workspace

Representative shape:

```ts
const reportLoadedInterest = () => {
  const interestByWorkspace = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: props.selectedSessionId?.trim() || null,
    clickedSessionId: lastClickedSessionId(),
    loadedTopLevelRows,
    expandedSubagentRows,
  });

  for (const [workspaceId, interest] of interestByWorkspace) {
    props.onLoadedSessionPrefetchInterestChange?.(workspaceId, interest);
  }
};
```

In `session.tsx` and `dashboard.tsx`:

- rename the callback implementation
- stop deriving a selected-session hint from the active workspace
- forward the full `interest` object directly to `client.prefetchSessionTranscripts(...)`

**Step 4: Run the tests to verify they pass**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch/packages/app
pnpm exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch-interest.test.ts
pnpm exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch.test.ts
```

Expected: PASS, including proof that the old viewport helper is gone and active-workspace-only gating was removed.

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-prefetch.test.ts packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/types.ts
git rm packages/app/src/app/components/session/workspace-session-list-prefetch.ts
git commit -m "feat(app): report loaded sidebar prefetch interest"
```

### Task 3: Extend The Client And Server Route Payloads

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/veslo-server-session-prefetch.test.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/server-session-transcript-prefetch.test.ts`

**Step 1: Write the failing tests**

Update the client-side test in `packages/app/src/app/lib/veslo-server-session-prefetch.test.ts`:

```ts
assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
  clickedSessionId: "sess-clicked",
  selectedSessionId: "sess-selected",
  loadedTopLevelSessionIds: ["sess-a", "sess-b"],
  expandedSubagentSessionIds: ["sub-2", "sub-1"],
  limit: 12,
});
```

Update the route test in `packages/server/src/server-session-transcript-prefetch.test.ts`:

```ts
body: JSON.stringify({
  clickedSessionId: "sess-clicked",
  selectedSessionId: "sess-selected",
  loadedTopLevelSessionIds: ["sess-a", "sess-b"],
  expandedSubagentSessionIds: ["sub-2", "sub-1"],
  limit: 12,
}),
```

Also add a route failure assertion for invalid array entries:

```ts
body: JSON.stringify({
  loadedTopLevelSessionIds: ["sess-a", 123, null],
  expandedSubagentSessionIds: [],
  limit: 12,
}),
```

**Step 2: Run the tests to verify they fail**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
pnpm --filter @neatech/veslo-ui exec node --test src/app/lib/veslo-server-session-prefetch.test.ts
pnpm --filter veslo-server exec bun test src/server-session-transcript-prefetch.test.ts
```

Expected: FAIL because the client and route still expect `visibleSessionIds`.

**Step 3: Write the minimal implementation**

In `packages/app/src/app/lib/veslo-server.ts` replace the input type:

```ts
export type VesloSessionTranscriptPrefetchInput = {
  clickedSessionId?: string | null;
  selectedSessionId?: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
  limit?: number;
};
```

In `packages/server/src/server.ts` replace the single `parseVisibleSessionIds(...)` helper with generic array/string helpers:

```ts
function parseSessionIdArray(input: unknown, field: string): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", `${field} must be an array`);
  }
  return input.map((value) => {
    if (typeof value !== "string") {
      throw new ApiError(400, "invalid_payload", `${field} entries must be strings`);
    }
    return value.trim();
  }).filter(Boolean);
}
```

Then pass the richer payload into `sessionTranscriptPrefetch.updateInterest(...)`.

**Step 4: Run the tests to verify they pass**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
pnpm --filter @neatech/veslo-ui exec node --test src/app/lib/veslo-server-session-prefetch.test.ts
pnpm --filter veslo-server exec bun test src/server-session-transcript-prefetch.test.ts
```

Expected: PASS for request body shape, route parsing, and 400 responses on invalid arrays.

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server-session-prefetch.test.ts packages/server/src/server.ts packages/server/src/server-session-transcript-prefetch.test.ts
git commit -m "feat(server): accept loaded sidebar prefetch payloads"
```

### Task 4: Rework Server Queue Semantics To Cover The Full Loaded Set

**Files:**
- Modify: `packages/server/src/session-transcript-prefetch.ts`
- Modify: `packages/server/src/session-transcript-prefetch.test.ts`

**Step 1: Write the failing tests**

Add a queue-order test:

```ts
const result = await store.updateInterest({
  workspaceId: "ws_local",
  clickedSessionId: "sess-clicked",
  selectedSessionId: "sess-selected",
  expandedSubagentSessionIds: ["sub-newer", "sub-older"],
  loadedTopLevelSessionIds: ["top-a", "top-b", "top-a"],
  limit: 140,
});

expect(store.debugQueue("ws_local")).toEqual([
  "sess-clicked",
  "sess-selected",
  "sub-newer",
  "sub-older",
  "top-a",
  "top-b",
]);
expect(result.queuedSessionIds).toEqual([
  "sess-clicked",
  "sess-selected",
  "sub-newer",
  "sub-older",
  "top-a",
  "top-b",
]);
```

Add a full-drain test:

```ts
const calls: string[] = [];
const store = createSessionTranscriptPrefetchStore({
  loadTranscript: async ({ workspaceId, sessionId }) => {
    calls.push(`${workspaceId}:${sessionId}`);
    return { workspaceId, sessionId, messages: [], partsByMessageId: {} };
  },
});

await store.updateInterest({
  workspaceId: "ws_local",
  clickedSessionId: null,
  selectedSessionId: null,
  expandedSubagentSessionIds: [],
  loadedTopLevelSessionIds: ["sess-a", "sess-b", "sess-c", "sess-d"],
  limit: 140,
});

await store.prefetchWorkspace("ws_local");
expect(calls).toEqual(["ws_local:sess-a", "ws_local:sess-b", "ws_local:sess-c", "ws_local:sess-d"]);
```

Add a failure-isolation test:

```ts
const calls: string[] = [];
const store = createSessionTranscriptPrefetchStore({
  loadTranscript: async ({ workspaceId, sessionId }) => {
    calls.push(sessionId);
    if (sessionId === "sess-b") throw new Error("boom");
    return { workspaceId, sessionId, messages: [], partsByMessageId: {} };
  },
});

await store.updateInterest({
  workspaceId: "ws_local",
  clickedSessionId: null,
  selectedSessionId: null,
  expandedSubagentSessionIds: [],
  loadedTopLevelSessionIds: ["sess-a", "sess-b", "sess-c"],
  limit: 140,
});

await store.prefetchWorkspace("ws_local");
expect(calls).toEqual(["sess-a", "sess-b", "sess-c"]);
expect(store.debugQueue("ws_local")).toEqual([]);
```

**Step 2: Run the tests to verify they fail**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch/packages/server
pnpm exec bun test src/session-transcript-prefetch.test.ts
```

Expected: FAIL because the store still only knows `visibleSessionIds`, stops after a short prefix, and stops on the first failure.

**Step 3: Write the minimal implementation**

In `packages/server/src/session-transcript-prefetch.ts`:

- replace `visibleSessionIds` with the richer interest type
- rebuild `normalizeInterestQueue(...)` from four priority buckets
- keep one queue per workspace
- drain until the queue is empty instead of stopping after a short prefix
- on failure, remove the failed session from the queue and continue

Representative structure:

```ts
const normalizeInterestQueue = (input: SessionTranscriptPrefetchInterest) => {
  const ordered = new Set<string>();
  for (const value of [
    input.clickedSessionId,
    input.selectedSessionId,
    ...input.expandedSubagentSessionIds,
    ...input.loadedTopLevelSessionIds,
  ]) {
    const normalized = normalizeId(value);
    if (normalized) ordered.add(normalized);
  }
  return Array.from(ordered);
};
```

Change the pump loop to:

```ts
while (true) {
  const queue = queueByWorkspace.get(workspaceId) ?? [];
  if (queue.length === 0) break;
  const sessionId = normalizeId(queue[0]);
  try {
    await ensureLoaded({ workspaceId, sessionId, limit: resolveDesiredLimit(workspaceId, sessionId) });
  } catch {
    queue.shift();
    queueByWorkspace.set(workspaceId, queue);
    continue;
  }
}
```

**Step 4: Run the tests and rebuild the binary**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts src/server-session-transcript-prefetch.test.ts
pnpm --filter veslo-server build:bin
```

Expected:

- Bun tests PASS for queue ordering, full-drain behavior, and failure isolation
- `build:bin` completes successfully so the compiled server matches `packages/server/src`

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
git add packages/server/src/session-transcript-prefetch.ts packages/server/src/session-transcript-prefetch.test.ts
git commit -m "feat(server): drain loaded sidebar prefetch queues"
```

### Task 5: Verify The Desktop Flow And Capture Evidence

**Files:**
- Create: `packages/e2e/specs/session-prefetch.spec.ts`

**Step 1: Write the failing desktop spec**

Create `packages/e2e/specs/session-prefetch.spec.ts` with a focused cross-workspace switching check. Keep the first version simple and explicit:

```ts
import { expect } from "@wdio/globals";
import { navigateToHash } from "../helpers/app-launcher.js";

describe("Cross-workspace sidebar session prefetch", () => {
  it("switches to a loaded session from another workspace without a fullscreen overlay", async () => {
    await navigateToHash("/session");

    const sidebar = await $("#root");
    await sidebar.waitForExist({ timeout: 10000 });

    // Replace these selectors with the real sidebar controls during implementation:
    const targetRow = await $("button*=workspace-b-session");
    await targetRow.waitForExist({ timeout: 10000 });
    await targetRow.click();

    const overlay = await $("text=Please wait for the workspace switch to complete.");
    expect(await overlay.isExisting()).toBe(false);

    await browser.saveScreenshot(
      "/Users/vaclavsoukup/AI agent projects/Veslo-cross-workspace-sidebar-prefetch/evidence/2026-04-11-cross-workspace-sidebar-prefetch/warm-switch.png",
    );
  });
});
```

During implementation, replace placeholder selectors with real ones and, if needed, seed two workspaces and sessions through the existing onboarding/session UI before the click assertion.

**Step 2: Build the Tauri desktop app with the WebDriver plugin**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch/packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
```

Expected: the debug Tauri binary is built under `packages/desktop/src-tauri/target/debug/`.

**Step 3: Run the feature spec to verify it fails first**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch/packages/e2e
pnpm test --spec ./specs/session-prefetch.spec.ts
```

Expected: FAIL until the spec uses the real selectors/fixture flow and the feature is fully implemented.

**Step 4: Finish the spec and run the full targeted verification set**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
packaging/docker/dev-up.sh
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch-interest.test.ts src/app/components/session/workspace-session-list-prefetch.test.ts src/app/lib/veslo-server-session-prefetch.test.ts
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts src/server-session-transcript-prefetch.test.ts
cd packages/desktop && pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e && pnpm test --spec ./specs/session-prefetch.spec.ts
```

Expected:

- Docker dev stack comes up successfully
- app unit tests PASS
- server Bun tests PASS
- Tauri build succeeds
- the targeted WDIO spec PASSes and writes `evidence/2026-04-11-cross-workspace-sidebar-prefetch/warm-switch.png`

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-cross-workspace-sidebar-prefetch
git add packages/e2e/specs/session-prefetch.spec.ts evidence/2026-04-11-cross-workspace-sidebar-prefetch/warm-switch.png
git commit -m "test(e2e): verify cross-workspace sidebar prefetch"
```
