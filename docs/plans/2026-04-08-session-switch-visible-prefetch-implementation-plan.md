# Session Switch Visible Prefetch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make session switching render the target chat transcript within roughly `200-500 ms` for visible sidebar sessions by prefetching transcript snapshots in the Veslo server and removing the fullscreen session loading overlay.

**Architecture:** The Veslo server owns a workspace-scoped transcript prefetch queue and warm cache for visible sidebar sessions. The app reports visible session IDs in the background, hydrates warmed transcript snapshots into the existing per-session store, and renders the center pane transcript immediately while all secondary loading happens after first paint.

**Tech Stack:** SolidJS, Veslo server (`packages/server`), Veslo app (`packages/app`), `@opencode-ai/sdk/v2`, `node:test`, Bun tests, Tauri desktop runtime, WebdriverIO e2e.

---

### Task 1: Build the Server Transcript Prefetch Core

**Files:**
- Create: `packages/server/src/session-transcript-prefetch.ts`
- Create: `packages/server/src/session-transcript-prefetch.test.ts`
- Modify: `packages/server/src/types.ts`

**Step 1: Write the failing test**

```ts
test("prefetch store dedupes visible-session requests and prioritizes the selected session", async () => {
  const store = createSessionTranscriptPrefetchStore({
    loadTranscript: async ({ sessionId }) => ({
      sessionId,
      workspaceId: "ws_local",
      messages: [],
      partsByMessageId: {},
      fetchedAt: 1,
      staleAt: 2,
    }),
    maxEntriesPerWorkspace: 3,
  });

  await store.updateInterest({
    workspaceId: "ws_local",
    visibleSessionIds: ["sess-b", "sess-c", "sess-b"],
    selectedSessionId: "sess-a",
    limit: 140,
  });

  assert.deepEqual(store.debugQueue("ws_local"), ["sess-a", "sess-b", "sess-c"]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
```

Expected: FAIL because `createSessionTranscriptPrefetchStore` does not exist yet.

**Step 3: Write minimal implementation**

```ts
export type TranscriptSnapshot = {
  sessionId: string;
  workspaceId: string;
  messages: MessageInfo[];
  partsByMessageId: Record<string, Part[]>;
  fetchedAt: number;
  staleAt: number;
};

export function createSessionTranscriptPrefetchStore(deps: {
  loadTranscript: (input: { workspaceId: string; sessionId: string; limit: number }) => Promise<TranscriptSnapshot>;
  maxEntriesPerWorkspace: number;
}) {
  const cache = new Map<string, TranscriptSnapshot>();
  const queue = new Map<string, string[]>();

  return {
    async updateInterest(input: {
      workspaceId: string;
      visibleSessionIds: string[];
      selectedSessionId?: string | null;
      limit: number;
    }) {
      const ids = new Set(input.visibleSessionIds.map((id) => id.trim()).filter(Boolean));
      const ordered = [
        input.selectedSessionId?.trim() ?? "",
        ...ids,
      ].filter(Boolean);
      queue.set(input.workspaceId, ordered);
    },
    debugQueue(workspaceId: string) {
      return queue.get(workspaceId) ?? [];
    },
    getWarmSnapshot(workspaceId: string, sessionId: string) {
      return cache.get(`${workspaceId}:${sessionId}`) ?? null;
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
```

Expected: PASS for queue ordering, dedupe, TTL, and eviction assertions.

**Step 5: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/session-transcript-prefetch.ts packages/server/src/session-transcript-prefetch.test.ts
git commit -m "feat(server): add session transcript prefetch store"
```

### Task 2: Expose Prefetch And Transcript Endpoints in Veslo Server

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/types.ts`
- Create: `packages/server/src/server-session-transcript-prefetch.test.ts`

**Step 1: Write the failing test**

```ts
test("transcript prefetch endpoint schedules visible sessions and returns warm snapshots", async () => {
  const server = await createTestServer();

  const response = await server.request("POST", "/workspace/ws_local/sessions/transcript-prefetch", {
    visibleSessionIds: ["sess-a", "sess-b"],
    selectedSessionId: "sess-a",
    limit: 140,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.items[0]?.sessionId, "sess-a");
  assert.equal(Array.isArray(response.body.queuedSessionIds), true);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter veslo-server exec bun test src/server-session-transcript-prefetch.test.ts
```

Expected: FAIL because the routes and response types do not exist.

**Step 3: Write minimal implementation**

```ts
addRoute(routes, "POST", "/workspace/:id/sessions/transcript-prefetch", "client", async (ctx) => {
  const workspace = await resolveWorkspace(config, ctx.params.id);
  const body = await readJsonBody(ctx.request);
  const result = await transcriptPrefetch.updateInterest({
    workspaceId: workspace.id,
    visibleSessionIds: Array.isArray(body.visibleSessionIds) ? body.visibleSessionIds : [],
    selectedSessionId: typeof body.selectedSessionId === "string" ? body.selectedSessionId : null,
    limit: typeof body.limit === "number" ? body.limit : 140,
  });
  return jsonResponse(result);
});

addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/transcript", "client", async (ctx) => {
  const workspace = await resolveWorkspace(config, ctx.params.id);
  return jsonResponse(await transcriptPrefetch.getOrLoad({
    workspaceId: workspace.id,
    sessionId: ctx.params.sessionId,
    limit: Number(ctx.url.searchParams.get("limit") ?? 140),
  }));
});
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter veslo-server exec bun test src/server-session-transcript-prefetch.test.ts
pnpm --filter veslo-server exec bun test
```

Expected: PASS, including auth, workspace scoping, and no-blocking response-shape assertions.

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/types.ts packages/server/src/server-session-transcript-prefetch.test.ts
git commit -m "feat(server): add transcript prefetch endpoints"
```

### Task 3: Add App Client Bindings for Transcript Prefetch

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Create: `packages/app/src/app/lib/veslo-server-session-prefetch.test.ts`

**Step 1: Write the failing test**

```ts
test("veslo server client exposes transcript prefetch methods", async () => {
  const source = readFileSync(resolve(__dirname, "veslo-server.ts"), "utf8");
  assert.match(source, /prefetchSessionTranscripts:\s*\(/);
  assert.match(source, /getSessionTranscript:\s*\(/);
  assert.match(source, /\/workspace\/\$\{encodeURIComponent\(workspaceId\)\}\/sessions\/transcript-prefetch/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/lib/veslo-server-session-prefetch.test.ts
```

Expected: FAIL because the methods and types are missing.

**Step 3: Write minimal implementation**

```ts
export type VesloSessionTranscriptSnapshot = {
  sessionId: string;
  workspaceId: string;
  messages: MessageWithParts[];
  fetchedAt: number;
  staleAt: number;
};

export type VesloSessionTranscriptPrefetchResult = {
  items: VesloSessionTranscriptSnapshot[];
  queuedSessionIds: string[];
};

prefetchSessionTranscripts: (workspaceId, input) =>
  requestJson<VesloSessionTranscriptPrefetchResult>(
    baseUrl,
    `/workspace/${encodeURIComponent(workspaceId)}/sessions/transcript-prefetch`,
    { method: "POST", token, hostToken, body: input },
  ),

getSessionTranscript: (workspaceId, sessionId, limit = 140) =>
  requestJson<VesloSessionTranscriptSnapshot>(
    baseUrl,
    `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/transcript?limit=${limit}`,
    { token, hostToken },
  ),
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/lib/veslo-server-session-prefetch.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server-session-prefetch.test.ts
git commit -m "feat(app): add veslo transcript prefetch client"
```

### Task 4: Report Visible Sidebar Sessions to the Backend

**Files:**
- Create: `packages/app/src/app/components/session/workspace-session-list-prefetch.ts`
- Create: `packages/app/src/app/components/session/workspace-session-list-prefetch.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write the failing test**

```ts
test("deriveVisibleSessionPrefetchIds keeps viewport order and selected session first", () => {
  const result = deriveVisibleSessionPrefetchIds({
    selectedSessionId: "sess-selected",
    visibleSessionIds: ["sess-b", "sess-c", "sess-b"],
  });

  assert.deepEqual(result, ["sess-selected", "sess-b", "sess-c"]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/components/session/workspace-session-list-prefetch.test.ts
```

Expected: FAIL because the helper and callback contract do not exist.

**Step 3: Write minimal implementation**

```ts
export function deriveVisibleSessionPrefetchIds(input: {
  selectedSessionId: string | null;
  visibleSessionIds: string[];
}) {
  const ordered = new Set<string>();
  const selected = input.selectedSessionId?.trim() ?? "";
  if (selected) ordered.add(selected);
  for (const id of input.visibleSessionIds) {
    const normalized = id.trim();
    if (normalized) ordered.add(normalized);
  }
  return Array.from(ordered);
}
```

Wire `WorkspaceSessionList` to call a new prop like:

```ts
onVisibleSessionIdsChange?: (workspaceId: string, visibleSessionIds: string[]) => void;
```

and invoke it from `createEffect()` whenever `recentRowsVisible()` or the visible project rows change.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/components/session/workspace-session-list-prefetch.test.ts
pnpm --filter @neatech/veslo-ui exec node --test src/app/components/session/workspace-session-list-windowing.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list-prefetch.ts packages/app/src/app/components/session/workspace-session-list-prefetch.test.ts packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/types.ts
git commit -m "feat(app): report visible sessions for transcript prefetch"
```

### Task 5: Hydrate Warm Transcript Snapshots into the Session Store

**Files:**
- Create: `packages/app/src/app/context/session-transcript-hydration.test.ts`
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/app.tsx`

**Step 1: Write the failing test**

```ts
test("hydrateTranscriptSnapshot stores messages and parts without selecting the session", async () => {
  const store = createSessionStore(testOptions());

  store.hydrateTranscriptSnapshot({
    sessionId: "sess-a",
    workspaceId: "ws_local",
    messages: [{ info: { id: "msg-1", sessionID: "sess-a" }, parts: [{ id: "part-1", type: "text", text: "Hi" }] }],
    fetchedAt: 1,
    staleAt: 2,
  });

  assert.equal(store.getCachedTranscriptMessageCount("sess-a"), 1);
  assert.equal(store.messages().length, 0);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/context/session-transcript-hydration.test.ts
```

Expected: FAIL because transcript hydration helpers do not exist.

**Step 3: Write minimal implementation**

```ts
function hydrateTranscriptSnapshot(snapshot: VesloSessionTranscriptSnapshot) {
  setMessagesForSession(snapshot.sessionId, snapshot.messages);
  setTranscriptFreshnessBySession((current) => ({
    ...current,
    [snapshot.sessionId]: {
      fetchedAt: snapshot.fetchedAt,
      staleAt: snapshot.staleAt,
    },
  }));
}

function hasWarmTranscript(sessionId: string) {
  return (store.messages[sessionId] ?? []).length > 0;
}
```

Update `app.tsx` to call the new server client in the background whenever visible IDs arrive and pass returned snapshots into the session store.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/context/session-transcript-hydration.test.ts
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/session.ts packages/app/src/app/context/session-transcript-hydration.test.ts packages/app/src/app/app.tsx
git commit -m "feat(app): hydrate prefetched session transcripts"
```

### Task 6: Make Session Selection Transcript-First and Non-Blocking

**Files:**
- Modify: `packages/app/src/app/context/session.ts`
- Create: `packages/app/src/app/context/session-select-transcript-first.test.ts`

**Step 1: Write the failing test**

```ts
test("selectSession returns after transcript availability and defers todos and permissions", async () => {
  const calls: string[] = [];
  const store = createSessionStore(testOptions({
    client: fakeClient({
      session: {
        messages: async () => {
          calls.push("messages");
          return warmMessages;
        },
        todo: async () => {
          calls.push("todo");
          return [];
        },
      },
      permission: {
        list: async () => {
          calls.push("permissions");
          return [];
        },
      },
    }),
  }));

  await store.selectSession("sess-a");

  assert.deepEqual(calls[0], "messages");
  assert.equal(store.messages().length > 0, true);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/context/session-select-transcript-first.test.ts
```

Expected: FAIL because `selectSession()` still treats todos and permissions as foreground work.

**Step 3: Write minimal implementation**

```ts
async function selectSession(sessionID: string) {
  options.setSelectedSessionId(sessionID);
  options.setError(null);

  if (hasWarmTranscript(sessionID)) {
    void hydrateSecondarySessionData(sessionID);
    options.onSessionTranscriptVisible?.(sessionID);
    return;
  }

  const snapshot = options.getWarmTranscriptSnapshot?.(sessionID);
  if (snapshot) {
    hydrateTranscriptSnapshot(snapshot);
    void hydrateSecondarySessionData(sessionID);
    options.onSessionTranscriptVisible?.(sessionID);
    return;
  }

  const transcript = await options.fetchSessionTranscript?.(sessionID);
  if (transcript) hydrateTranscriptSnapshot(transcript);
  options.onSessionTranscriptVisible?.(sessionID);
  void hydrateSecondarySessionData(sessionID);
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/context/session-select-transcript-first.test.ts
pnpm --filter @neatech/veslo-ui test:session-switch
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/session.ts packages/app/src/app/context/session-select-transcript-first.test.ts
git commit -m "perf(app): make session select transcript-first"
```

### Task 7: Remove the Fullscreen Session Overlay and Move Loading into the Message Box

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/app-overlay-i18n.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Create: `packages/app/src/app/pages/session-inline-loading.test.ts`

**Step 1: Write the failing test**

```ts
test("app no longer renders the fullscreen pendingSessionLoad overlay", () => {
  const source = readFileSync(resolve(__dirname, "app.tsx"), "utf8");
  assert.equal(source.includes("pendingSessionLoad"), false);
});

test("session page exposes inline loading state for cold transcript fetches", () => {
  const source = readFileSync(resolve(__dirname, "pages/session.tsx"), "utf8");
  assert.match(source, /session\\.loading_conversation_inline/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/app-overlay-i18n.test.ts src/app/pages/session-inline-loading.test.ts
```

Expected: FAIL because the overlay still exists and inline loading does not.

**Step 3: Write minimal implementation**

```tsx
<Show when={props.transcriptLoading && props.messages.length === 0}>
  <div class="mx-auto w-full max-w-[var(--chat-body-width)] px-8 py-6">
    <div class="rounded-2xl border border-gray-6 bg-gray-2/60 px-4 py-3 text-sm text-gray-11">
      {tr("session.loading_conversation_inline")}
    </div>
  </div>
</Show>
```

Delete the `pendingSessionLoad` signal and its fullscreen render path from `app.tsx`. Remove the overlay-specific loading behavior from `session.tsx` and `dashboard.tsx`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test src/app/app-overlay-i18n.test.ts src/app/pages/session-inline-loading.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/app-overlay-i18n.test.ts packages/app/src/app/pages/session-inline-loading.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts
git commit -m "perf(app): replace session fullscreen loading with inline state"
```

### Task 8: Add Metrics, Desktop E2E Coverage, and Final Verification

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/scripts/session-switch.mjs`
- Create: `packages/e2e/specs/session-prefetch.spec.ts`

**Step 1: Write the failing test**

```ts
test("session switch metrics distinguish warm hits from cold misses", async () => {
  const result = await runSessionSwitchScript();
  assert.equal(typeof result.steps.find((step) => step.name === "warm transcript first paint")?.data?.elapsedMs, "number");
  assert.equal(typeof result.steps.find((step) => step.name === "cold transcript first paint")?.data?.elapsedMs, "number");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:session-switch
```

Expected: FAIL because the script and instrumentation do not report warm-hit versus cold-miss timing yet.

**Step 3: Write minimal implementation**

```ts
recordPerfLog(developerMode(), "session.switch", "transcript-first-paint", {
  sessionID,
  source: warmHit ? "warm-hit" : "cold-miss",
  elapsedMs,
});
```

Add a desktop e2e that:

- builds the Tauri app with the `e2e` feature
- reuses an existing WebDriver instance at `http://127.0.0.1:4445/status` when present
- clicks between visible sessions
- asserts the center pane transcript changes without a fullscreen blocker
- asserts the sidebar remains clickable mid-load

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:session-switch
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter veslo-server test
cd packages/desktop && pnpm tauri build --debug --no-bundle -- --features e2e
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/e2e && pnpm test --spec ./specs/session-prefetch.spec.ts
```

Expected:

- app and server tests PASS
- desktop e2e PASS against the Tauri binary
- no fullscreen session loading screen appears during the switch

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/scripts/session-switch.mjs packages/e2e/specs/session-prefetch.spec.ts
git commit -m "test(e2e): verify visible-session transcript prefetch switching"
```

### Task 9: Final Integration Verification And Cleanup

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/app.tsx`

**Step 1: Write the failing regression checklist**

Create a short local checklist in the PR description or task notes:

```md
- warm visible session opens in <= 500 ms
- cold session shows only inline message-box loading
- sidebar remains clickable during switch
- active prompt flow is not delayed by background prefetch
- workspace switch still uses the workspace overlay only
```

**Step 2: Run full verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:session-switch
pnpm --filter veslo-server test
cd packages/desktop && pnpm tauri build --debug --no-bundle -- --features e2e
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/e2e && pnpm test --spec ./specs/session-prefetch.spec.ts
```

Expected: all commands PASS.

**Step 3: Remove dead code**

Delete or simplify any leftover fullscreen session-loading helpers, unused i18n keys, or obsolete app wiring that only existed for `pendingSessionLoad`.

**Step 4: Re-run verification**

Run the same commands again and confirm they still pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/context/session.ts packages/server/src/server.ts
git commit -m "refactor: remove legacy session loading flow"
```
