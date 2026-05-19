import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { createSessionStore } from "./session.js";
import { createWorkspaceRouting } from "./workspace-routing.js";

function makeTestRouting(client: () => any) {
  return createWorkspaceRouting({
    mode: () => "single-active",
    clientSource: client,
    activeWorkspaceId: () => "test-workspace",
  });
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

const makeMessageInfo = () => ({
  id: "msg-1",
  sessionID: "sess-a",
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

const makeTextPart = (): Part => ({
  id: "part-1",
  sessionID: "sess-a",
  messageID: "msg-1",
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

      healthGate.resolve(ok({}));
      todoGate.resolve(ok([]));
      permissionsGate.resolve(ok([]));

      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(todoCalls, 1);
      assert.equal(permissionCalls, 1);
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
        activeWorkspaceRoot: () => "/Users/vaclavsoukup/ai discussion projects/Client data and offer descriptions/Prometheus",
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
