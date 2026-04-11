import assert from "node:assert/strict";
import test from "node:test";

import { deriveLoadedSidebarPrefetchInterest } from "./workspace-session-list-prefetch-interest.js";

test("recent mode groups loaded rows by workspace across the whole sidebar", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: "ws-b-selected",
    clickedSessionId: null,
    loadedTopLevelRows: [
      { workspaceId: "ws-a", sessionId: "ws-a-1", updatedAt: 30 },
      { workspaceId: "ws-b", sessionId: "ws-b-selected", updatedAt: 25 },
      { workspaceId: "ws-a", sessionId: "ws-a-2", updatedAt: 20 },
    ],
    expandedSubagentRows: [],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["ws-a-1", "ws-a-2"],
    expandedSubagentSessionIds: [],
  });
  assert.deepEqual(result.get("ws-b"), {
    clickedSessionId: null,
    selectedSessionId: "ws-b-selected",
    loadedTopLevelSessionIds: ["ws-b-selected"],
    expandedSubagentSessionIds: [],
  });
});

test("expanded subagents are included newest-first and deduplicated per workspace", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: null,
    clickedSessionId: "child-newer",
    loadedTopLevelRows: [{ workspaceId: "ws-a", sessionId: "parent", updatedAt: 80 }],
    expandedSubagentRows: [
      { workspaceId: "ws-a", sessionId: "child-older", updatedAt: 10 },
      { workspaceId: "ws-a", sessionId: "child-newer", updatedAt: 40 },
      { workspaceId: "ws-a", sessionId: "child-newer", updatedAt: 40 },
    ],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: "child-newer",
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["parent"],
    expandedSubagentSessionIds: ["child-newer", "child-older"],
  });
});
