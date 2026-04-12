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

test("normalizes ids, filters blanks, and deduplicates duplicate top-level rows", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: "  selected-a  ",
    clickedSessionId: "  clicked-a  ",
    loadedTopLevelRows: [
      { workspaceId: "  ws-a  ", sessionId: "  selected-a  ", updatedAt: 30 },
      { workspaceId: "ws-a", sessionId: "clicked-a", updatedAt: 25 },
      { workspaceId: "ws-a", sessionId: "  top-a  ", updatedAt: 20 },
      { workspaceId: "ws-a", sessionId: "top-a", updatedAt: 10 },
      { workspaceId: "ws-a", sessionId: "   ", updatedAt: 5 },
      { workspaceId: "   ", sessionId: "ignored", updatedAt: 1 },
    ],
    expandedSubagentRows: [
      { workspaceId: " ws-a ", sessionId: " sub-a ", updatedAt: 15 },
      { workspaceId: "ws-a", sessionId: "sub-a", updatedAt: 14 },
      { workspaceId: "ws-a", sessionId: "   ", updatedAt: 13 },
    ],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: "clicked-a",
    selectedSessionId: "selected-a",
    loadedTopLevelSessionIds: ["selected-a", "clicked-a", "top-a"],
    expandedSubagentSessionIds: ["sub-a"],
  });
});

test("does not misattribute ambiguous clicked or selected ids across workspaces", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: "shared",
    clickedSessionId: "shared",
    loadedTopLevelRows: [
      { workspaceId: "ws-a", sessionId: "shared", updatedAt: 30 },
      { workspaceId: "ws-b", sessionId: "shared", updatedAt: 20 },
    ],
    expandedSubagentRows: [],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["shared"],
    expandedSubagentSessionIds: [],
  });
  assert.deepEqual(result.get("ws-b"), {
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["shared"],
    expandedSubagentSessionIds: [],
  });
});
