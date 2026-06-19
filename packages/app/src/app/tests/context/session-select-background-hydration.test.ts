import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { createSessionStore } from "../../context/session.js";

function makeTestRouting(client: () => any) {
  return {
    active: client,
    client: () => client(),
    activeWorkspaceId: () => "test-workspace",
  } as any;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ok<T>(data: T) {
  return {
    data,
    request: new Request("http://localhost.test"),
    response: new Response(),
  };
}

const makeMessageInfo = (sessionID = "sess-a", messageID = "msg-1") => ({
  id: messageID,
  sessionID,
  role: "assistant" as const,
  time: { created: 1 },
  parentID: "",
  modelID: "",
  providerID: "",
  mode: "",
  agent: "",
  path: { cwd: "", root: "" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const makeTextPart = (sessionID = "sess-a", messageID = "msg-1"): Part => ({
  id: "part-1",
  sessionID,
  messageID,
  type: "text",
  text: "Hi",
  synthetic: false,
  ignored: false,
});

test("selectSession completes initial transcript load without waiting for health, todos, or permissions", async () => {
  const healthGate = deferred<ReturnType<typeof ok<Record<string, never>>>>();
  const messagesGate = deferred<ReturnType<typeof ok<Array<{ info: ReturnType<typeof makeMessageInfo>; parts: Part[] }>>>>();
  const todoGate = deferred<ReturnType<typeof ok<[]>>>();
  const permissionsGate = deferred<ReturnType<typeof ok<[]>>>();

  let healthCalls = 0;
  let messageCalls = 0;
  let todoCalls = 0;
  let permissionCalls = 0;

  await createRoot(async (dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
      let loadCompleteCount = 0;

      const clientFn = () =>
        ({
          global: {
            health: () => {
              healthCalls += 1;
              return healthGate.promise;
            },
          },
          session: {
            messages: () => {
              messageCalls += 1;
              return messagesGate.promise;
            },
            todo: () => {
              todoCalls += 1;
              return todoGate.promise;
            },
          },
          permission: {
            list: () => {
              permissionCalls += 1;
              return permissionsGate.promise;
            },
          },
        }) as any;
      const store = createSessionStore({
        client: clientFn,
        routing: makeTestRouting(clientFn),
        activeWorkspaceRoot: () => "",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
        onSessionLoadComplete: () => {
          loadCompleteCount += 1;
        },
      });

      const selectPromise = store.selectSession("sess-a");

      assert.equal(healthCalls, 0);
      assert.equal(messageCalls, 1);

      messagesGate.resolve(ok([{ info: makeMessageInfo(), parts: [makeTextPart()] }]));

      const initialLoad = await Promise.race([
        selectPromise.then(() => "resolved"),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50)),
      ]);

      assert.equal(initialLoad, "resolved");
      assert.equal(selectedSessionId(), "sess-a");
      assert.equal(store.getCachedTranscriptMessageCount("sess-a"), 1);
      assert.equal(loadCompleteCount, 1);

      // Optional background metadata fetches must not be part of the critical
      // transcript path. Resolve them after the load has completed so this
      // test stays focused on the user-visible hydration contract.
      healthGate.resolve(ok({}));
      todoGate.resolve(ok([]));
      permissionsGate.resolve(ok([]));
    } finally {
      dispose();
    }
  });
});

test("selectSession still completes the load lifecycle when no client is available", async () => {
  await createRoot(async (dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
      let loadCompleteCount = 0;

      const store = createSessionStore({
        client: () => null,
        routing: makeTestRouting(() => null),
        activeWorkspaceRoot: () => "",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
        onSessionLoadComplete: () => {
          loadCompleteCount += 1;
        },
      });

      await store.selectSession("sess-missing-client");

      assert.equal(selectedSessionId(), "sess-missing-client");
      assert.equal(loadCompleteCount, 1);
    } finally {
      dispose();
    }
  });
});

test("selectSession hydrates transcript from offline fallback when no client is available", async () => {
  await createRoot(async (dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
      let loadCompleteCount = 0;
      let offlineLoadCalls = 0;

      const store = createSessionStore({
        client: () => null,
        routing: makeTestRouting(() => null),
        activeWorkspaceRoot: () => "/tmp/prometheus",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
        onSessionLoadComplete: () => {
          loadCompleteCount += 1;
        },
        loadOfflineTranscript: async (sessionId: string, limit: number) => {
          offlineLoadCalls += 1;
          assert.equal(sessionId, "sess-offline");
          assert.equal(limit, 140);
          return {
            workspaceId: "ws-prometheus",
            sessionId,
            limit,
            fetchedAt: Date.now(),
            messages: [makeMessageInfo()],
            partsByMessageId: {
              "msg-1": [makeTextPart()],
            },
          };
        },
      } as any);

      await store.selectSession("sess-offline");

      assert.equal(selectedSessionId(), "sess-offline");
      assert.equal(offlineLoadCalls, 1);
      assert.equal(store.getCachedTranscriptMessageCount("sess-offline"), 1);
      assert.equal(loadCompleteCount, 1);
    } finally {
      dispose();
    }
  });
});

test("selectSession uses offline fallback for database browsing even when a client is available", async () => {
  await createRoot(async (dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
      let offlineLoadCalls = 0;
      let messageCalls = 0;
      const clientFn = () =>
        ({
          session: {
            messages: () => {
              messageCalls += 1;
              throw new Error("session.messages must not run for DB browsing");
            },
          },
        }) as any;

      const store = createSessionStore({
        client: clientFn,
        routing: makeTestRouting(clientFn),
        activeWorkspaceRoot: () => "/tmp/prometheus",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
        shouldBrowseSessionFromDb: (sessionId: string) => sessionId === "sess-db",
        loadOfflineTranscript: async (sessionId: string, limit: number) => {
          offlineLoadCalls += 1;
          return {
            workspaceId: "ws-prometheus",
            sessionId,
            limit,
            fetchedAt: Date.now(),
            messages: [makeMessageInfo()],
            partsByMessageId: {
              "msg-1": [makeTextPart()],
            },
          };
        },
      } as any);

      await store.selectSession("sess-db");

      assert.equal(selectedSessionId(), "sess-db");
      assert.equal(offlineLoadCalls, 1);
      assert.equal(messageCalls, 0);
      assert.equal(store.getCachedTranscriptMessageCount("sess-db"), 1);
    } finally {
      dispose();
    }
  });
});

test("selectSession reads scoped foreign workspace sessions from offline transcript instead of active client", async () => {
  await createRoot(async (dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
      let offlineLoadCalls = 0;
      let activeMessageCalls = 0;
      let foreignMessageCalls = 0;
      const clientLookups: string[] = [];
      const activeClient = {
        session: {
          messages: async () => {
            activeMessageCalls += 1;
            throw new Error("active workspace client must not read a foreign session");
          },
        },
      };
      const foreignClient = {
        session: {
          messages: async () => {
            foreignMessageCalls += 1;
            throw new Error("foreign workspace live client must not run for passive transcript browsing");
          },
        },
      };
      const routing = {
        active: () => activeClient,
        client: (workspaceId?: string) => {
          clientLookups.push(workspaceId ?? "");
          return workspaceId === "ws-b" ? foreignClient : activeClient;
        },
        activeWorkspaceId: () => "ws-a",
        entryIds: () => ["ws-a", "ws-b"],
      } as any;

      const store = createSessionStore({
        client: () => activeClient,
        routing,
        activeWorkspaceRoot: () => "/tmp/a",
        selectedSessionId,
        setSelectedSessionId,
        resolveSessionWorkspaceId: (sessionId: string) => (sessionId === "sess-b" ? "ws-b" : null),
        isWorkspaceRuntimeReady: () => true,
        shouldBrowseSessionFromDb: () => false,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
        loadOfflineTranscript: async (sessionId: string, limit: number) => {
          offlineLoadCalls += 1;
          assert.equal(sessionId, "sess-b");
          assert.equal(limit, 140);
          return {
            workspaceId: "ws-b",
            sessionId,
            limit,
            fetchedAt: Date.now(),
            messages: [makeMessageInfo(sessionId, "msg-b")],
            partsByMessageId: {
              "msg-b": [makeTextPart(sessionId, "msg-b")],
            },
          };
        },
      } as any);

      await store.selectSession("sess-b");

      assert.equal(selectedSessionId(), "sess-b");
      assert.deepEqual(clientLookups, ["ws-b"]);
      assert.equal(activeMessageCalls, 0);
      assert.equal(foreignMessageCalls, 0);
      assert.equal(offlineLoadCalls, 1);
      assert.equal(store.getCachedTranscriptMessageCount("sess-b"), 1);
    } finally {
      dispose();
    }
  });
});

test("selectSession falls back to offline transcript when live client reports session not found", async () => {
  await createRoot(async (dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
      let errorMessage: string | null = null;
      let messageCalls = 0;
      let offlineLoadCalls = 0;
      const clientFn = () =>
        ({
          session: {
            messages: async () => {
              messageCalls += 1;
              throw new Error(JSON.stringify({
                name: "NotFoundError",
                data: { message: "Session not found: sess-404" },
              }));
            },
            todo: async () => ok([]),
          },
          permission: {
            list: async () => ok([]),
          },
        }) as any;

      const store = createSessionStore({
        client: clientFn,
        routing: makeTestRouting(clientFn),
        activeWorkspaceRoot: () => "/tmp/a",
        selectedSessionId,
        setSelectedSessionId,
        resolveSessionWorkspaceId: (sessionId: string) => (sessionId === "sess-404" ? "test-workspace" : null),
        isWorkspaceRuntimeReady: () => true,
        shouldBrowseSessionFromDb: () => false,
        developerMode: () => false,
        setError: (message: string | null) => {
          errorMessage = message;
        },
        setSseConnected: () => {},
        loadOfflineTranscript: async (sessionId: string, limit: number) => {
          offlineLoadCalls += 1;
          return {
            workspaceId: "test-workspace",
            sessionId,
            limit,
            fetchedAt: Date.now(),
            messages: [makeMessageInfo(sessionId, "msg-404")],
            partsByMessageId: {
              "msg-404": [makeTextPart(sessionId, "msg-404")],
            },
          };
        },
      } as any);

      await store.selectSession("sess-404");

      assert.equal(selectedSessionId(), "sess-404");
      assert.equal(messageCalls, 1);
      assert.equal(offlineLoadCalls, 1);
      assert.equal(errorMessage, null);
      assert.equal(store.getCachedTranscriptMessageCount("sess-404"), 1);
    } finally {
      dispose();
    }
  });
});

test("re-selecting the same session while the first load is in flight still applies the transcript", async () => {
  const messagesGate = deferred<ReturnType<typeof ok<Array<{ info: ReturnType<typeof makeMessageInfo>; parts: Part[] }>>>>();
  let messageCalls = 0;

  await createRoot(async (dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);

      const clientFn = () =>
        ({
          session: {
            messages: () => {
              messageCalls += 1;
              return messagesGate.promise;
            },
            todo: async () => ok([]),
          },
          permission: {
            list: async () => ok([]),
          },
        }) as any;
      const store = createSessionStore({
        client: clientFn,
        routing: makeTestRouting(clientFn),
        activeWorkspaceRoot: () => "/tmp/veslo-fixture/ai discussion projects/Client data and offer descriptions/Prometheus",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
      });

      const first = store.selectSession("sess-a");
      const second = store.selectSession("sess-a");

      assert.equal(messageCalls, 1, "same-session re-select should not spawn a duplicate fetch");

      messagesGate.resolve(ok([{ info: makeMessageInfo(), parts: [makeTextPart()] }]));

      await Promise.all([first, second]);

      assert.equal(selectedSessionId(), "sess-a");
      assert.equal(store.getCachedTranscriptMessageCount("sess-a"), 1);
    } finally {
      dispose();
    }
  });
});
