import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import type { Part, Session } from "@opencode-ai/sdk/v2/client";

import {
  createSessionTranscriptController,
  INITIAL_SESSION_MESSAGE_LIMIT,
} from "../../context/session-transcript-controller.js";
import type { MessageInfo, MessageWithParts } from "../../types";

function ok<T>(data: T) {
  return {
    data,
    request: new Request("http://localhost.test"),
    response: new Response(),
  };
}

const makeSession = (id: string, directory = "/repo"): Session =>
  ({
    id,
    title: id,
    directory,
    time: { created: 1 },
  }) as Session;

const makeMessage = (id: string, created: number, sessionID = "sess-a"): MessageInfo =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created },
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "",
    agent: "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as unknown as MessageInfo;

const makeTextPart = (id: string, messageID: string, sessionID = "sess-a", text = "hello"): Part =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic: false,
    ignored: false,
  }) as Part;

function makeController(options: {
  activeWorkspaceId?: string;
  sessions?: Session[];
  appendTranscriptSnapshot?: (input: any) => Promise<void> | void;
  routingClient?: any;
} = {}) {
  const [store, setStore] = createStore({
    sessions: options.sessions ?? [],
    messages: {} as Record<string, MessageInfo[]>,
    parts: {} as Record<string, Part[]>,
  });
  const routing = {
    activeWorkspaceId: () => options.activeWorkspaceId ?? "ws-a",
    client: (workspaceId: string) => workspaceId === "ws-b" ? options.routingClient : null,
    entry: (workspaceId: string) => ({ workspaceId, directory: "/background" }),
  } as any;

  const controller = createSessionTranscriptController({
    store,
    setStore: setStore as any,
    routing,
    activeWorkspaceRoot: () => "/repo",
    appendTranscriptSnapshot: options.appendTranscriptSnapshot,
    applySessionDirectoryOverride: (session) => session,
    resolveSessionDirectory: (session) => session.directory ?? "",
    sessionWarn: () => {},
    withTimeout: async (promise) => promise,
  });

  return { controller, store, setStore };
}

test("hydrateTranscriptSnapshot ignores unavailable, older, and shorter stale snapshots", () => {
  createRoot((dispose) => {
    try {
      const { controller, store } = makeController();

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        source: "unavailable",
        limit: 1,
        messages: [makeMessage("ignored", 1)],
        partsByMessageId: {},
      } as any);
      assert.equal(controller.getCachedTranscriptMessageCount("sess-a"), 0);

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 20,
        limit: 2,
        messages: [makeMessage("msg-a", 1), makeMessage("msg-b", 2)],
        partsByMessageId: {
          "msg-a": [makeTextPart("part-b", "msg-a"), makeTextPart("part-a", "msg-a")],
        },
      });
      assert.deepEqual(store.messages["sess-a"].map((message) => message.id), ["msg-a", "msg-b"]);
      assert.deepEqual(store.parts["msg-a"].map((part) => part.id), ["part-a", "part-b"]);

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 10,
        limit: 1,
        messages: [makeMessage("older", 1)],
        partsByMessageId: {},
      });
      assert.deepEqual(store.messages["sess-a"].map((message) => message.id), ["msg-a", "msg-b"]);

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 30,
        limit: 1,
        messages: [makeMessage("shorter", 1)],
        partsByMessageId: {},
      });
      assert.deepEqual(store.messages["sess-a"].map((message) => message.id), ["msg-a", "msg-b"]);
      assert.equal(controller.getTranscriptFreshness("sess-a")?.fetchedAt, 30);
    } finally {
      dispose();
    }
  });
});

test("hydrateTranscriptSnapshot can apply shorter authoritative snapshots", () => {
  createRoot((dispose) => {
    try {
      const { controller, store } = makeController();

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 20,
        limit: 3,
        messages: [makeMessage("msg-a", 1), makeMessage("msg-b", 2), makeMessage("msg-c", 3)],
        partsByMessageId: {},
      });
      assert.deepEqual(store.messages["sess-a"].map((message) => message.id), ["msg-a", "msg-b", "msg-c"]);

      controller.hydrateTranscriptSnapshot(
        {
          workspaceId: "ws-a",
          sessionId: "sess-a",
          fetchedAt: 30,
          limit: 3,
          messages: [makeMessage("msg-a", 1), makeMessage("msg-c", 3)],
          partsByMessageId: {},
        },
        { allowShorter: true },
      );

      assert.deepEqual(store.messages["sess-a"].map((message) => message.id), ["msg-a", "msg-c"]);
      assert.equal(controller.getTranscriptFreshness("sess-a")?.fetchedAt, 30);
    } finally {
      dispose();
    }
  });
});

test("live transcript ingestion carries pending deletions and clears them after a successful write", async () => {
  const writes: any[] = [];

  await createRoot(async (dispose) => {
    try {
      const { controller } = makeController({
        sessions: [makeSession("sess-a")],
        appendTranscriptSnapshot: async (input) => {
          writes.push(input);
        },
      });
      controller.setMessagesForSession("sess-a", [
        {
          info: makeMessage("msg-a", 1),
          parts: [makeTextPart("part-a", "msg-a")],
        },
      ]);

      controller.recordPendingTranscriptMessageDeletion("ws-a", "sess-a", "msg-a");
      await controller.flushTranscriptIngestion("ws-a", "sess-a", "message.removed");

      assert.deepEqual(writes[0].deletedMessageIds, ["msg-a"]);
      assert.equal(writes[0].reason, "message.removed");

      await controller.flushTranscriptIngestion("ws-a", "sess-a", "next");
      assert.deepEqual(writes[1].deletedMessageIds, []);
    } finally {
      dispose();
    }
  });
});

test("background transcript ingestion reads from the explicit source workspace client", async () => {
  const writes: any[] = [];
  let getCalls = 0;
  let messageCalls = 0;
  const transcript: MessageWithParts[] = [
    {
      info: makeMessage("msg-b", 1, "sess-b"),
      parts: [makeTextPart("part-b", "msg-b", "sess-b")],
    },
  ];

  await createRoot(async (dispose) => {
    try {
      const { controller } = makeController({
        routingClient: {
          session: {
            get: async () => {
              getCalls += 1;
              return ok(makeSession("sess-b", "/background"));
            },
            messages: async ({ limit }: { limit: number }) => {
              messageCalls += 1;
              assert.equal(limit, INITIAL_SESSION_MESSAGE_LIMIT);
              return ok(transcript);
            },
          },
        },
        appendTranscriptSnapshot: async (input) => {
          writes.push(input);
        },
      });

      await controller.flushBackgroundTranscriptIngestion("ws-b", "sess-b", "background message.updated");

      assert.equal(getCalls, 1);
      assert.equal(messageCalls, 1);
      assert.equal(writes[0].workspaceId, "ws-b");
      assert.equal(writes[0].directory, "/background");
      assert.deepEqual(writes[0].messages.map((message: MessageInfo) => message.id), ["msg-b"]);
    } finally {
      dispose();
    }
  });
});

test("scheduled transcript ingestion timers are cleared on controller cleanup", async () => {
  let writes = 0;

  createRoot((dispose) => {
    const { controller } = makeController({
      sessions: [makeSession("sess-a")],
      appendTranscriptSnapshot: () => {
        writes += 1;
      },
    });
    controller.setMessagesForSession("sess-a", [
      {
        info: makeMessage("msg-a", 1),
        parts: [makeTextPart("part-a", "msg-a")],
      },
    ]);
    controller.scheduleTranscriptIngestion("sess-a", "ws-a", "delayed", 30);
    dispose();
  });

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(writes, 0);
});
