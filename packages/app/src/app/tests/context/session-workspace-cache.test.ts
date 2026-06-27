import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2/client";
import { createStore } from "solid-js/store";

import {
  createSessionWorkspaceCacheController,
  resolveWorkspaceSnapshotSelectedSessionId,
  type WorkspaceSessionCache,
} from "../../context/session-workspace-cache.js";
import type { TranscriptFreshness } from "../../context/session-transcript-controller";
import type { MessageInfo, SessionErrorTurn, TodoItem } from "../../types";

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    time: { created: 1, updated: 1 },
    directory: `/repo/${id}`,
  } as Session;
}

function makeMessage(sessionID: string, id = `msg-${sessionID}`): MessageInfo {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1 },
  } as MessageInfo;
}

function makePart(sessionID: string, messageID = `msg-${sessionID}`, id = `part-${sessionID}`) {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text: sessionID,
  } as any;
}

function makeController() {
  const [store, setStore] = createStore({
    sessions: [] as Session[],
    sessionStatus: {} as Record<string, string>,
    sessionErrorTurns: {} as Record<string, SessionErrorTurn[]>,
    messages: {} as Record<string, MessageInfo[]>,
    parts: {} as Record<string, any[]>,
    commandDisplayByMessageID: {} as Record<string, string>,
    todos: {} as Record<string, TodoItem[]>,
    pendingPermissions: [] as any[],
    pendingQuestions: [] as any[],
    events: [] as Array<{ type: string; properties?: unknown }>,
  });

  let selectedSessionId: string | null = null;
  let messageLimitBySession: Record<string, number> = {};
  let messageCompleteBySession: Record<string, boolean> = {};
  let messageLoadBusyBySession: Record<string, boolean> = {};
  let transcriptFreshnessBySession: Record<string, TranscriptFreshness> = {};
  const workspaceSessionIds = new Set<string>();

  const controller = createSessionWorkspaceCacheController({
    store,
    setStore: setStore as any,
    routing: {
      activeWorkspaceId: () => "ws-active",
    },
    selectedSessionId: () => selectedSessionId,
    setSelectedSessionId: (id) => {
      selectedSessionId = id;
    },
    workspaceSessionIds,
    messageLimitBySession: () => messageLimitBySession,
    setMessageLimitBySession: (next) => {
      messageLimitBySession = typeof next === "function" ? next(messageLimitBySession) : next;
    },
    messageCompleteBySession: () => messageCompleteBySession,
    setMessageCompleteBySession: (next) => {
      messageCompleteBySession = typeof next === "function" ? next(messageCompleteBySession) : next;
    },
    setMessageLoadBusyBySession: (next) => {
      messageLoadBusyBySession = typeof next === "function" ? next(messageLoadBusyBySession) : next;
    },
    transcriptFreshnessBySession: () => transcriptFreshnessBySession,
    setTranscriptFreshnessBySession: (next) => {
      transcriptFreshnessBySession =
        typeof next === "function" ? next(transcriptFreshnessBySession) : next;
    },
  });

  return {
    controller,
    store,
    setStore,
    workspaceSessionIds,
    setSelectedSessionId: (id: string | null) => {
      selectedSessionId = id;
    },
    selectedSessionId: () => selectedSessionId,
    getMessageLimitBySession: () => messageLimitBySession,
    setMessageLimitBySession: (next: Record<string, number>) => {
      messageLimitBySession = next;
    },
    getMessageCompleteBySession: () => messageCompleteBySession,
    setMessageCompleteBySession: (next: Record<string, boolean>) => {
      messageCompleteBySession = next;
    },
    getMessageLoadBusyBySession: () => messageLoadBusyBySession,
    setMessageLoadBusyBySession: (next: Record<string, boolean>) => {
      messageLoadBusyBySession = next;
    },
    getTranscriptFreshnessBySession: () => transcriptFreshnessBySession,
    setTranscriptFreshnessBySession: (next: Record<string, TranscriptFreshness>) => {
      transcriptFreshnessBySession = next;
    },
  };
}

test("saving a workspace snapshot keeps only records owned by visible workspace sessions", () => {
  const {
    controller,
    store,
    setStore,
    setSelectedSessionId,
    selectedSessionId,
    workspaceSessionIds,
    getMessageLimitBySession,
    setMessageLimitBySession,
    getMessageCompleteBySession,
    setMessageCompleteBySession,
    getMessageLoadBusyBySession,
    setMessageLoadBusyBySession,
    getTranscriptFreshnessBySession,
    setTranscriptFreshnessBySession,
  } = makeController();

  setStore("sessions", [makeSession("sess-a")]);
  setStore("sessionStatus", {
    "sess-a": "running",
    [`ws-a\0sess-a`]: "running",
    "sess-b": "running",
    [`ws-a\0sess-b`]: "running",
    [`ws-b\0sess-b`]: "running",
  });
  setStore("sessionErrorTurns", {
    "sess-a": [{ id: "err-a", text: "kept", afterMessageID: null, time: 1 }],
    "sess-b": [{ id: "err-b", text: "dropped", afterMessageID: null, time: 2 }],
  });
  setStore("messages", {
    "sess-a": [makeMessage("sess-a")],
    "sess-b": [makeMessage("sess-b")],
  });
  setStore("parts", {
    "msg-sess-a": [makePart("sess-a")],
    "msg-sess-b": [makePart("sess-b")],
  });
  setStore("todos", {
    "sess-a": [{ id: "todo-a", content: "kept", status: "pending" } as TodoItem],
    "sess-b": [{ id: "todo-b", content: "dropped", status: "pending" } as TodoItem],
  });
  setMessageLimitBySession({ "sess-a": 120, "sess-b": 240 });
  setMessageCompleteBySession({ "sess-a": true, "sess-b": false });
  setMessageLoadBusyBySession({ "sess-a": true, "sess-b": true });
  setTranscriptFreshnessBySession({
    "sess-a": { fetchedAt: 10, staleAt: 20 },
    "sess-b": { fetchedAt: 30, staleAt: 40 },
  });
  setSelectedSessionId("sess-a");

  controller.saveWorkspaceSnapshot("ws-a");
  setStore("sessions", [makeSession("other")]);
  setStore("sessionStatus", {});
  setStore("sessionErrorTurns", {});
  setStore("messages", {});
  setStore("parts", {});
  setStore("todos", {});
  setMessageLimitBySession({});
  setMessageCompleteBySession({});
  setMessageLoadBusyBySession({ other: true });
  setTranscriptFreshnessBySession({});
  setSelectedSessionId(null);

  assert.equal(controller.loadWorkspaceSnapshot("ws-a"), true);
  assert.deepEqual(store.sessions.map((session) => session.id), ["sess-a"]);
  assert.deepEqual(Object.keys(store.messages), ["sess-a"]);
  assert.deepEqual(Object.keys(store.parts), ["msg-sess-a"]);
  assert.deepEqual(Object.keys(store.todos), ["sess-a"]);
  assert.deepEqual(Object.keys(store.sessionErrorTurns), ["sess-a"]);
  assert.equal(store.sessionStatus["sess-a"], "running");
  assert.equal(store.sessionStatus[`ws-a\0sess-a`], "running");
  assert.equal(store.sessionStatus["sess-b"], undefined);
  assert.equal(store.sessionStatus[`ws-a\0sess-b`], undefined);
  assert.deepEqual(getMessageLimitBySession(), { "sess-a": 120 });
  assert.deepEqual(getMessageCompleteBySession(), { "sess-a": true });
  assert.deepEqual(getMessageLoadBusyBySession(), {});
  assert.deepEqual(getTranscriptFreshnessBySession(), { "sess-a": { fetchedAt: 10, staleAt: 20 } });
  assert.deepEqual(Array.from(workspaceSessionIds), ["sess-a"]);
  assert.equal(selectedSessionId(), "sess-a");
});

test("selected session snapshot validation rejects missing workspace sessions", () => {
  const validSnapshot = {
    sessions: [makeSession("sess-a")],
    selectedSessionId: "sess-a",
  } as WorkspaceSessionCache;
  const staleSnapshot = {
    sessions: [makeSession("sess-a")],
    selectedSessionId: "sess-b",
  } as WorkspaceSessionCache;

  assert.equal(resolveWorkspaceSnapshotSelectedSessionId(validSnapshot), "sess-a");
  assert.equal(resolveWorkspaceSnapshotSelectedSessionId(staleSnapshot), null);

  const { controller, setStore, selectedSessionId, setSelectedSessionId } = makeController();
  setStore("sessions", [makeSession("sess-a")]);
  setSelectedSessionId("sess-b");
  controller.saveWorkspaceSnapshot("ws-a");
  setSelectedSessionId("keep-outside-cache");

  assert.equal(controller.loadWorkspaceSnapshot("ws-a"), true);
  assert.equal(selectedSessionId(), null);
});

test("workspace snapshot cache eviction keeps recent snapshots and clears explicit entries", () => {
  const realNow = Date.now;
  let now = 0;
  Date.now = () => ++now;

  try {
    const { controller, setStore, setSelectedSessionId } = makeController();

    for (let index = 1; index <= 8; index += 1) {
      const sessionId = `sess-${index}`;
      setStore("sessions", [makeSession(sessionId)]);
      setSelectedSessionId(sessionId);
      controller.saveWorkspaceSnapshot(`ws-${index}`);
    }

    assert.equal(controller.loadWorkspaceSnapshot("ws-1"), false);
    assert.equal(controller.loadWorkspaceSnapshot("ws-2"), false);
    assert.equal(controller.loadWorkspaceSnapshot("ws-8"), true);

    controller.clearWorkspaceSnapshot("ws-8");
    assert.equal(controller.loadWorkspaceSnapshot("ws-8"), false);
  } finally {
    Date.now = realNow;
  }
});
