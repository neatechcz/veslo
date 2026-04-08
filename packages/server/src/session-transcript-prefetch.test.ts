import { describe, expect, test } from "bun:test";
import { createSessionTranscriptPrefetchStore } from "./session-transcript-prefetch.js";

describe("session transcript prefetch core", () => {
  test("prioritizes selected session and deduplicates queue order", async () => {
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
      visibleSessionIds: ["sess-b", "sess-c", "sess-b", " ", "sess-a"],
      selectedSessionId: "sess-a",
      limit: 140,
    });

    expect(store.debugQueue("ws_local")).toEqual(["sess-a", "sess-b", "sess-c"]);
    expect(result.queuedSessionIds).toEqual(["sess-a", "sess-b", "sess-c"]);
    expect(result.items).toEqual([]);
  });

  test("deduplicates in-flight loads for the same workspace/session", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
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

    release?.();
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

    expect(calls).toBe(1);
    expect(s1.sessionId).toBe("sess-a");
    expect(s2.sessionId).toBe("sess-a");
    expect(s3.sessionId).toBe("sess-a");
    expect(store.getWarmSnapshot({ workspaceId: "ws_local", sessionId: "sess-a" })?.sessionId).toBe("sess-a");
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

  test("does not let a lower-limit in-flight load satisfy a higher-limit caller", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | null = null;
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

    releaseFirst?.();
    const [, highSnapshot] = await Promise.all([low, high]);

    expect(calls).toBe(2);
    expect(highSnapshot.limit).toBe(200);
    expect(highSnapshot.messages.length).toBe(200);
  });
});
