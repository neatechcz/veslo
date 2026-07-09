import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveUiConversationScope,
  upsertUiConversationScope,
  type UiConversationScopeMap,
} from "../../lib/conversation-scope.js";

test("stores scope under UI id, OpenCode id, and Veslo conversation id", () => {
  const map = upsertUiConversationScope({}, {
    sessionId: "sess-a",
    workspaceId: "ws-a",
    workspaceRoot: "/work/a",
    directory: "/work/a",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    updatedAt: 10,
  });

  assert.equal(resolveUiConversationScope(map, "sess-a")?.conversationId, "conv-a");
  assert.equal(resolveUiConversationScope(map, "conv-a")?.opencodeSessionId, "sess-a");
  assert.equal(resolveUiConversationScope(map, "sess-a")?.workspaceId, "ws-a");
});

test("does not guess a workspace when the same UI id is ambiguous", () => {
  let map: UiConversationScopeMap = {};
  map = upsertUiConversationScope(map, {
    sessionId: "sess-same",
    workspaceId: "ws-a",
    workspaceRoot: "/work/a",
    directory: "/work/a",
    conversationId: "conv-a",
    opencodeSessionId: "sess-same",
    updatedAt: 10,
  });
  map = upsertUiConversationScope(map, {
    sessionId: "sess-same",
    workspaceId: "ws-b",
    workspaceRoot: "/work/b",
    directory: "/work/b",
    conversationId: "conv-b",
    opencodeSessionId: "sess-same",
    updatedAt: 20,
  });

  assert.equal(resolveUiConversationScope(map, "sess-same"), null);
  assert.equal(
    resolveUiConversationScope(map, "sess-same", { activeWorkspaceId: "ws-b" })?.conversationId,
    "conv-b",
  );
});

test("merges later Veslo conversation identity into an existing OpenCode scope", () => {
  let map: UiConversationScopeMap = {};
  map = upsertUiConversationScope(map, {
    sessionId: "sess-a",
    workspaceId: "ws-a",
    workspaceRoot: "/work/a",
    directory: "/work/a",
    opencodeSessionId: "sess-a",
    updatedAt: 10,
  });
  map = upsertUiConversationScope(map, {
    sessionId: "sess-a",
    workspaceId: "ws-a",
    workspaceRoot: "/work/a",
    directory: "/work/a",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    updatedAt: 20,
  });

  assert.equal(resolveUiConversationScope(map, "sess-a")?.conversationId, "conv-a");
  assert.equal(map["sess-a"]?.length, 1);
});

test("resolves duplicate active workspace scopes when they share one conversation identity", () => {
  let map: UiConversationScopeMap = {};
  map = upsertUiConversationScope(map, {
    sessionId: "sess-a",
    workspaceId: "ws-a",
    workspaceRoot: "\\\\?\\C:\\repo",
    directory: "\\\\?\\C:\\repo",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    updatedAt: 20,
  });
  map = upsertUiConversationScope(map, {
    sessionId: "sess-a",
    workspaceId: "ws-a",
    workspaceRoot: "c:/repo",
    directory: "c:/repo",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    updatedAt: 20,
  });

  const resolved = resolveUiConversationScope(map, "sess-a", {
    activeWorkspaceId: "ws-a",
    activeWorkspaceRoot: "c:/repo",
  });

  assert.equal(resolved?.conversationId, "conv-a");
  assert.equal(resolved?.directory, "c:/repo");
});

test("selected scope wins over stored ambiguous candidates", () => {
  let map: UiConversationScopeMap = {};
  map = upsertUiConversationScope(map, {
    sessionId: "sess-same",
    workspaceId: "ws-a",
    workspaceRoot: "/work/a",
    directory: "/work/a",
    conversationId: "conv-a",
    opencodeSessionId: "sess-same",
    updatedAt: 10,
  });
  map = upsertUiConversationScope(map, {
    sessionId: "sess-same",
    workspaceId: "ws-b",
    workspaceRoot: "/work/b",
    directory: "/work/b",
    conversationId: "conv-b",
    opencodeSessionId: "sess-same",
    updatedAt: 20,
  });

  const resolved = resolveUiConversationScope(map, "sess-same", {
    activeWorkspaceId: "ws-a",
    selectedScope: {
      sessionId: "sess-same",
      workspaceId: "ws-b",
      workspaceRoot: "/work/b",
      directory: "/work/b",
      conversationId: "conv-b",
      opencodeSessionId: "sess-same",
    },
  });

  assert.equal(resolved?.workspaceId, "ws-b");
  assert.equal(resolved?.conversationId, "conv-b");
});

test("selected workspace-only scope is enriched from a remembered conversation scope", () => {
  let map: UiConversationScopeMap = {};
  map = upsertUiConversationScope(map, {
    sessionId: "sess-a",
    workspaceId: "ws-a",
    workspaceRoot: "/work/a",
    directory: "/work/a",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    updatedAt: 10,
  });

  const resolved = resolveUiConversationScope(map, "sess-a", {
    activeWorkspaceId: "ws-a",
    selectedScope: {
      sessionId: "sess-a",
      workspaceId: "ws-a",
      workspaceRoot: "/work/a",
      directory: "/work/a",
      conversationId: null,
      opencodeSessionId: null,
      updatedAt: 20,
    },
  });

  assert.equal(resolved?.workspaceId, "ws-a");
  assert.equal(resolved?.conversationId, "conv-a");
  assert.equal(resolved?.opencodeSessionId, "sess-a");
  assert.equal(resolved?.updatedAt, 20);
});
