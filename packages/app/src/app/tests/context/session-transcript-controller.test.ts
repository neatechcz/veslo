import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import type { Part, Session } from "@opencode-ai/sdk/v2/client";

import {
  createSessionTranscriptController,
  INITIAL_SESSION_MESSAGE_LIMIT,
} from "../../context/session-transcript-controller.js";
import type { MessageInfo, MessageWithParts } from "../../types";

const transcriptControllerSource = readFileSync(
  new URL("../../context/session-transcript-controller.ts", import.meta.url),
  "utf8",
);

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
  activeWorkspaceId?: string | (() => string);
  activeWorkspaceRoot?: string | (() => string);
  sessions?: Session[];
  appendTranscriptSnapshot?: (input: any) => Promise<void> | void;
  routingClient?: any;
  routingEntryDirectory?: string | null | ((workspaceId: string) => string | null);
} = {}) {
  const [store, setStore] = createStore({
    sessions: options.sessions ?? [],
    messages: {} as Record<string, MessageInfo[]>,
    parts: {} as Record<string, Part[]>,
  });
  const readOption = (value: string | (() => string) | undefined, fallback: string) =>
    typeof value === "function" ? value() : value ?? fallback;
  const readEntryDirectory = (workspaceId: string) => {
    const directory = options.routingEntryDirectory;
    if (typeof directory === "function") return directory(workspaceId);
    if (directory !== undefined) return directory;
    return workspaceId === "ws-b" ? "/background" : "/repo";
  };
  const routing = {
    activeWorkspaceId: () => readOption(options.activeWorkspaceId, "ws-a"),
    client: (workspaceId: string) => workspaceId === "ws-b" ? options.routingClient : null,
    entry: (workspaceId: string) => {
      const directory = readEntryDirectory(workspaceId);
      return directory == null ? null : { workspaceId, directory };
    },
  } as any;

  const controller = createSessionTranscriptController({
    store,
    setStore: setStore as any,
    routing,
    activeWorkspaceRoot: () => readOption(options.activeWorkspaceRoot, "/repo"),
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

test("hydrateTranscriptSnapshot does not erase a live assistant part with an equally sized snapshot", () => {
  const root = globalThis as unknown as Record<string, unknown>;
  const hadWindow = Object.prototype.hasOwnProperty.call(root, "window");
  const previousWindow = root.window;
  const traceWindow: { __vesloSendWorkflowTraceEnabled: boolean; __vesloSendWorkflowTrace?: Array<Record<string, unknown>> } = {
    __vesloSendWorkflowTraceEnabled: true,
  };
  root.window = traceWindow;
  try {
    createRoot((dispose) => {
      try {
        const { controller, store, setStore } = makeController();
        const message = makeMessage("msg-a", 1);
        const livePart = makeTextPart("part-a", "msg-a", "sess-a", "live response");

        controller.hydrateTranscriptSnapshot({
          workspaceId: "ws-a",
          sessionId: "sess-a",
          fetchedAt: 10,
          limit: 1,
          messages: [message],
          partsByMessageId: { "msg-a": [] },
        });
        setStore("parts", "msg-a", [livePart]);

        controller.hydrateTranscriptSnapshot({
          workspaceId: "ws-a",
          sessionId: "sess-a",
          fetchedAt: 20,
          limit: 1,
          messages: [message],
          partsByMessageId: { "msg-a": [] },
        });

        assert.deepEqual(store.parts["msg-a"], [livePart]);
      } finally {
        dispose();
      }
    });
    assert.deepEqual(
      (traceWindow.__vesloSendWorkflowTrace ?? [])
        .filter((entry) => entry.event === "session-transcript:snapshot-preserved-live-parts")
        .map(({ event, workspaceId, sessionId, preservedMessageCount, preservedPartCount }) => ({
          event,
          workspaceId,
          sessionId,
          preservedMessageCount,
          preservedPartCount,
        })),
      [{
        event: "session-transcript:snapshot-preserved-live-parts",
        workspaceId: "ws-a",
        sessionId: "sess-a",
        preservedMessageCount: 1,
        preservedPartCount: 1,
      }],
    );
  } finally {
    if (hadWindow) {
      root.window = previousWindow;
    } else {
      Reflect.deleteProperty(root, "window");
    }
  }
});

test("terminal-authoritative snapshot can clear stale live parts", () => {
  createRoot((dispose) => {
    try {
      const { controller, store, setStore } = makeController();
      const message = makeMessage("msg-a", 1);
      const livePart = makeTextPart("part-a", "msg-a", "sess-a", "partial response");

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 10,
        limit: 1,
        messages: [message],
        partsByMessageId: { "msg-a": [] },
      });
      setStore("parts", "msg-a", [livePart]);

      controller.hydrateTranscriptSnapshot(
        {
          workspaceId: "ws-a",
          sessionId: "sess-a",
          fetchedAt: 20,
          limit: 1,
          messages: [message],
          partsByMessageId: { "msg-a": [] },
        },
        { preserveLiveParts: false },
      );

      assert.deepEqual(store.parts["msg-a"], []);
    } finally {
      dispose();
    }
  });
});

test("equivalent snapshots are store no-ops, while a terminal replacement happens once", () => {
  createRoot((dispose) => {
    try {
      const { controller, store, setStore } = makeController();
      const message = makeMessage("msg-a", 1);
      const partial = makeTextPart("part-a", "msg-a", "sess-a", "partial response");
      const durable = makeTextPart("part-a", "msg-a", "sess-a", "durable response");

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 10,
        limit: 1,
        messages: [message],
        partsByMessageId: { "msg-a": [durable] },
      });
      const firstMessages = store.messages["sess-a"];
      const firstParts = store.parts["msg-a"];

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 11,
        limit: 1,
        messages: [{ ...message }],
        partsByMessageId: { "msg-a": [{ ...durable }] },
      });
      assert.equal(store.messages["sess-a"], firstMessages);
      assert.equal(store.parts["msg-a"], firstParts);

      setStore("parts", "msg-a", [partial]);
      controller.hydrateTranscriptSnapshot(
        {
          workspaceId: "ws-a",
          sessionId: "sess-a",
          fetchedAt: 12,
          limit: 1,
          messages: [{ ...message }],
          partsByMessageId: { "msg-a": [{ ...durable }] },
        },
        { preserveLiveParts: false },
      );
      const terminalParts = store.parts["msg-a"];
      assert.deepEqual(terminalParts, [durable]);

      controller.hydrateTranscriptSnapshot(
        {
          workspaceId: "ws-a",
          sessionId: "sess-a",
          fetchedAt: 13,
          limit: 1,
          messages: [{ ...message }],
          partsByMessageId: { "msg-a": [{ ...durable }] },
        },
        { preserveLiveParts: false },
      );
      assert.equal(store.parts["msg-a"], terminalParts);
    } finally {
      dispose();
    }
  });
});

test("hydrateTranscriptSnapshot still adopts non-empty snapshot parts", () => {
  createRoot((dispose) => {
    try {
      const { controller, store, setStore } = makeController();
      const message = makeMessage("msg-a", 1);
      const livePart = makeTextPart("part-a", "msg-a", "sess-a", "live response");
      const snapshotPart = makeTextPart("part-a", "msg-a", "sess-a", "durable response");

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 10,
        limit: 1,
        messages: [message],
        partsByMessageId: { "msg-a": [] },
      });
      setStore("parts", "msg-a", [livePart]);

      controller.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        fetchedAt: 20,
        limit: 1,
        messages: [message],
        partsByMessageId: { "msg-a": [snapshotPart] },
      });

      assert.deepEqual(store.parts["msg-a"], [snapshotPart]);
    } finally {
      dispose();
    }
  });
});

test("session transcript controller has no client snapshot writer", () => {
  assert.doesNotMatch(transcriptControllerSource, /appendTranscriptSnapshot|appendSessionTranscript/);
});
