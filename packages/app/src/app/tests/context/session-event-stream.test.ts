import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";

import {
  createSessionEventStreamController,
  isPermissionRefreshEvent,
  isQuestionRefreshEvent,
} from "../../context/session-event-stream.js";
import type { MessageInfo, OpencodeEvent, SessionErrorTurn, TodoItem } from "../../types";

function makeStore() {
  return createStore({
    sessions: [] as any[],
    sessionStatus: {} as Record<string, string>,
    sessionErrorTurns: {} as Record<string, SessionErrorTurn[]>,
    messages: {} as Record<string, MessageInfo[]>,
    parts: {} as Record<string, any[]>,
    commandDisplayByMessageID: {} as Record<string, string>,
    todos: {} as Record<string, TodoItem[]>,
    pendingPermissions: [],
    pendingQuestions: [],
    events: [] as Array<{ type: string; properties?: unknown }>,
  });
}

function makeMessage(sessionID: string, id = "msg-a", role = "assistant") {
  return {
    id,
    sessionID,
    role,
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
}

function makeTextPart(sessionID: string, messageID = "msg-a", id = "part-a", text = "") {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
  };
}

type SendWorkflowTraceTestWindow = {
  __vesloSendWorkflowTraceEnabled?: boolean;
  __vesloSendWorkflowTrace?: Array<Record<string, unknown>>;
  __vesloSendWorkflowTraceSeq?: number;
};

function withSendWorkflowTraceWindow(
  run: (target: SendWorkflowTraceTestWindow) => void | Promise<void>,
) {
  return async () => {
    const root = globalThis as unknown as Record<string, unknown>;
    const hadWindow = Object.prototype.hasOwnProperty.call(root, "window");
    const previousWindow = root.window;
    const target: SendWorkflowTraceTestWindow = {
      __vesloSendWorkflowTraceEnabled: true,
    };
    root.window = target;

    try {
      await run(target);
    } finally {
      if (!hadWindow) {
        Reflect.deleteProperty(root, "window");
      } else {
        root.window = previousWindow;
      }
    }
  };
}

function makeController(options: {
  activeWorkspaceId?: string;
  selectedSessionId?: string | null;
  developerMode?: boolean;
  workspaceSessionIds?: Set<string>;
  observer?: (sessionID: string) => void;
  transcriptIngest?: Array<Record<string, unknown>>;
  backgroundIngest?: Array<Record<string, unknown>>;
  permissionRefreshes?: string[];
  questionRefreshes?: string[];
  statusTraces?: Array<{ event: string; payload?: Record<string, unknown> }>;
  setSseConnected?: (connected: boolean) => void;
  setMessagesForSession?: (sessionID: string, list: Array<{ info: MessageInfo; parts: any[] }>) => void;
  routing?: any;
  client?: () => any;
  recoverWorkspaceRuntimeForEventStream?: (workspaceId: string) => Promise<boolean> | boolean;
  sessionErrorTurns?: Array<{ sessionID: string; text: string }>;
} = {}) {
  const [store, setStore] = makeStore();
  const workspaceSessionIds = options.workspaceSessionIds ?? new Set<string>();
  const transcriptIngest = options.transcriptIngest ?? [];
  const backgroundIngest = options.backgroundIngest ?? [];
  const permissionRefreshes = options.permissionRefreshes ?? [];
  const questionRefreshes = options.questionRefreshes ?? [];
  const busyCalls: Array<{ sessionID: string; status: string; workspaceId?: string }> = [];

  const controller = createSessionEventStreamController({
    store,
    setStore: setStore as any,
    routing: options.routing ?? {
      activeWorkspaceId: () => options.activeWorkspaceId ?? "ws-a",
      active: () => null,
      client: () => null,
      entry: () => null,
      entryIds: () => [],
      release: () => {},
    } as any,
    client: options.client ?? (() => null),
    activeWorkspaceRoot: () => "/repo",
    selectedSessionId: () => options.selectedSessionId ?? "sess-a",
    developerMode: () => options.developerMode ?? false,
    setError: () => {},
    setSseConnected: options.setSseConnected ?? (() => {}),
    onAssistantResponseObserved: options.observer,
    sessionDebugEnabled: () => options.developerMode ?? false,
    sessionWarn: () => {},
    recordSessionStatusTrace: (event, payload) => {
      options.statusTraces?.push({ event, payload });
    },
    readStatusForSession: (sessionID, workspaceId) =>
      store.sessionStatus[`${workspaceId ?? ""}:${sessionID ?? ""}`] ?? "idle",
    setSessionStatusForWorkspace: (sessionID, status, workspaceId) => {
      if (!sessionID) return;
      setStore("sessionStatus", `${workspaceId ?? ""}:${sessionID}`, status);
    },
    notifySessionBusy: (sessionID, status, workspaceId) => {
      busyCalls.push({ sessionID, status, workspaceId: workspaceId ?? undefined });
    },
    workspaceSessionIds,
    applySessionDirectoryOverride: (session) => session,
    resolveSessionDirectory: (session) => session.directory ?? "",
    appendSessionErrorTurn: (sessionID, text) => {
      options.sessionErrorTurns?.push({ sessionID, text });
    },
    setCommandDisplay: () => {},
    recordSyntheticContinueDiagnostic: () => {},
    maybeMarkReloadRequired: () => {},
    maybeHandleInvalidToolError: () => {},
    maybeHandleChromeMcpCompletedError: () => {},
    resolveTranscriptIngestWorkspaceId: (sourceWsId) => sourceWsId || "ws-a",
    resolveSessionIdForMessage: () => null,
    recordPendingTranscriptMessageDeletion: () => {},
    recordPendingTranscriptPartDeletion: () => {},
    scheduleTranscriptIngestion: (sessionID, sourceWsId, reason, delayMs) => {
      transcriptIngest.push({ sessionID, sourceWsId, reason, delayMs });
    },
    scheduleBackgroundTranscriptIngestion: (sessionID, workspaceId, reason, delayMs) => {
      backgroundIngest.push({ sessionID, workspaceId, reason, delayMs });
    },
    messageLimitBySession: () => ({}),
    setMessagesForSession: options.setMessagesForSession ?? (() => {}),
    setMessageLimitBySession: () => {},
    setMessageCompleteBySession: () => {},
    refreshPendingPermissions: async () => {
      permissionRefreshes.push("permissions");
    },
    refreshPendingQuestions: async () => {
      questionRefreshes.push("questions");
    },
    withTimeout: async (promise) => promise,
    isWorkspaceRuntimeReady: () => true,
    isActiveWorkspaceRuntimeReady: () => true,
    recoverWorkspaceRuntimeForEventStream: options.recoverWorkspaceRuntimeForEventStream,
  });

  return {
    controller,
    store,
    setStore,
    workspaceSessionIds,
    busyCalls,
    transcriptIngest,
    backgroundIngest,
    permissionRefreshes,
    questionRefreshes,
  };
}

async function tick(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function makeEventClient(
  subscribe: (options: { signal: AbortSignal }) => Promise<{ stream: AsyncIterable<OpencodeEvent> }>,
) {
  return {
    event: {
      subscribe: (_input?: unknown, options?: { signal?: AbortSignal }) =>
        subscribe({ signal: options?.signal ?? new AbortController().signal }),
    },
  } as any;
}

function ok<T>(data: T) {
  return {
    data,
    request: new Request("http://localhost.test"),
    response: new Response(),
  };
}

test("permission and question refresh predicates include legacy and v2 event names", () => {
  for (const type of ["permission.asked", "permission.replied", "permission.v2.asked", "permission.v2.replied"]) {
    assert.equal(isPermissionRefreshEvent(type), true, type);
  }
  for (const type of [
    "question.asked",
    "question.replied",
    "question.rejected",
    "question.v2.asked",
    "question.v2.replied",
    "question.v2.rejected",
  ]) {
    assert.equal(isQuestionRefreshEvent(type), true, type);
  }
  assert.equal(isPermissionRefreshEvent("permission.unrelated"), false);
  assert.equal(isQuestionRefreshEvent("question.unrelated"), false);
});

test("background events update scoped runtime state without mutating active messages", async () => {
  await createRoot(async (dispose) => {
    try {
      const { controller, store, busyCalls, backgroundIngest, permissionRefreshes, questionRefreshes } =
        makeController({ activeWorkspaceId: "ws-a" });

      await controller.applyEvent(
        {
          type: "session.status",
          properties: { sessionID: "sess-b", status: "running" },
        } as OpencodeEvent,
        "ws-b",
      );
      await controller.applyEvent(
        {
          type: "message.updated",
          properties: { info: makeMessage("sess-b", "msg-b") },
        } as OpencodeEvent,
        "ws-b",
      );
      await controller.applyEvent(
        {
          type: "message.part.updated",
          properties: { part: makeTextPart("sess-b", "msg-b", "part-b", "background") },
        } as OpencodeEvent,
        "ws-b",
      );
      await controller.applyEvent({ type: "permission.asked", properties: {} } as OpencodeEvent, "ws-b");
      await controller.applyEvent({ type: "question.asked", properties: {} } as OpencodeEvent, "ws-b");
      await controller.applyEvent({ type: "permission.v2.asked", properties: {} } as OpencodeEvent, "ws-b");
      await controller.applyEvent({ type: "question.v2.asked", properties: {} } as OpencodeEvent, "ws-b");

      assert.equal(store.sessionStatus["ws-b:sess-b"], "running");
      assert.deepEqual(busyCalls, [{ sessionID: "sess-b", status: "running", workspaceId: "ws-b" }]);
      assert.deepEqual(store.messages, {});
      assert.deepEqual(backgroundIngest, [
        {
          sessionID: "sess-b",
          workspaceId: "ws-b",
          reason: "background message.updated",
          delayMs: undefined,
        },
        {
          sessionID: "sess-b",
          workspaceId: "ws-b",
          reason: "background message.part.updated",
          delayMs: undefined,
        },
      ]);
      assert.deepEqual(permissionRefreshes, ["permissions", "permissions"]);
      assert.deepEqual(questionRefreshes, ["questions", "questions"]);
    } finally {
      dispose();
    }
  });
});

test("foreground stream accepts message and part events before session list hydration", async () => {
  await createRoot(async (dispose) => {
    try {
      const observed: string[] = [];
      const transcriptIngest: Array<Record<string, unknown>> = [];
      const { controller, store, workspaceSessionIds } = makeController({
        activeWorkspaceId: "ws-a",
        selectedSessionId: "sess-other",
        observer: (sessionID) => observed.push(sessionID),
        transcriptIngest,
      });

      await controller.applyEvent(
        {
          type: "message.updated",
          properties: { info: makeMessage("sess-late", "msg-late") },
        } as OpencodeEvent,
        "ws-a",
      );
      await controller.applyEvent(
        {
          type: "message.part.updated",
          properties: { part: makeTextPart("sess-late", "msg-late", "part-late", "late text") },
        } as OpencodeEvent,
        "ws-a",
      );

      assert.equal(workspaceSessionIds.has("sess-late"), true);
      assert.deepEqual(store.messages["sess-late"].map((message) => message.id), ["msg-late"]);
      assert.equal(store.parts["msg-late"]?.find((part) => part.id === "part-late")?.text, "late text");
      assert.deepEqual(observed, ["sess-late"]);
      assert.deepEqual(
        transcriptIngest.map((entry) => entry.reason),
        ["message.updated", "message.part.updated"],
      );
    } finally {
      dispose();
    }
  });
});

test("active message updates report assistant responses only after accepting the session", async () => {
  await createRoot(async (dispose) => {
    try {
      const observed: string[] = [];
      const { controller, store } = makeController({
        workspaceSessionIds: new Set(["sess-a"]),
        observer: (sessionID) => observed.push(sessionID),
      });

      await controller.applyEvent(
        {
          type: "message.updated",
          properties: { info: makeMessage("unknown-session", "msg-unknown") },
        } as OpencodeEvent,
      );
      await controller.applyEvent(
        {
          type: "message.updated",
          properties: { info: makeMessage("sess-a", "msg-a") },
        } as OpencodeEvent,
      );
      await controller.applyEvent(
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-a",
              sessionID: "sess-a",
              messageID: "msg-a",
              type: "text",
              text: "hello",
            },
          },
        } as OpencodeEvent,
      );

      assert.deepEqual(store.messages["sess-a"].map((message) => message.id), ["msg-a"]);
      assert.deepEqual(observed, ["sess-a"]);
    } finally {
      dispose();
    }
  });
});

test("queued SSE text deltas for the same part are not coalesced before flush", async () => {
  await createRoot(async (dispose) => {
    try {
      const { controller, setStore, store } = makeController({
        workspaceSessionIds: new Set(["sess-a"]),
      });
      setStore("messages", "sess-a", [makeMessage("sess-a", "msg-a")]);
      setStore("parts", "msg-a", [makeTextPart("sess-a")]);

      const events: OpencodeEvent[] = ["Hel", "lo", "!"].map((delta) => ({
        type: "message.part.updated",
        properties: {
          delta,
          part: makeTextPart("sess-a", "msg-a", "part-a", delta),
        },
      } as OpencodeEvent));
      const client = makeEventClient(async () => ({
        stream: (async function* () {
          for (const event of events) yield event;
          await new Promise<void>(() => {});
        })(),
      }));

      const cleanup = controller.setupSseStream("ws-a", client);
      await tick(8);
      cleanup();

      assert.equal(store.parts["msg-a"]?.find((part) => part.id === "part-a")?.text, "Hello!");
    } finally {
      dispose();
    }
  });
});

test("queued SSE full part snapshots for the same part are still coalesced", async () => {
  await createRoot(async (dispose) => {
    try {
      const transcriptIngest: Array<Record<string, unknown>> = [];
      const { controller, setStore, store } = makeController({
        workspaceSessionIds: new Set(["sess-a"]),
        transcriptIngest,
      });
      setStore("messages", "sess-a", [makeMessage("sess-a", "msg-a")]);

      const events: OpencodeEvent[] = ["partial", "complete"].map((text) => ({
        type: "message.part.updated",
        properties: {
          part: makeTextPart("sess-a", "msg-a", "part-a", text),
        },
      } as OpencodeEvent));
      const client = makeEventClient(async () => ({
        stream: (async function* () {
          for (const event of events) yield event;
          await new Promise<void>(() => {});
        })(),
      }));

      const cleanup = controller.setupSseStream("ws-a", client);
      await tick(8);
      cleanup();

      assert.equal(store.parts["msg-a"]?.find((part) => part.id === "part-a")?.text, "complete");
      assert.equal(transcriptIngest.length, 1);
      assert.equal(transcriptIngest[0]?.reason, "message.part.updated");
    } finally {
      dispose();
    }
  });
});

test("session SSE cleanup closes the active subscription handle", async () => {
  const { controller } = makeController();
  const closes: string[] = [];
  const client = makeEventClient(async () => ({
    stream: (async function* () {
      yield { type: "server.connected" } as OpencodeEvent;
      await new Promise<void>(() => {});
    })(),
    close: async () => {
      closes.push("closed");
    },
  } as any));

  const cleanup = controller.setupSseStream("ws-a", client);
  await tick(4);
  cleanup();
  await tick(4);

  assert.deepEqual(closes, ["closed"]);
});

test("session SSE closes a subscription handle after stream end before reconnect", async () => {
  const { controller } = makeController();
  let closeCount = 0;
  const client = makeEventClient(async () => ({
    stream: (async function* () {})(),
    close: async () => {
      closeCount += 1;
    },
  } as any));

  const cleanup = controller.setupSseStream("ws-a", client);
  await tick(4);

  assert.equal(closeCount, 1);
  cleanup();
});

test(
  "text part trace records assistant updates only for assistant messages",
  withSendWorkflowTraceWindow(async (traceWindow) => {
    await createRoot(async (dispose) => {
      try {
        const { controller } = makeController({
          workspaceSessionIds: new Set(["sess-a"]),
        });

        await controller.applyEvent(
          {
            type: "message.updated",
            properties: { info: makeMessage("sess-a", "msg-user", "user") },
          } as OpencodeEvent,
          "ws-a",
        );
        await controller.applyEvent(
          {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part-user",
                sessionID: "sess-a",
                messageID: "msg-user",
                type: "text",
                text: "hello from user",
              },
            },
          } as OpencodeEvent,
          "ws-a",
        );
        await controller.applyEvent(
          {
            type: "message.updated",
            properties: { info: makeMessage("sess-a", "msg-assistant", "assistant") },
          } as OpencodeEvent,
          "ws-a",
        );
        await controller.applyEvent(
          {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part-assistant",
                sessionID: "sess-a",
                messageID: "msg-assistant",
                type: "text",
                text: "hello from assistant",
              },
            },
          } as OpencodeEvent,
          "ws-a",
        );

        const assistantPartTrace = (traceWindow.__vesloSendWorkflowTrace ?? []).filter(
          (entry) => entry.event === "session-sse:assistant-part-updated",
        );
        assert.deepEqual(
          assistantPartTrace.map((entry) => entry.messageID),
          ["msg-assistant"],
        );
      } finally {
        dispose();
      }
    });
  }),
);

test(
  "text part trace does not infer assistant role from a placeholder message",
  withSendWorkflowTraceWindow(async (traceWindow) => {
    await createRoot(async (dispose) => {
      try {
        const { controller } = makeController({
          workspaceSessionIds: new Set(["sess-a"]),
        });

        await controller.applyEvent(
          {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part-before-message",
                sessionID: "sess-a",
                messageID: "msg-before-message",
                type: "text",
                text: "parent role not known yet",
              },
            },
          } as OpencodeEvent,
          "ws-a",
        );

        const assistantPartTrace = (traceWindow.__vesloSendWorkflowTrace ?? []).filter(
          (entry) => entry.event === "session-sse:assistant-part-updated",
        );
        assert.deepEqual(assistantPartTrace, []);
      } finally {
        dispose();
      }
    });
  }),
);

test("active session idle schedules local and engine transcript ingestion immediately", async () => {
  await createRoot(async (dispose) => {
    try {
      const transcriptIngest: Array<Record<string, unknown>> = [];
      const backgroundIngest: Array<Record<string, unknown>> = [];
      const { controller } = makeController({
        workspaceSessionIds: new Set(["sess-a"]),
        transcriptIngest,
        backgroundIngest,
      });

      await controller.applyEvent(
        {
          type: "session.idle",
          properties: { sessionID: "sess-a" },
        } as OpencodeEvent,
        "ws-a",
      );

      assert.deepEqual(transcriptIngest, [
        {
          sessionID: "sess-a",
          sourceWsId: "ws-a",
          reason: "session.idle",
          delayMs: 0,
        },
      ]);
      assert.deepEqual(backgroundIngest, [
        {
          sessionID: "sess-a",
          workspaceId: "ws-a",
          reason: "session.idle engine snapshot",
          delayMs: 0,
        },
      ]);
    } finally {
      dispose();
    }
  });
});

test("scoped session idle does not refresh through the active fallback client", async () => {
  await createRoot(async (dispose) => {
    try {
      const activeClientGets: string[] = [];
      const statusTraces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
      const routing = {
        activeWorkspaceId: () => "ws-a",
        active: () => null,
        client: () => null,
        entry: () => null,
        entryIds: () => ["ws-a"],
        release: () => {},
      };
      const activeClient = {
        session: {
          get: async ({ sessionID }: { sessionID: string }) => {
            activeClientGets.push(sessionID);
            return ok({ id: sessionID, status: "idle" });
          },
        },
      };
      const { controller } = makeController({
        activeWorkspaceId: "ws-a",
        workspaceSessionIds: new Set(["sess-a"]),
        routing,
        client: () => activeClient,
        statusTraces,
      });

      await controller.applyEvent(
        {
          type: "session.idle",
          properties: { sessionID: "sess-a" },
        } as OpencodeEvent,
        "ws-a",
      );

      assert.deepEqual(activeClientGets, []);
      assert.equal(
        statusTraces.some((trace) => trace.event === "sse-session-idle-live-refresh-skipped"),
        true,
      );
    } finally {
      dispose();
    }
  });
});

test("event stream runtime errors release the route and recover workspace runtime", async () => {
  await createRoot(async (dispose) => {
    try {
      const released: string[] = [];
      const recovered: string[] = [];
      const streamClient = makeEventClient(async () => {
        throw new Error("opencode_proxy_failed: socket connection was closed unexpectedly");
      });
      const routing = {
        activeWorkspaceId: () => "ws-a",
        active: () => null,
        client: (workspaceId?: string) => (workspaceId === "ws-a" ? streamClient : null),
        entry: () => null,
        entryIds: () => ["ws-a"],
        release: (workspaceId: string) => {
          released.push(workspaceId);
        },
      };
      const { controller } = makeController({
        activeWorkspaceId: "ws-a",
        routing,
        recoverWorkspaceRuntimeForEventStream: async (workspaceId) => {
          recovered.push(workspaceId);
          return true;
        },
      });

      controller.setupSseStream("ws-a", streamClient);
      await tick(8);

      assert.deepEqual(released, ["ws-a"]);
      assert.deepEqual(recovered, ["ws-a"]);
    } finally {
      dispose();
    }
  });
});

test("local Veslo bearer session errors trace and recover workspace runtime", withSendWorkflowTraceWindow(async (target) => {
  await createRoot(async (dispose) => {
    try {
      const released: string[] = [];
      const recovered: string[] = [];
      const statusTraces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
      const sessionErrorTurns: Array<{ sessionID: string; text: string }> = [];
      const routing = {
        activeWorkspaceId: () => "ws-a",
        active: () => null,
        client: () => null,
        entry: () => null,
        entryIds: () => ["ws-a"],
        release: (workspaceId: string) => {
          released.push(workspaceId);
        },
      };
      const { controller } = makeController({
        activeWorkspaceId: "ws-a",
        routing,
        statusTraces,
        sessionErrorTurns,
        recoverWorkspaceRuntimeForEventStream: async (workspaceId) => {
          recovered.push(workspaceId);
          return true;
        },
      });

      await controller.applyEvent(
        {
          type: "session.error",
          properties: {
            sessionID: "sess-a",
            error: {
              name: "APIError",
              message: "Unauthorized: Invalid bearer token",
              data: {
                statusCode: 401,
                isRetryable: false,
                responseBody: '{"code":"unauthorized","message":"Invalid bearer token"}',
              },
            },
          },
        } as OpencodeEvent,
        "ws-a",
      );

      assert.deepEqual(released, ["ws-a"]);
      assert.deepEqual(recovered, ["ws-a"]);
      assert.equal(sessionErrorTurns[0]?.sessionID, "sess-a");
      assert.match(sessionErrorTurns[0]?.text ?? "", /^Local runtime connection changed/);
      assert.equal(
        statusTraces.some((trace) => trace.event === "sse-session-error-local-runtime-invalid-bearer"),
        true,
      );
      assert.equal(
        target.__vesloSendWorkflowTrace?.some(
          (trace) => trace.event === "session-sse:local-runtime-invalid-bearer",
        ),
        true,
      );
    } finally {
      dispose();
    }
  });
}));

test("cleanup aborts the currently reconnected SSE controller", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let reconnectCallback: (() => void) | null = null;
  const signals: AbortSignal[] = [];
  let subscribeCount = 0;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    reconnectCallback = () => callback();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  try {
    const { controller } = makeController();
    const client = makeEventClient(async ({ signal }) => {
      signals.push(signal);
      subscribeCount += 1;
      if (subscribeCount === 1) {
        return {
          stream: (async function* () {})(),
        };
      }
      return {
        stream: (async function* () {
          await new Promise<void>(() => {});
        })(),
      };
    });

    const cleanup = controller.setupSseStream("ws-a", client);
    await tick(4);
    assert.equal(signals.length, 1);
    assert.equal(typeof reconnectCallback, "function");

    const runReconnect = reconnectCallback as (() => void) | null;
    assert.ok(runReconnect);
    runReconnect();
    await tick(4);
    assert.equal(signals.length, 2);
    assert.equal(signals[1].aborted, false);

    cleanup();
    assert.equal(signals[1].aborted, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("background SSE failures do not mark the global stream disconnected while another stream is connected", async () => {
  const connectedStates: boolean[] = [];
  const { controller } = makeController({
    activeWorkspaceId: "ws-a",
    setSseConnected: (connected) => connectedStates.push(connected),
  });

  const activeClient = makeEventClient(async () => ({
    stream: (async function* () {
      yield { type: "server.connected" } as OpencodeEvent;
      await new Promise<void>(() => {});
    })(),
  }));
  const backgroundClient = makeEventClient(async () => ({
    stream: (async function* () {
      throw new Error("background stream failed");
    })(),
  }));

  const cleanupActive = controller.setupSseStream("ws-a", activeClient);
  await tick(4);
  assert.equal(connectedStates.at(-1), true);

  const cleanupBackground = controller.setupSseStream("ws-b", backgroundClient);
  await tick(4);
  assert.equal(connectedStates.at(-1), true);

  cleanupBackground();
  cleanupActive();
});

test("reconnect catch-up refreshes sessions that were running during the outage", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let reconnectCallback: (() => void) | null = null;
  const statusRefreshes: string[] = [];
  const messageRefreshes: string[] = [];
  const todoRefreshes: string[] = [];
  const messageWrites: string[] = [];
  const permissionRefreshes: string[] = [];
  const questionRefreshes: string[] = [];
  let subscribeCount = 0;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    reconnectCallback = () => callback();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  try {
    const { controller, setStore } = makeController({
      permissionRefreshes,
      questionRefreshes,
      setMessagesForSession: (sessionID) => {
        messageWrites.push(sessionID);
      },
    });
    setStore("sessionStatus", "sess-a", "running");
    setStore("sessionStatus", "ws-a\0sess-a", "running");

    const client = {
      ...makeEventClient(async () => {
        subscribeCount += 1;
        if (subscribeCount === 1) {
          return {
            stream: (async function* () {})(),
          };
        }
        return {
          stream: (async function* () {
            await new Promise<void>(() => {});
          })(),
        };
      }),
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          statusRefreshes.push(sessionID);
          return ok({ id: sessionID, status: "idle" });
        },
        messages: async ({ sessionID }: { sessionID: string }) => {
          messageRefreshes.push(sessionID);
          return ok([{ info: makeMessage(sessionID), parts: [] }]);
        },
        todo: async ({ sessionID }: { sessionID: string }) => {
          todoRefreshes.push(sessionID);
          return ok([]);
        },
      },
    } as any;

    const cleanup = controller.setupSseStream("ws-a", client);
    await tick(4);
    const runReconnect = reconnectCallback as (() => void) | null;
    assert.ok(runReconnect);

    runReconnect();
    await tick(12);

    assert.deepEqual(statusRefreshes, ["sess-a"]);
    assert.deepEqual(messageRefreshes, ["sess-a"]);
    assert.deepEqual(todoRefreshes, ["sess-a"]);
    assert.deepEqual(messageWrites, ["sess-a"]);
    assert.deepEqual(permissionRefreshes, ["permissions"]);
    assert.deepEqual(questionRefreshes, ["questions"]);

    cleanup();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("reconnect catch-up preserves running status when status refresh fails", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let reconnectCallback: (() => void) | null = null;
  const statusRefreshes: string[] = [];
  const statusTraces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  let subscribeCount = 0;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    reconnectCallback = () => callback();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  try {
    const { controller, setStore, store, busyCalls } = makeController({
      activeWorkspaceId: "ws-a",
      statusTraces,
    });
    setStore("sessionStatus", "ws-a\0sess-a", "running");

    const client = {
      ...makeEventClient(async () => {
        subscribeCount += 1;
        if (subscribeCount === 1) {
          return {
            stream: (async function* () {})(),
          };
        }
        return {
          stream: (async function* () {
            await new Promise<void>(() => {});
          })(),
        };
      }),
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          statusRefreshes.push(sessionID);
          throw new Error("status unavailable");
        },
      },
    } as any;

    const cleanup = controller.setupSseStream("ws-a", client);
    await tick(4);
    const runReconnect = reconnectCallback as (() => void) | null;
    assert.ok(runReconnect);

    runReconnect();
    await tick(12);

    assert.deepEqual(statusRefreshes, ["sess-a"]);
    assert.equal(store.sessionStatus["ws-a\0sess-a"], "running");
    assert.equal(store.sessionStatus["ws-a:sess-a"], undefined);
    assert.equal(busyCalls.some((call) => call.sessionID === "sess-a" && call.status === "idle"), false);
    assert.equal(
      statusTraces.some((trace) => trace.event === "sse-reconnect-catchup-status-failed"),
      true,
    );

    cleanup();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("background reconnect catch-up schedules durable ingest without mutating active transcript state", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let reconnectCallback: (() => void) | null = null;
  const statusRefreshes: string[] = [];
  const messageRefreshes: string[] = [];
  const todoRefreshes: string[] = [];
  const messageWrites: string[] = [];
  const backgroundIngest: Array<Record<string, unknown>> = [];
  let subscribeCount = 0;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    reconnectCallback = () => callback();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  try {
    const { controller, setStore, store } = makeController({
      activeWorkspaceId: "ws-a",
      backgroundIngest,
      setMessagesForSession: (sessionID) => {
        messageWrites.push(sessionID);
      },
    });
    setStore("sessionStatus", "sess-b", "running");
    setStore("sessionStatus", "ws-b\0sess-b", "running");

    const client = {
      ...makeEventClient(async () => {
        subscribeCount += 1;
        if (subscribeCount === 1) {
          return {
            stream: (async function* () {})(),
          };
        }
        return {
          stream: (async function* () {
            await new Promise<void>(() => {});
          })(),
        };
      }),
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          statusRefreshes.push(sessionID);
          return ok({ id: sessionID, status: "idle" });
        },
        messages: async ({ sessionID }: { sessionID: string }) => {
          messageRefreshes.push(sessionID);
          return ok([{ info: makeMessage(sessionID), parts: [] }]);
        },
        todo: async ({ sessionID }: { sessionID: string }) => {
          todoRefreshes.push(sessionID);
          return ok([]);
        },
      },
    } as any;

    const cleanup = controller.setupSseStream("ws-b", client);
    await tick(4);
    const runReconnect = reconnectCallback as (() => void) | null;
    assert.ok(runReconnect);

    runReconnect();
    await tick(12);

    assert.deepEqual(statusRefreshes, ["sess-b"]);
    assert.deepEqual(messageRefreshes, []);
    assert.deepEqual(todoRefreshes, []);
    assert.deepEqual(messageWrites, []);
    assert.equal(store.messages["sess-b"], undefined);
    assert.equal(store.todos["sess-b"], undefined);
    assert.deepEqual(backgroundIngest, [
      {
        sessionID: "sess-b",
        workspaceId: "ws-b",
        reason: "reconnect catch-up",
        delayMs: 0,
      },
    ]);

    cleanup();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
