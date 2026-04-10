# Loaded Sidebar Session Prefetch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make transcript prefetch warm every session currently loaded in the left sidebar for both `recent` and `by folder` modes, while warming subagents only after expansion and prioritizing clicked targets immediately.

**Architecture:** The app will stop deriving prefetch interest from viewport-visible rows and instead derive a richer per-workspace `loaded sidebar interest` payload containing clicked, selected, loaded top-level, and expanded subagent session IDs. The Veslo server will rebuild a workspace-scoped priority queue from that payload, protect current interest items from premature eviction, and drain the whole loaded interest set with low concurrency while keeping foreground transcript fetches ahead of background work.

**Tech Stack:** SolidJS, Solid stores, Veslo server (`packages/server`), Veslo app (`packages/app`), `node:test`, Bun tests, Tauri desktop runtime, WebdriverIO.

---

### Task 1: Define Loaded Sidebar Prefetch Interest In The App

**Files:**
- Create: `packages/app/src/app/components/session/workspace-session-list-prefetch-interest.ts`
- Create: `packages/app/src/app/components/session/workspace-session-list-prefetch-interest.test.ts`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { deriveLoadedSidebarPrefetchInterest } from "./workspace-session-list-prefetch-interest.js";

test("recent mode reports all loaded rows, not just viewport rows", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    mode: "recent",
    selectedSessionId: "sess-2",
    clickedSessionId: null,
    loadedTopLevelRows: [
      { workspaceId: "ws-a", sessionId: "sess-1", updatedAt: 30 },
      { workspaceId: "ws-a", sessionId: "sess-2", updatedAt: 20 },
      { workspaceId: "ws-a", sessionId: "sess-3", updatedAt: 10 },
    ],
    expandedSubagentRows: [],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: null,
    selectedSessionId: "sess-2",
    loadedTopLevelSessionIds: ["sess-1", "sess-2", "sess-3"],
    expandedSubagentSessionIds: [],
  });
});

test("expanded subagents are reported newest to oldest and collapsed subagents are excluded", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    mode: "by-project",
    selectedSessionId: null,
    clickedSessionId: null,
    loadedTopLevelRows: [{ workspaceId: "ws-a", sessionId: "parent", updatedAt: 50 }],
    expandedSubagentRows: [
      { workspaceId: "ws-a", sessionId: "child-older", updatedAt: 10 },
      { workspaceId: "ws-a", sessionId: "child-newer", updatedAt: 40 },
    ],
  });

  assert.deepEqual(result.get("ws-a")?.expandedSubagentSessionIds, ["child-newer", "child-older"]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch-interest.test.ts
```

Expected: FAIL because `deriveLoadedSidebarPrefetchInterest` and the new payload types do not exist.

**Step 3: Write minimal implementation**

```ts
export type LoadedSidebarPrefetchInterest = {
  clickedSessionId: string | null;
  selectedSessionId: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
};

export function deriveLoadedSidebarPrefetchInterest(input: {
  mode: "recent" | "by-project";
  selectedSessionId: string | null;
  clickedSessionId: string | null;
  loadedTopLevelRows: Array<{ workspaceId: string; sessionId: string; updatedAt: number }>;
  expandedSubagentRows: Array<{ workspaceId: string; sessionId: string; updatedAt: number }>;
}) {
  const result = new Map<string, LoadedSidebarPrefetchInterest>();
  // group by workspace, preserve top-level order, sort expanded subagents newest->oldest
  return result;
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch-interest.test.ts
```

Expected: PASS for loaded-row grouping, dedupe, and subagent ordering.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list-prefetch-interest.ts packages/app/src/app/components/session/workspace-session-list-prefetch-interest.test.ts packages/app/src/app/types.ts
git commit -m "feat(app): derive loaded sidebar prefetch interest"
```

### Task 2: Wire The Sidebar To Report Loaded Interest Instead Of Viewport Rows

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session list reports loaded top-level and expanded subagent ids", () => {
  assert.match(source, /loadedTopLevelSessionIds/);
  assert.match(source, /expandedSubagentSessionIds/);
  assert.doesNotMatch(source, /deriveVisibleSessionPrefetchIds\(/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch.test.ts
```

Expected: FAIL because the sidebar still derives interest from viewport-visible rows only.

**Step 3: Write minimal implementation**

- Replace the `visible rows` prefetch effect with a `loaded rows` effect.
- Derive `loadedTopLevelSessionIds` from the current loaded dataset for the active sidebar mode.
- Derive `expandedSubagentSessionIds` only from expanded branches.
- Track the latest clicked session ID in the list component and include it in the next callback payload.
- Update the callback contract in `types.ts`, `session.tsx`, and `dashboard.tsx` to send the richer payload.

Representative callback shape:

```ts
onLoadedSessionPrefetchInterestChange?: (
  workspaceId: string,
  interest: {
    clickedSessionId: string | null;
    selectedSessionId: string | null;
    loadedTopLevelSessionIds: string[];
    expandedSubagentSessionIds: string[];
  },
) => void;
```

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch-interest.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch.test.ts
```

Expected: PASS, including new loaded-set semantics and callback wiring.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/types.ts packages/app/src/app/components/session/workspace-session-list-prefetch-interest.ts packages/app/src/app/components/session/workspace-session-list-prefetch-interest.test.ts packages/app/src/app/components/session/workspace-session-list-prefetch.test.ts
git commit -m "feat(app): report loaded sidebar prefetch interest"
```

### Task 3: Extend Server And Client Payloads For Loaded Interest

**Files:**
- Modify: `packages/server/src/session-transcript-prefetch.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/veslo-server-session-prefetch.test.ts`
- Create: `packages/server/src/server-loaded-sidebar-session-prefetch.test.ts`

**Step 1: Write the failing tests**

```ts
// packages/server/src/server-loaded-sidebar-session-prefetch.test.ts
import assert from "node:assert/strict";
import test from "node:test";

test("prefetch endpoint accepts loaded top-level and expanded subagent ids", async () => {
  const response = await server.request("POST", "/workspace/ws_local/sessions/transcript-prefetch", {
    clickedSessionId: "sess-clicked",
    selectedSessionId: "sess-selected",
    loadedTopLevelSessionIds: ["sess-a", "sess-b"],
    expandedSubagentSessionIds: ["sub-2", "sub-1"],
    limit: 140,
  });

  assert.equal(response.status, 200);
  assert.equal(Array.isArray(response.body.queuedSessionIds), true);
});
```

```ts
// packages/app/src/app/lib/veslo-server-session-prefetch.test.ts
assert.match(source, /loadedTopLevelSessionIds/);
assert.match(source, /expandedSubagentSessionIds/);
assert.match(source, /clickedSessionId/);
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter veslo-server exec bun test src/server-loaded-sidebar-session-prefetch.test.ts
pnpm --filter @neatech/veslo-ui exec node --test src/app/lib/veslo-server-session-prefetch.test.ts
```

Expected: FAIL because the server route and client types still use `visibleSessionIds` only.

**Step 3: Write minimal implementation**

Update the shared request shape so the server route accepts:

```ts
{
  clickedSessionId?: string | null;
  selectedSessionId?: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
  limit?: number;
}
```

Then update:
- route parsing in `server.ts`
- store input types in `session-transcript-prefetch.ts`
- client request typing in `veslo-server.ts`

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter veslo-server exec bun test src/server-loaded-sidebar-session-prefetch.test.ts
pnpm --filter @neatech/veslo-ui exec node --test src/app/lib/veslo-server-session-prefetch.test.ts
```

Expected: PASS for request parsing, response shape, and client bindings.

**Step 5: Commit**

```bash
git add packages/server/src/session-transcript-prefetch.ts packages/server/src/server.ts packages/server/src/server-loaded-sidebar-session-prefetch.test.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server-session-prefetch.test.ts
git commit -m "feat(server): accept loaded sidebar prefetch interest"
```

### Task 4: Rework The Server Queue To Drain The Whole Loaded Interest Set

**Files:**
- Modify: `packages/server/src/session-transcript-prefetch.ts`
- Modify: `packages/server/src/session-transcript-prefetch.test.ts`

**Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createSessionTranscriptPrefetchStore } from "./session-transcript-prefetch.js";

test("clicked session outranks selected, expanded subagents, and loaded top-level rows", async () => {
  const store = createSessionTranscriptPrefetchStore({
    loadTranscript: async ({ workspaceId, sessionId, limit }) => ({ workspaceId, sessionId, messages: [], partsByMessageId: {}, fetchedAt: 1, staleAt: 10_000, limit }),
    autoPrefetchOnInterest: false,
  });

  await store.updateInterest({
    workspaceId: "ws_local",
    clickedSessionId: "clicked",
    selectedSessionId: "selected",
    loadedTopLevelSessionIds: ["top-a", "top-b"],
    expandedSubagentSessionIds: ["sub-new", "sub-old"],
    limit: 140,
  });

  assert.deepEqual(store.debugQueue("ws_local"), ["clicked", "selected", "sub-new", "sub-old", "top-a", "top-b"]);
});

test("prefetch workspace drains every cold interest item, not just a short prefix", async () => {
  const loaded: string[] = [];
  const store = createSessionTranscriptPrefetchStore({
    loadTranscript: async ({ workspaceId, sessionId, limit }) => {
      loaded.push(sessionId);
      return { workspaceId, sessionId, messages: [], partsByMessageId: {}, fetchedAt: Date.now(), staleAt: Date.now() + 20_000, limit };
    },
    maxEntriesPerWorkspace: 10,
    maxConcurrentPrefetch: 1,
  });

  await store.updateInterest({
    workspaceId: "ws_local",
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["a", "b", "c", "d"],
    expandedSubagentSessionIds: [],
    limit: 140,
  });
  await store.prefetchWorkspace("ws_local");

  assert.deepEqual(loaded, ["a", "b", "c", "d"]);
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
```

Expected: FAIL because the store still uses `visibleSessionIds` ordering and `maxPrefetchPerUpdate` short-circuiting.

**Step 3: Write minimal implementation**

Implement these changes in `session-transcript-prefetch.ts`:

- replace `visibleSessionIds` queue normalization with richer interest normalization
- order the queue as `clicked -> selected -> expanded subagents -> loaded top-level`
- remove `maxPrefetchPerUpdate` semantics from `prefetchWorkspace`
- introduce low concurrency instead, for example `maxConcurrentPrefetch`
- ensure one failed item does not permanently stall the queue
- keep dedupe by `workspaceId + sessionId`

Representative queue builder:

```ts
const ordered = new Set<string>();
if (clicked) ordered.add(clicked);
if (selected) ordered.add(selected);
for (const id of expandedSubagentSessionIds) ordered.add(id);
for (const id of loadedTopLevelSessionIds) ordered.add(id);
return Array.from(ordered);
```

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
```

Expected: PASS for ordering, dedupe, full-drain behavior, and no-stall failure handling.

**Step 5: Commit**

```bash
git add packages/server/src/session-transcript-prefetch.ts packages/server/src/session-transcript-prefetch.test.ts
git commit -m "perf(server): drain loaded sidebar transcript interest"
```

### Task 5: Add Interest-Aware Eviction And Removal Semantics

**Files:**
- Modify: `packages/server/src/session-transcript-prefetch.ts`
- Modify: `packages/server/src/session-transcript-prefetch.test.ts`

**Step 1: Write the failing tests**

```ts
test("loaded interest items are not evicted before non-interest items", async () => {
  const store = createSessionTranscriptPrefetchStore({
    loadTranscript: async ({ workspaceId, sessionId, limit }) => ({ workspaceId, sessionId, messages: [], partsByMessageId: {}, fetchedAt: Date.now(), staleAt: Date.now() + 20_000, limit }),
    maxEntriesPerWorkspace: 2,
    autoPrefetchOnInterest: false,
  });

  await store.updateInterest({
    workspaceId: "ws_local",
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["keep-a", "keep-b"],
    expandedSubagentSessionIds: [],
    limit: 140,
  });
  await store.getOrLoad({ workspaceId: "ws_local", sessionId: "keep-a", limit: 140 });
  await store.getOrLoad({ workspaceId: "ws_local", sessionId: "keep-b", limit: 140 });
  await store.getOrLoad({ workspaceId: "ws_local", sessionId: "drop-me", limit: 140 });

  assert.deepEqual(store.debugCacheSessionIds("ws_local"), ["keep-a", "keep-b"]);
});

test("collapsing a branch removes expanded subagents from interest", async () => {
  const store = createSessionTranscriptPrefetchStore({ loadTranscript: async ({ workspaceId, sessionId, limit }) => ({ workspaceId, sessionId, messages: [], partsByMessageId: {}, fetchedAt: 1, staleAt: 10_000, limit }), autoPrefetchOnInterest: false });

  await store.updateInterest({
    workspaceId: "ws_local",
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["parent"],
    expandedSubagentSessionIds: ["child-a", "child-b"],
    limit: 140,
  });
  await store.updateInterest({
    workspaceId: "ws_local",
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["parent"],
    expandedSubagentSessionIds: [],
    limit: 140,
  });

  assert.deepEqual(store.debugQueue("ws_local"), ["parent"]);
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
```

Expected: FAIL because eviction is still pure LRU and queue removal is not explicitly interest-aware.

**Step 3: Write minimal implementation**

- Track the current interest set per workspace.
- Teach eviction to prefer dropping non-interest items first.
- Rebuild the queue from the latest interest payload instead of incrementally mutating stale items.
- Ensure collapsed subagents disappear cleanly.

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
```

Expected: PASS for interest-aware eviction and queue removal.

**Step 5: Commit**

```bash
git add packages/server/src/session-transcript-prefetch.ts packages/server/src/session-transcript-prefetch.test.ts
git commit -m "perf(server): protect loaded sidebar cache interest"
```

### Task 6: Preserve Transcript-First App Behavior With The New Payload

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/context/session-transcript-hydration.test.ts`
- Modify: `packages/app/src/app/context/session-switch-metrics.test.ts`
- Modify: `packages/app/scripts/session-switch.mjs`

**Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("app still hydrates transcript snapshots returned by loaded-sidebar prefetch", () => {
  assert.match(appSource, /prefetchSessionTranscripts:\s*async\s*\(workspaceId, input\)\s*=>/);
  assert.match(appSource, /hydrateTranscriptSnapshot\(item\)/);
});
```

Add one script assertion ensuring warm/cold session-switch timing still exists after the payload rename.

**Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-transcript-hydration.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-switch-metrics.test.ts
pnpm --filter @neatech/veslo-ui test:session-switch
```

Expected: FAIL if any payload renames or callback changes broke hydration or metrics.

**Step 3: Write minimal implementation**

- Keep the hydrated Veslo server client wrapper intact.
- Update payload types only; do not regress transcript-first switching.
- Keep `selectSession()` behavior where messages first-paint before todos and permissions.

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-transcript-hydration.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-switch-metrics.test.ts
pnpm --filter @neatech/veslo-ui test:session-switch
```

Expected: PASS, including warm-hit and cold-miss reporting.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/context/session.ts packages/app/src/app/context/session-transcript-hydration.test.ts packages/app/src/app/context/session-switch-metrics.test.ts packages/app/scripts/session-switch.mjs
git commit -m "perf(app): preserve transcript-first switching for loaded prefetch"
```

### Task 7: Add Desktop Runtime Coverage For Loaded Sidebar Warming

**Files:**
- Create: `packages/e2e/specs/loaded-sidebar-session-prefetch.spec.ts`
- Modify: `packages/e2e/helpers/app-launcher.js` only if the spec needs a reusable helper

**Step 1: Write the failing spec**

```ts
describe("Loaded sidebar session prefetch", () => {
  it("warms loaded sessions and expanded subagents without a fullscreen blocker", async () => {
    // create workspace
    // seed multiple top-level sessions
    // load more rows
    // expand one parent with subagents
    // verify click on a loaded session/subagent does not show fullscreen blocker
  });
});
```

Add assertions for:
- `recent` mode warming loaded rows
- `by folder` mode warming loaded top-level rows
- expanded subagents warming only after expansion
- clicked subagent priority

**Step 2: Run spec to verify it fails**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/e2e
pnpm test --spec ./specs/loaded-sidebar-session-prefetch.spec.ts
```

Expected: FAIL before the loaded-set behavior exists.

**Step 3: Write minimal implementation**

- Reuse the existing workspace/session seeding approach.
- Build the spec around sidebar interactions that reflect the real loaded-set contract:
  - verify top-level loaded rows
  - click `Load more`
  - expand branch
  - click subagent
- Assert that no fullscreen session blocker appears and that the expected transcript renders.

**Step 4: Run spec to verify it passes**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/e2e
pnpm test --spec ./specs/loaded-sidebar-session-prefetch.spec.ts
```

Expected: PASS in the real Tauri desktop runtime.

**Step 5: Commit**

```bash
git add packages/e2e/specs/loaded-sidebar-session-prefetch.spec.ts packages/e2e/helpers/app-launcher.js
git commit -m "test(e2e): cover loaded sidebar transcript prefetch"
```

### Task 8: Final Verification And Cleanup

**Files:**
- Modify only if fixes are required by verification

**Step 1: Run targeted app and server tests**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
pnpm --filter veslo-server exec bun test src/server-loaded-sidebar-session-prefetch.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch-interest.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-prefetch.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-transcript-hydration.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-switch-metrics.test.ts
pnpm --filter @neatech/veslo-ui test:session-switch
```

Expected: PASS.

**Step 2: Run broader app verification**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Run desktop verification**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/e2e
pnpm test --spec ./specs/loaded-sidebar-session-prefetch.spec.ts
```

Expected: PASS.

**Step 4: Review git status and keep unrelated work untouched**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
git status --short
```

Expected: only intended files are staged or modified; pre-existing unrelated changes remain untouched.

**Step 5: Commit final verification fixes if needed**

```bash
git add <any final touched files>
git commit -m "test: finalize loaded sidebar prefetch verification"
```
