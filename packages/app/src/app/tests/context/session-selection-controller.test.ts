import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { Session } from "@opencode-ai/sdk/v2/client";

import { createSessionSelectionController } from "../../context/session-selection-controller.js";
import type { MessageInfo, MessageWithParts, TodoItem } from "../../types";

function ok<T>(data: T) {
  return {
    data,
    request: new Request("http://localhost.test"),
    response: new Response(),
  };
}

function makeSession(id: string, directory = "/repo", created = 1): Session {
  return {
    id,
    title: id,
    directory,
    time: { created },
  } as Session;
}

function makeMessage(sessionID = "sess-a", messageID = "msg-a"): MessageWithParts {
  const info = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "",
    agent: "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageInfo;
  return { info, parts: [] };
}

function makeTranscriptSnapshot(
  sessionID: string,
  messages: MessageInfo[] = [makeMessage(sessionID).info],
) {
  return {
    workspaceId: "ws-a",
    sessionId: sessionID,
    limit: 140,
    fetchedAt: 1,
    messages,
    partsByMessageId: {},
    source: "sqlite" as const,
  };
}

function makeController(options: {
  activeClient?: any;
  selectedSessionId?: string | null;
  conversationReader?: () => {
    listConversations: (
      workspaceId: string,
      directory?: string,
      options?: { sync?: boolean },
    ) => Promise<{ items: Session[]; source?: "sqlite" | "unavailable" }>;
  } | null;
  isWorkspaceRuntimeReady?: (workspaceId?: string | null) => boolean;
  shouldBrowseSessionFromDb?: (sessionId: string) => boolean;
  loadOfflineTranscript?: (sessionID: string, limit: number) => Promise<any>;
  resolveSessionWorkspaceId?: (sessionID: string) => string | null;
} = {}) {
  const [store, setStore] = createStore({
    sessions: [] as Session[],
    sessionStatus: {} as Record<string, string>,
    messages: {} as Record<string, MessageInfo[]>,
    parts: {},
    todos: {} as Record<string, TodoItem[]>,
  });
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    options.selectedSessionId === undefined ? null : options.selectedSessionId,
  );
  const workspaceSessionIds = new Set<string>();
  const hydratedSnapshots: any[] = [];
  const messageWrites: Array<{ sessionID: string; messages: MessageWithParts[] }> = [];
  let refreshPermissionCalls = 0;
  const activeClient = options.activeClient ?? null;
  const routing = {
    active: () => activeClient,
    client: (workspaceId?: string) => (workspaceId === "ws-b" ? activeClient : activeClient),
    activeWorkspaceId: () => "ws-a",
  };

  const controller = createSessionSelectionController({
    store,
    setStore: setStore as any,
    routing: routing as any,
    selectedSessionId,
    setSelectedSessionId,
    selectSessionScopeKey: undefined,
    directoryQueryPathMode: () => "auto",
    conversationReader: options.conversationReader,
    loadOfflineTranscript: options.loadOfflineTranscript,
    shouldBrowseSessionFromDb: options.shouldBrowseSessionFromDb,
    developerMode: () => false,
    setError: () => {},
    onSessionLoadComplete: () => {},
    sessionDebug: () => {},
    addError: (error) => {
      throw error;
    },
    withTimeout: async (promise) => promise,
    isWorkspaceRuntimeReady: options.isWorkspaceRuntimeReady ?? (() => true),
    clientForSession: (sessionID) => {
      const workspaceId = options.resolveSessionWorkspaceId?.(sessionID)?.trim() ?? "";
      return { workspaceId, client: workspaceId ? routing.client(workspaceId) : routing.active() };
    },
    sessionReadPolicy: (sessionID, workspaceId) => {
      const foreignWorkspace = Boolean(workspaceId && workspaceId !== "ws-a");
      const runtimeReady = options.isWorkspaceRuntimeReady?.(workspaceId || "ws-a") ?? true;
      const configuredBrowseFromDb = options.shouldBrowseSessionFromDb?.(sessionID) ?? false;
      return {
        activeWorkspaceId: "ws-a",
        browseFromDb: configuredBrowseFromDb || !runtimeReady || foreignWorkspace,
        browseModeOnly: !runtimeReady,
        configuredBrowseFromDb,
        foreignWorkspace,
        sessionWorkspaceId: workspaceId,
      };
    },
    isSessionNotFoundError: (error) =>
      /Session not found|NotFoundError|status\W*404|\b404\b/i.test(
        error instanceof Error ? error.message : String(error),
      ),
    sessionDirectoryOverrides: () => ({}),
    applySessionDirectoryOverride: (session) => session,
    resolveSessionDirectory: (session) => session.directory ?? "",
    readStatusForSession: (sessionID) => store.sessionStatus[sessionID ?? ""] ?? "idle",
    workspaceSessionIds,
    setMessagesForSession: (sessionID, messages) => {
      messageWrites.push({ sessionID, messages });
      setStore("messages", sessionID, messages.map((message) => message.info));
    },
    hydrateTranscriptSnapshot: (snapshot) => {
      hydratedSnapshots.push(snapshot);
      setStore("messages", snapshot.sessionId, snapshot.messages);
    },
    messageLimitBySession: () => ({}),
    setMessageLimitBySession: () => {},
    messageCompleteBySession: () => ({}),
    setMessageCompleteBySession: () => {},
    messageLoadBusyBySession: () => ({}),
    setMessageLoadBusyBySession: () => {},
    refreshPendingPermissions: async () => {
      refreshPermissionCalls += 1;
    },
  });

  return {
    controller,
    store,
    selectedSessionId,
    workspaceSessionIds,
    hydratedSnapshots,
    messageWrites,
    refreshPermissionCalls: () => refreshPermissionCalls,
  };
}

test("loadSessions prefers conversation reader and avoids SDK list when reader has data", async () => {
  await createRoot(async (dispose) => {
    try {
      let sdkListCalls = 0;
      let readerCalls = 0;
      const activeClient = {
        session: {
          list: async () => {
            sdkListCalls += 1;
            return ok([makeSession("sdk")]);
          },
        },
      };
      const { controller, store, workspaceSessionIds } = makeController({
        activeClient,
        conversationReader: () => ({
          listConversations: async () => {
            readerCalls += 1;
            return { items: [makeSession("from-reader")], source: "sqlite" };
          },
        }),
      });

      await controller.loadSessions("/repo");

      assert.equal(readerCalls, 1);
      assert.equal(sdkListCalls, 0);
      assert.deepEqual(store.sessions.map((session) => session.id), ["from-reader"]);
      assert.deepEqual(Array.from(workspaceSessionIds), ["from-reader"]);
    } finally {
      dispose();
    }
  });
});

test("loadSessions retains the selected session while a delayed list misses it", async () => {
  await createRoot(async (dispose) => {
    try {
      const selected = makeSession("selected", "/repo", 10);
      const { controller, store } = makeController({
        selectedSessionId: "selected",
        activeClient: {
          session: {
            list: async () => ok([makeSession("other", "/repo", 1)]),
          },
        },
      });
      store.sessions.push(selected);

      await controller.loadSessions("/repo");

      assert.deepEqual(store.sessions.map((session) => session.id), ["selected", "other"]);
    } finally {
      dispose();
    }
  });
});

test("selectSession uses offline fallback for browse policy instead of live messages", async () => {
  await createRoot(async (dispose) => {
    try {
      let messageCalls = 0;
      let offlineCalls = 0;
      const { controller, selectedSessionId, hydratedSnapshots } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "sess-db",
        activeClient: {
          session: {
            messages: async () => {
              messageCalls += 1;
              return ok([makeMessage("sess-db")]);
            },
          },
        },
        loadOfflineTranscript: async (sessionID, limit) => {
          offlineCalls += 1;
          return {
            workspaceId: "ws-a",
            sessionId: sessionID,
            limit,
            fetchedAt: 1,
            messages: [makeMessage(sessionID).info],
            partsByMessageId: {},
          };
        },
      });

      await controller.selectSession("sess-db");

      assert.equal(selectedSessionId(), "sess-db");
      assert.equal(messageCalls, 0);
      assert.equal(offlineCalls, 1);
      assert.equal(hydratedSnapshots.length, 1);
    } finally {
      dispose();
    }
  });
});

test("selectSession hydrates explicit loaded history results", async () => {
  await createRoot(async (dispose) => {
    try {
      const { controller, hydratedSnapshots } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "sess-loaded",
        activeClient: {
          session: {
            messages: async () => ok([makeMessage("sess-loaded")]),
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "loaded",
          snapshot: makeTranscriptSnapshot(sessionID),
        }),
      });

      await controller.selectSession("sess-loaded");

      assert.equal(hydratedSnapshots.length, 1);
      assert.equal(hydratedSnapshots[0]?.sessionId, "sess-loaded");
      assert.equal(hydratedSnapshots[0]?.messages.length, 1);
    } finally {
      dispose();
    }
  });
});

test("selectSession treats explicit empty history as loaded state", async () => {
  await createRoot(async (dispose) => {
    try {
      const { controller, hydratedSnapshots } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "sess-empty",
        loadOfflineTranscript: async (sessionID) => ({
          status: "empty",
          snapshot: makeTranscriptSnapshot(sessionID, []),
        }),
      });

      await controller.selectSession("sess-empty");

      assert.equal(hydratedSnapshots.length, 1);
      assert.equal(hydratedSnapshots[0]?.sessionId, "sess-empty");
      assert.deepEqual(hydratedSnapshots[0]?.messages, []);
    } finally {
      dispose();
    }
  });
});

test("selectSession preserves explicit unavailable history without hydrating a fake transcript", async () => {
  await createRoot(async (dispose) => {
    try {
      let messageCalls = 0;
      const { controller, hydratedSnapshots } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "sess-unavailable",
        activeClient: {
          session: {
            messages: async () => {
              messageCalls += 1;
              return ok([makeMessage("sess-unavailable")]);
            },
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "unavailable",
          scope: { sessionId: sessionID, workspaceId: "ws-a", directory: "/repo" },
          reason: "source-unavailable",
        }),
      });

      await controller.selectSession("sess-unavailable");

      assert.equal(hydratedSnapshots.length, 0);
      assert.equal(messageCalls, 0, "CHR01 should preserve host-first behavior; CHR02 owns live fallback");
    } finally {
      dispose();
    }
  });
});

test("selectSession falls back to offline transcript when live messages report not found", async () => {
  await createRoot(async (dispose) => {
    try {
      let offlineCalls = 0;
      const { controller, selectedSessionId, hydratedSnapshots } = makeController({
        activeClient: {
          session: {
            messages: async () => {
              throw new Error("NotFoundError: Session not found");
            },
            todo: async () => ok([]),
          },
          permission: {
            list: async () => ok([]),
          },
        },
        loadOfflineTranscript: async (sessionID, limit) => {
          offlineCalls += 1;
          return {
            workspaceId: "ws-a",
            sessionId: sessionID,
            limit,
            fetchedAt: 1,
            messages: [makeMessage(sessionID).info],
            partsByMessageId: {},
          };
        },
      });

      await controller.selectSession("sess-404");

      assert.equal(selectedSessionId(), "sess-404");
      assert.equal(offlineCalls, 1);
      assert.equal(hydratedSnapshots.length, 1);
    } finally {
      dispose();
    }
  });
});

test("renameSession trims title and updates through the owning workspace client", async () => {
  await createRoot(async (dispose) => {
    try {
      const updates: any[] = [];
      const { controller, store } = makeController({
        activeClient: {
          session: {
            update: async (input: any) => {
              updates.push(input);
              return ok(makeSession(input.sessionID, "/repo", 2));
            },
          },
        },
      });

      await controller.renameSession("sess-a", "  New title  ");

      assert.deepEqual(updates, [{ sessionID: "sess-a", title: "New title" }]);
      assert.deepEqual(store.sessions.map((session) => session.id), ["sess-a"]);
    } finally {
      dispose();
    }
  });
});
