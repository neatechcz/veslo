import { describe, expect, test } from "bun:test";
import { createSessionTranscriptPrefetchStore } from "../session-transcript-prefetch.js";

describe("session transcript prefetch core", () => {
  test("invalidates a Windows path cache entry through an equivalent path spelling", async () => {
    let calls = 0;
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId, directory }) => {
        calls += 1;
        return {
          workspaceId,
          sessionId,
          directory: directory ?? undefined,
          messages: [{ id: `msg-${calls}` }],
          partsByMessageId: {},
        };
      },
    });

    await store.getOrLoad({ workspaceId: "ws-a", sessionId: "ses-a", limit: 10, directory: "C:\\Work\\Veslo" });
    store.invalidate({ workspaceId: "ws-a", sessionId: "ses-a", directory: "c:/work/veslo" });
    const result = await store.getOrLoad({ workspaceId: "ws-a", sessionId: "ses-a", limit: 10, directory: "C:/WORK/VESLO" });

    expect(calls).toBe(2);
    expect(result.messages).toEqual([{ id: "msg-2" }]);
  });

  test("prioritizes clicked, selected, expanded, and loaded sessions in queue order", async () => {
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId }) => ({
        workspaceId,
        sessionId,
        messages: [],
        partsByMessageId: {},
      }),
      autoPrefetchOnInterest: false,
    });

    const result = await store.updateInterest({
      workspaceId: "ws_local",
      clickedSessionId: "sess-clicked",
      selectedSessionId: "sess-selected",
      expandedSubagentSessionIds: ["exp-b", "sess-selected", "exp-a", "exp-b"],
      loadedTopLevelSessionIds: ["top-c", "sess-clicked", "top-b", "top-a", "top-b"],
      limit: 140,
    });

    expect(store.debugQueue("ws_local")).toEqual([
      "sess-clicked",
      "sess-selected",
      "exp-b",
      "exp-a",
      "top-c",
      "top-b",
      "top-a",
    ]);
    expect(result.queuedSessionIds).toEqual([
      "sess-clicked",
      "sess-selected",
      "exp-b",
      "exp-a",
      "top-c",
      "top-b",
      "top-a",
    ]);
    expect(result.items).toEqual([]);
  });

  test("keeps scoped session refs with duplicate ids isolated by directory and ignores ambiguous legacy fallback", async () => {
    const calls: Array<{ sessionId: string; directory: string | null | undefined }> = [];
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId, directory }) => {
        calls.push({ sessionId, directory });
        return {
          workspaceId,
          sessionId,
          directory,
          messages: [],
          partsByMessageId: {},
        };
      },
      autoPrefetchOnInterest: false,
    });

    const result = await store.updateInterest({
      workspaceId: "ws_local",
      clickedSession: { sessionId: "shared", directory: "/work/a" },
      selectedSession: { sessionId: "shared", directory: "/work/b" },
      clickedSessionId: null,
      selectedSessionId: null,
      expandedSubagentSessions: [{ sessionId: "child", directory: "/work/a" }],
      expandedSubagentSessionIds: [],
      loadedTopLevelSessions: [{ sessionId: "shared", directory: "/work/c" }],
      loadedTopLevelSessionIds: ["shared"],
      sessionDirectoriesById: {
        shared: "/work/d",
      },
      limit: 140,
    });

    expect(result.queuedSessionIds).toEqual(["shared", "shared", "child", "shared"]);
    await store.prefetchWorkspace("ws_local");

    expect(calls).toEqual([
      { sessionId: "shared", directory: "/work/a" },
      { sessionId: "shared", directory: "/work/b" },
      { sessionId: "child", directory: "/work/a" },
      { sessionId: "shared", directory: "/work/c" },
    ]);
  });

  test("drains the whole loaded set instead of stopping after a prefix", async () => {
    const calls: string[] = [];
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId }) => {
        calls.push(sessionId);
        return {
          workspaceId,
          sessionId,
          messages: [],
          partsByMessageId: {},
        };
      },
      autoPrefetchOnInterest: false,
    });

    await store.updateInterest({
      workspaceId: "ws_local",
      clickedSessionId: null,
      selectedSessionId: null,
      expandedSubagentSessionIds: [],
      loadedTopLevelSessionIds: ["sess-a", "sess-b", "sess-c", "sess-d", "sess-e"],
      limit: 140,
    });

    await store.prefetchWorkspace("ws_local");

    expect(calls).toEqual(["sess-a", "sess-b", "sess-c", "sess-d", "sess-e"]);
    expect(store.debugQueue("ws_local")).toEqual([]);
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-e" })?.sessionId).toBe("sess-e");
  });

  test("preserves unavailable read diagnostics through getOrLoad", async () => {
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId }) => ({
        workspaceId,
        sessionId,
        messages: [],
        partsByMessageId: {},
        source: "unavailable" as const,
        diagnostic: {
          reason: "database_missing" as const,
          workspaceId,
          sessionId,
          dbPath: "/missing/opencode.db",
          dbPathExists: false,
        },
      }),
      autoPrefetchOnInterest: false,
    });

    const snapshot = await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });

    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.diagnostic).toEqual({
      reason: "database_missing",
      workspaceId: "ws_local",
      sessionId: "sess-a",
      dbPath: "/missing/opencode.db",
      dbPathExists: false,
    });
  });

  test("drops a failed background load and keeps draining later queue items", async () => {
    const calls: string[] = [];
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId }) => {
        calls.push(sessionId);
        if (sessionId === "sess-b") {
          throw new Error("boom");
        }
        return {
          workspaceId,
          sessionId,
          messages: [],
          partsByMessageId: {},
        };
      },
      autoPrefetchOnInterest: false,
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
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })?.sessionId).toBe("sess-a");
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-b" })).toBeNull();
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-c" })?.sessionId).toBe("sess-c");
    expect(store.debugQueue("ws_local")).toEqual([]);
  });

  test("deduplicates in-flight loads for the same workspace/session", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId }) => {
        calls += 1;
        await gate;
        return {
          workspaceId,
          sessionId,
          messages: [{ id: "m1" }],
          partsByMessageId: {},
        };
      },
    });

    const p1 = store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });
    const p2 = store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });
    const p3 = store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });

    await Promise.resolve();
    expect(calls).toBe(1);

    release();
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

    expect(calls).toBe(1);
    expect(s1.sessionId).toBe("sess-a");
    expect(s2.sessionId).toBe("sess-a");
    expect(s3.sessionId).toBe("sess-a");
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })?.sessionId).toBe("sess-a");
  });

  test("caches loaded snapshots under the requested workspace and session", async () => {
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async () => ({
        workspaceId: "ws_wrong",
        sessionId: "sess-wrong",
        messages: [{ id: "m1" }],
        partsByMessageId: {},
      }),
    });

    const snapshot = await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });

    expect(snapshot.workspaceId).toBe("ws_local");
    expect(snapshot.sessionId).toBe("sess-a");
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })?.messages).toEqual([
      { id: "m1" },
    ]);
    expect(store.getWarmSnapshot({ workspaceId: "ws_wrong", sessionId: "sess-wrong" })).toBeNull();
  });

  test("keeps warm snapshots isolated by directory", async () => {
    const calls: Array<{ sessionId: string; directory: string | null | undefined }> = [];
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId, directory }) => {
        calls.push({ sessionId, directory });
        return {
          workspaceId,
          sessionId,
          messages: [{ directory }],
          partsByMessageId: {},
        };
      },
      autoPrefetchOnInterest: false,
    });

    const interest = await store.updateInterest({
      workspaceId: "ws_local",
      clickedSessionId: null,
      selectedSessionId: null,
      expandedSubagentSessionIds: [],
      loadedTopLevelSessionIds: ["sess-a", "sess-a"],
      sessionDirectoriesById: {
        "sess-a": "/work/a",
      },
      limit: 140,
    });

    expect(interest.queuedSessionIds).toEqual(["sess-a"]);
    await store.prefetchWorkspace("ws_local");

    await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140, directory: "/work/b" });

    expect(calls).toEqual([
      { sessionId: "sess-a", directory: "/work/a" },
      { sessionId: "sess-a", directory: "/work/b" },
    ]);
    expect(
      store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a", directory: "/work/a" })?.directory,
    ).toBe("/work/a");
    expect(
      store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a", directory: "/work/b" })?.directory,
    ).toBe("/work/b");
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })).toBeNull();
  });

  test("queues scoped duplicate session ids by directory from sidebar refs", async () => {
    const calls: Array<{ sessionId: string; directory: string | null | undefined }> = [];
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId, directory }) => {
        calls.push({ sessionId, directory });
        return {
          workspaceId,
          sessionId,
          messages: [{ directory }],
          partsByMessageId: {},
        };
      },
      autoPrefetchOnInterest: false,
    });

    const interest = await store.updateInterest({
      workspaceId: "ws_local",
      clickedSessionId: "sess-a",
      clickedSession: { sessionId: "sess-a", directory: "/work/b" },
      selectedSessionId: null,
      expandedSubagentSessionIds: [],
      loadedTopLevelSessionIds: ["sess-a"],
      loadedTopLevelSessions: [
        { sessionId: "sess-a", directory: "/work/a" },
        { sessionId: "sess-a", directory: "/work/b" },
      ],
      sessionDirectoriesById: {
        "sess-a": "/work/a",
      },
      limit: 140,
    });

    expect(interest.queuedSessionIds).toEqual(["sess-a", "sess-a"]);
    await store.prefetchWorkspace("ws_local");

    expect(calls).toEqual([
      { sessionId: "sess-a", directory: "/work/b" },
      { sessionId: "sess-a", directory: "/work/a" },
    ]);
    expect(
      store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a", directory: "/work/a" })?.directory,
    ).toBe("/work/a");
    expect(
      store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a", directory: "/work/b" })?.directory,
    ).toBe("/work/b");
  });

  test("evicts least-recently-accessed entries when workspace cache is bounded", async () => {
    const store = createSessionTranscriptPrefetchStore({
      maxEntriesPerWorkspace: 2,
      loadTranscript: async ({ workspaceId, sessionId }) => ({
        workspaceId,
        sessionId,
        messages: [],
        partsByMessageId: {},
      }),
    });

    await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });
    await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-b", limit: 140 });
    await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-c", limit: 140 });

    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })).toBeNull();
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-b" })?.sessionId).toBe("sess-b");
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-c" })?.sessionId).toBe("sess-c");
    expect(store.debugCacheSessionIds("ws_local")).toEqual(["sess-b", "sess-c"]);
  });

  test("evicts least-recently-accessed entries when workspace cache exceeds byte budget", async () => {
    const store = createSessionTranscriptPrefetchStore({
      maxEntriesPerWorkspace: 10,
      maxBytesPerWorkspace: 1_500,
      loadTranscript: async ({ workspaceId, sessionId }) => ({
        workspaceId,
        sessionId,
        messages: [{ id: `message-${sessionId}`, text: "x".repeat(900) }],
        partsByMessageId: {},
      }),
    });

    await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });
    await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-b", limit: 140 });

    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })).toBeNull();
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-b" })?.sessionId).toBe("sess-b");
    expect(store.debugCacheSessionIds("ws_local")).toEqual(["sess-b"]);
  });

  test("joins lower and higher display requests on one source load", async () => {
    let calls = 0;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId, limit }) => {
        calls += 1;
        if (calls === 1) {
          await firstGate;
        }
        return {
          workspaceId,
          sessionId,
          messages: Array.from({ length: limit }, (_, index) => ({ id: `m-${index + 1}` })),
          partsByMessageId: {},
        };
      },
    });

    const low = store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 20 });
    await Promise.resolve();
    const high = store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 200 });

    releaseFirst();
    const [lowSnapshot, highSnapshot] = await Promise.all([low, high]);

    expect(calls).toBe(1);
    expect(lowSnapshot.limit).toBe(20);
    expect(lowSnapshot.messages.length).toBe(20);
    expect(highSnapshot.limit).toBe(200);
    expect(highSnapshot.messages.length).toBe(200);
  });

  test("serves a larger display view from the same warm source snapshot", async () => {
    let calls = 0;

    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId, limit }) => {
        calls += 1;
        return {
          workspaceId,
          sessionId,
          messages: Array.from({ length: limit }, (_, index) => ({ id: `m-${index + 1}` })),
          partsByMessageId: {},
        };
      },
      autoPrefetchOnInterest: false,
    });

    await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 20 });

    const interest = await store.updateInterest({
      workspaceId: "ws_local",
      clickedSessionId: null,
      selectedSessionId: "sess-a",
      loadedTopLevelSessionIds: ["sess-a"],
      expandedSubagentSessionIds: [],
      limit: 200,
    });

    expect(interest.items).toHaveLength(1);
    expect(interest.items[0]?.limit).toBe(200);
    expect(interest.items[0]?.messages).toHaveLength(200);
    expect(interest.queuedSessionIds).toEqual([]);
    expect(store.listWarmSnapshots({ workspaceId: "ws_local", sessionIds: ["sess-a"] })[0]?.limit).toBe(200);

    await store.prefetchWorkspace("ws_local");

    expect(calls).toBe(1);
    expect(
      store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a", limit: 200 })?.messages.length,
    ).toBe(200);
  });

  test("slices display messages and parts without reloading the 200-message source", async () => {
    let calls = 0;
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId, limit }) => {
        calls += 1;
        const messages = Array.from({ length: limit }, (_, index) => ({ id: `m-${index + 1}` }));
        return {
          workspaceId,
          sessionId,
          messages,
          partsByMessageId: Object.fromEntries(messages.map((message) => [message.id, [{ id: `p-${message.id}` }]])),
        };
      },
    });

    const first = await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });
    const later = await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 160 });

    expect(calls).toBe(1);
    expect(first.limit).toBe(140);
    expect(first.messages).toHaveLength(140);
    expect(Object.keys(first.partsByMessageId)).toHaveLength(140);
    expect(first.messages[0]).toEqual({ id: "m-61" });
    expect(later.limit).toBe(160);
    expect(later.messages).toHaveLength(160);
    expect(Object.keys(later.partsByMessageId)).toHaveLength(160);
    expect(later.messages[0]).toEqual({ id: "m-41" });
  });

  test("invalidates warm snapshots after a live host transcript append", async () => {
    let calls = 0;
    const store = createSessionTranscriptPrefetchStore({
      loadTranscript: async ({ workspaceId, sessionId }) => {
        calls += 1;
        return {
          workspaceId,
          sessionId,
          messages: [{ id: `m-${calls}` }],
          partsByMessageId: {},
        };
      },
    });

    const first = await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });
    expect(first.messages).toEqual([{ id: "m-1" }]);
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })?.messages).toEqual([
      { id: "m-1" },
    ]);

    store.invalidate({ workspaceId: "ws_local", sessionId: "sess-a" });
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })).toBeNull();

    const second = await store.getOrLoad({ workspaceId: "ws_local", sessionId: "sess-a", limit: 140 });
    expect(calls).toBe(2);
    expect(second.messages).toEqual([{ id: "m-2" }]);
  });
});
