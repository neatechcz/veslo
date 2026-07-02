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
  activeWorkspaceId?: string;
  clientByWorkspaceId?: Record<string, any>;
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
  appendTranscriptSnapshot?: (input: any) => Promise<void> | void;
  sessionWarn?: (label: string, payload?: unknown) => void;
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
  const [messageCompleteBySession, setMessageCompleteBySession] = createSignal<Record<string, boolean>>({});
  let refreshPermissionCalls = 0;
  const activeClient = options.activeClient ?? null;
  const activeWorkspaceId = options.activeWorkspaceId ?? "ws-a";
  const clientByWorkspaceId = options.clientByWorkspaceId ?? {};
  const routing = {
    active: () => activeClient,
    client: (workspaceId?: string) => {
      const id = workspaceId?.trim() ?? "";
      return id && Object.prototype.hasOwnProperty.call(clientByWorkspaceId, id)
        ? clientByWorkspaceId[id]
        : activeClient;
    },
    activeWorkspaceId: () => activeWorkspaceId,
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
    appendTranscriptSnapshot: options.appendTranscriptSnapshot,
    shouldBrowseSessionFromDb: options.shouldBrowseSessionFromDb,
    developerMode: () => false,
    setError: () => {},
    onSessionLoadComplete: () => {},
    sessionDebug: () => {},
    sessionWarn: options.sessionWarn ?? (() => {}),
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
      const foreignWorkspace = Boolean(workspaceId && workspaceId !== activeWorkspaceId);
      const runtimeReady = options.isWorkspaceRuntimeReady?.(workspaceId || activeWorkspaceId) ?? true;
      const configuredBrowseFromDb = options.shouldBrowseSessionFromDb?.(sessionID) ?? false;
      const liveRecoveryFromUnavailable = Boolean(
        configuredBrowseFromDb &&
        workspaceId &&
        activeWorkspaceId &&
        workspaceId === activeWorkspaceId &&
        runtimeReady &&
        !foreignWorkspace,
      );
      return {
        activeWorkspaceId,
        browseFromDb: configuredBrowseFromDb || !runtimeReady || foreignWorkspace,
        browseModeOnly: !runtimeReady,
        configuredBrowseFromDb,
        foreignWorkspace,
        liveRecoveryFromUnavailable,
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
    messageCompleteBySession,
    setMessageCompleteBySession: (value) => {
      if (typeof value === "function") setMessageCompleteBySession(value);
      else setMessageCompleteBySession(value);
    },
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
    messageCompleteBySession,
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
      const { controller, hydratedSnapshots, messageCompleteBySession } = makeController({
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
      assert.equal(controller.selectedSessionHistoryUnavailable(), null);
      assert.equal(messageCompleteBySession()["sess-empty"], true);
      assert.equal(controller.selectedSessionHasEarlierMessages(), false);
    } finally {
      dispose();
    }
  });
});

test("selectSession preserves explicit unavailable history without hydrating a fake transcript", async () => {
  await createRoot(async (dispose) => {
    try {
      let messageCalls = 0;
      const { controller, hydratedSnapshots, messageCompleteBySession } = makeController({
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
      assert.equal(messageCompleteBySession()["sess-unavailable"], undefined);
      assert.equal(controller.selectedSessionHistoryUnavailable()?.sessionId, "sess-unavailable");
      assert.equal(controller.selectedSessionHistoryUnavailable()?.reason, "source-unavailable");
      assert.equal(controller.selectedSessionHasEarlierMessages(), false);
    } finally {
      dispose();
    }
  });
});

test("selectSession recovers active scoped unavailable history from live OpenCode messages", async () => {
  await createRoot(async (dispose) => {
    try {
      const messageCalls: any[] = [];
      const liveMessages = [makeMessage("open-active", "msg-live")];
      const { controller, hydratedSnapshots, messageWrites, store } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-active",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-active" ? "ws-a" : null,
        activeClient: {
          session: {
            messages: async (input: any) => {
              messageCalls.push(input);
              return ok(liveMessages);
            },
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "unavailable",
          scope: {
            sessionId: sessionID,
            workspaceId: "ws-a",
            directory: "/repo",
            conversationId: "conv-active",
            opencodeSessionId: "open-active",
          },
          reason: "source-unavailable",
        }),
      });

      await controller.selectSession("conv-active");

      assert.deepEqual(messageCalls, [{ sessionID: "open-active", limit: 140 }]);
      assert.equal(hydratedSnapshots.length, 0);
      assert.equal(messageWrites.length, 1);
      assert.equal(messageWrites[0]?.sessionID, "conv-active");
      assert.deepEqual(store.messages["conv-active"], liveMessages.map((message) => message.info));
      assert.equal(store.messages["open-active"], undefined);
      assert.equal(controller.selectedSessionHistoryUnavailable(), null);
    } finally {
      dispose();
    }
  });
});

test("selectSession keeps active scoped unavailable history unavailable when live OpenCode is missing", async () => {
  await createRoot(async (dispose) => {
    try {
      const messageCalls: any[] = [];
      const { controller, hydratedSnapshots, messageWrites } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-missing",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-missing" ? "ws-a" : null,
        activeClient: {
          session: {
            messages: async (input: any) => {
              messageCalls.push(input);
              throw new Error("NotFoundError: Session not found");
            },
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "unavailable",
          scope: {
            sessionId: sessionID,
            workspaceId: "ws-a",
            directory: "/repo",
            conversationId: "conv-missing",
            opencodeSessionId: "open-missing",
          },
          reason: "source-unavailable",
        }),
      });

      await controller.selectSession("conv-missing");

      assert.deepEqual(messageCalls, [{ sessionID: "open-missing", limit: 140 }]);
      assert.equal(hydratedSnapshots.length, 0);
      assert.equal(messageWrites.length, 0);
      assert.equal(controller.selectedSessionHistoryUnavailable()?.sessionId, "conv-missing");
      assert.equal(controller.selectedSessionHistoryUnavailable()?.opencodeSessionId, "open-missing");
      assert.equal(controller.selectedSessionHasEarlierMessages(), false);
    } finally {
      dispose();
    }
  });
});

test("selectSession does not recover inactive scoped unavailable history through a foreign live client", async () => {
  await createRoot(async (dispose) => {
    try {
      let activeLiveCalls = 0;
      let foreignLiveCalls = 0;
      const { controller, hydratedSnapshots, messageWrites } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-foreign",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-foreign" ? "ws-b" : null,
        activeClient: {
          session: {
            messages: async () => {
              activeLiveCalls += 1;
              return ok([makeMessage("open-active")]);
            },
          },
        },
        clientByWorkspaceId: {
          "ws-b": {
            session: {
              messages: async () => {
                foreignLiveCalls += 1;
                return ok([makeMessage("open-foreign")]);
              },
            },
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "unavailable",
          scope: {
            sessionId: sessionID,
            workspaceId: "ws-b",
            directory: "/repo-b",
            conversationId: "conv-foreign",
            opencodeSessionId: "open-foreign",
          },
          reason: "source-unavailable",
        }),
      });

      await controller.selectSession("conv-foreign");

      assert.equal(activeLiveCalls, 0);
      assert.equal(foreignLiveCalls, 0);
      assert.equal(hydratedSnapshots.length, 0);
      assert.equal(messageWrites.length, 0);
      assert.equal(controller.selectedSessionHistoryUnavailable()?.sessionId, "conv-foreign");
      assert.equal(controller.selectedSessionHistoryUnavailable()?.workspaceId, "ws-b");
    } finally {
      dispose();
    }
  });
});

test("loadEarlierMessages continues active scoped unavailable history through live OpenCode messages", async () => {
  await createRoot(async (dispose) => {
    try {
      const messageCalls: any[] = [];
      const firstBatch = Array.from({ length: 140 }, (_, index) =>
        makeMessage("open-active-long", `msg-${index + 1}`),
      );
      const expandedBatch = Array.from({ length: 160 }, (_, index) =>
        makeMessage("open-active-long", `msg-${index + 1}`),
      );
      const { controller, store } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-active-long",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-active-long" ? "ws-a" : null,
        activeClient: {
          session: {
            messages: async (input: any) => {
              messageCalls.push(input);
              return ok(input.limit === 160 ? expandedBatch : firstBatch);
            },
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "unavailable",
          scope: {
            sessionId: sessionID,
            workspaceId: "ws-a",
            directory: "/repo",
            conversationId: "conv-active-long",
            opencodeSessionId: "open-active-long",
          },
          reason: "source-unavailable",
        }),
      });

      await controller.selectSession("conv-active-long");
      await controller.loadEarlierMessages("conv-active-long", 20);

      assert.deepEqual(messageCalls, [
        { sessionID: "open-active-long", limit: 140 },
        { sessionID: "open-active-long", limit: 160 },
      ]);
      assert.equal(store.messages["conv-active-long"]?.length, 160);
      assert.equal(store.messages["open-active-long"], undefined);
    } finally {
      dispose();
    }
  });
});

test("selectSession backfills active scoped live recovery under the OpenCode session id", async () => {
  await createRoot(async (dispose) => {
    try {
      const backfills: any[] = [];
      const liveMessage = makeMessage("open-backfill", "msg-live");
      liveMessage.parts = [{ id: "prt-live", type: "text", text: "hello" } as any];
      const { controller, store } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-backfill",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-backfill" ? "ws-a" : null,
        activeClient: {
          session: {
            messages: async () => ok([liveMessage]),
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "unavailable",
          scope: {
            sessionId: sessionID,
            workspaceId: "ws-a",
            directory: "/repo",
            conversationId: "conv-backfill",
            opencodeSessionId: "open-backfill",
          },
          reason: "source-unavailable",
        }),
        appendTranscriptSnapshot: async (input) => {
          backfills.push(input);
        },
      });

      await controller.selectSession("conv-backfill");

      assert.equal(store.messages["conv-backfill"]?.length, 1);
      assert.equal(backfills.length, 1);
      assert.equal(backfills[0]?.workspaceId, "ws-a");
      assert.equal(backfills[0]?.sessionId, "open-backfill");
      assert.equal(backfills[0]?.directory, "/repo");
      assert.equal(backfills[0]?.limit, 140);
      assert.equal(backfills[0]?.reason, "live-recovery");
      assert.deepEqual(backfills[0]?.messages, [liveMessage.info]);
      assert.deepEqual(backfills[0]?.partsByMessageId, { "msg-live": liveMessage.parts });
    } finally {
      dispose();
    }
  });
});

test("selectSession backfills empty active scoped live recovery", async () => {
  await createRoot(async (dispose) => {
    try {
      const backfills: any[] = [];
      const { controller, store } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-empty-backfill",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-empty-backfill" ? "ws-a" : null,
        activeClient: {
          session: {
            messages: async () => ok([]),
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "unavailable",
          scope: {
            sessionId: sessionID,
            workspaceId: "ws-a",
            directory: "/repo",
            conversationId: "conv-empty-backfill",
            opencodeSessionId: "open-empty-backfill",
          },
          reason: "source-unavailable",
        }),
        appendTranscriptSnapshot: async (input) => {
          backfills.push(input);
        },
      });

      await controller.selectSession("conv-empty-backfill");

      assert.deepEqual(store.messages["conv-empty-backfill"], []);
      assert.equal(backfills.length, 1);
      assert.equal(backfills[0]?.sessionId, "open-empty-backfill");
      assert.equal(backfills[0]?.reason, "live-recovery");
      assert.deepEqual(backfills[0]?.messages, []);
      assert.deepEqual(backfills[0]?.partsByMessageId, {});
    } finally {
      dispose();
    }
  });
});

test("selectSession keeps recovered live messages visible when backfill fails", async () => {
  await createRoot(async (dispose) => {
    try {
      const warnings: any[] = [];
      const liveMessages = [makeMessage("open-backfill-fail", "msg-live")];
      const { controller, store } = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-backfill-fail",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-backfill-fail" ? "ws-a" : null,
        activeClient: {
          session: {
            messages: async () => ok(liveMessages),
          },
        },
        loadOfflineTranscript: async (sessionID) => ({
          status: "unavailable",
          scope: {
            sessionId: sessionID,
            workspaceId: "ws-a",
            directory: "/repo",
            conversationId: "conv-backfill-fail",
            opencodeSessionId: "open-backfill-fail",
          },
          reason: "source-unavailable",
        }),
        appendTranscriptSnapshot: async () => {
          throw new Error("append failed");
        },
        sessionWarn: (label, payload) => warnings.push({ label, payload }),
      });

      await controller.selectSession("conv-backfill-fail");

      assert.deepEqual(store.messages["conv-backfill-fail"], liveMessages.map((message) => message.info));
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.label, "live-recovery-backfill:failed");
    } finally {
      dispose();
    }
  });
});

test("selectSession can later load the backfilled host transcript without another live read", async () => {
  await createRoot(async (dispose) => {
    try {
      let durableSnapshot: any = null;
      let liveCalls = 0;
      const liveMessages = [makeMessage("open-durable", "msg-live")];
      const loadOfflineTranscript = async (sessionID: string, limit: number) => {
        if (durableSnapshot) return { status: "loaded", snapshot: durableSnapshot };
        return {
          status: "unavailable",
          scope: {
            sessionId: sessionID,
            workspaceId: "ws-a",
            directory: "/repo",
            conversationId: "conv-durable",
            opencodeSessionId: "open-durable",
          },
          reason: "source-unavailable",
        };
      };
      const appendTranscriptSnapshot = async (input: any) => {
        durableSnapshot = {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          directory: input.directory,
          limit: input.limit,
          fetchedAt: 2,
          messages: input.messages,
          partsByMessageId: input.partsByMessageId,
          source: "sqlite",
          conversationId: "conv-durable",
          opencodeSessionId: "open-durable",
        };
      };

      const first = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-durable",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-durable" ? "ws-a" : null,
        activeClient: {
          session: {
            messages: async () => {
              liveCalls += 1;
              return ok(liveMessages);
            },
          },
        },
        loadOfflineTranscript,
        appendTranscriptSnapshot,
      });
      await first.controller.selectSession("conv-durable");

      const second = makeController({
        shouldBrowseSessionFromDb: (sessionID) => sessionID === "conv-durable",
        resolveSessionWorkspaceId: (sessionID) => sessionID === "conv-durable" ? "ws-a" : null,
        activeClient: {
          session: {
            messages: async () => {
              liveCalls += 1;
              return ok([]);
            },
          },
        },
        loadOfflineTranscript,
        appendTranscriptSnapshot,
      });
      await second.controller.selectSession("conv-durable");

      assert.equal(liveCalls, 1);
      assert.equal(second.hydratedSnapshots.length, 1);
      assert.equal(second.hydratedSnapshots[0]?.sessionId, "conv-durable");
      assert.equal(second.hydratedSnapshots[0]?.opencodeSessionId, "open-durable");
      assert.deepEqual(second.store.messages["conv-durable"], liveMessages.map((message) => message.info));
      assert.equal(second.store.messages["open-durable"], undefined);
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
