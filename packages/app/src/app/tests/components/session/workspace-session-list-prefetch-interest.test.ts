import assert from "node:assert/strict";
import test from "node:test";

import { deriveLoadedSidebarPrefetchInterest } from "../../../components/session/workspace-session-list-prefetch-interest.js";

test("recent mode groups loaded rows by workspace across the whole sidebar", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: "ws-b-selected",
    clickedSessionId: null,
    loadedTopLevelRows: [
      { workspaceId: "ws-a", sessionId: "ws-a-1", directory: "/work/a", updatedAt: 30 },
      { workspaceId: "ws-b", sessionId: "ws-b-selected", directory: "/work/b", updatedAt: 25 },
      { workspaceId: "ws-a", sessionId: "ws-a-2", directory: "/work/a", updatedAt: 20 },
    ],
    expandedSubagentRows: [],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["ws-a-1", "ws-a-2"],
    expandedSubagentSessionIds: [],
    sessionDirectoriesById: { "ws-a-1": "/work/a", "ws-a-2": "/work/a" },
    clickedSession: null,
    selectedSession: null,
    loadedTopLevelSessions: [
      { sessionId: "ws-a-1", directory: "/work/a" },
      { sessionId: "ws-a-2", directory: "/work/a" },
    ],
    expandedSubagentSessions: [],
  });
  assert.deepEqual(result.get("ws-b"), {
    clickedSessionId: null,
    selectedSessionId: "ws-b-selected",
    loadedTopLevelSessionIds: ["ws-b-selected"],
    expandedSubagentSessionIds: [],
    sessionDirectoriesById: { "ws-b-selected": "/work/b" },
    clickedSession: null,
    selectedSession: { sessionId: "ws-b-selected", directory: "/work/b" },
    loadedTopLevelSessions: [{ sessionId: "ws-b-selected", directory: "/work/b" }],
    expandedSubagentSessions: [],
  });
});

test("expanded subagents are included newest-first and deduplicated per workspace", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: null,
    clickedSessionId: "child-newer",
    loadedTopLevelRows: [{ workspaceId: "ws-a", sessionId: "parent", directory: "/work/a", updatedAt: 80 }],
    expandedSubagentRows: [
      { workspaceId: "ws-a", sessionId: "child-older", directory: "/work/a", updatedAt: 10 },
      { workspaceId: "ws-a", sessionId: "child-newer", directory: "/work/a", updatedAt: 40 },
      { workspaceId: "ws-a", sessionId: "child-newer", directory: "/work/a", updatedAt: 40 },
    ],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: "child-newer",
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["parent"],
    expandedSubagentSessionIds: ["child-newer", "child-older"],
    sessionDirectoriesById: {
      parent: "/work/a",
      "child-older": "/work/a",
      "child-newer": "/work/a",
    },
    clickedSession: null,
    selectedSession: null,
    loadedTopLevelSessions: [{ sessionId: "parent", directory: "/work/a" }],
    expandedSubagentSessions: [
      { sessionId: "child-newer", directory: "/work/a" },
      { sessionId: "child-older", directory: "/work/a" },
    ],
  });
});

test("normalizes ids, filters blanks, and deduplicates duplicate top-level rows", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: "  selected-a  ",
    clickedSessionId: "  clicked-a  ",
    loadedTopLevelRows: [
      { workspaceId: "  ws-a  ", sessionId: "  selected-a  ", directory: " /work/a ", updatedAt: 30 },
      { workspaceId: "ws-a", sessionId: "clicked-a", directory: "/work/a", updatedAt: 25 },
      { workspaceId: "ws-a", sessionId: "  top-a  ", directory: "/work/a", updatedAt: 20 },
      { workspaceId: "ws-a", sessionId: "top-a", directory: "/work/a", updatedAt: 10 },
      { workspaceId: "ws-a", sessionId: "   ", directory: "/work/a", updatedAt: 5 },
      { workspaceId: "   ", sessionId: "ignored", directory: "/work/ignored", updatedAt: 1 },
    ],
    expandedSubagentRows: [
      { workspaceId: " ws-a ", sessionId: " sub-a ", directory: " /work/a ", updatedAt: 15 },
      { workspaceId: "ws-a", sessionId: "sub-a", directory: "/work/a", updatedAt: 14 },
      { workspaceId: "ws-a", sessionId: "   ", directory: "/work/a", updatedAt: 13 },
    ],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: "clicked-a",
    selectedSessionId: "selected-a",
    loadedTopLevelSessionIds: ["selected-a", "clicked-a", "top-a"],
    expandedSubagentSessionIds: ["sub-a"],
    sessionDirectoriesById: {
      "selected-a": "/work/a",
      "clicked-a": "/work/a",
      "top-a": "/work/a",
      "sub-a": "/work/a",
    },
    clickedSession: { sessionId: "clicked-a", directory: "/work/a" },
    selectedSession: { sessionId: "selected-a", directory: "/work/a" },
    loadedTopLevelSessions: [
      { sessionId: "selected-a", directory: "/work/a" },
      { sessionId: "clicked-a", directory: "/work/a" },
      { sessionId: "top-a", directory: "/work/a" },
    ],
    expandedSubagentSessions: [{ sessionId: "sub-a", directory: "/work/a" }],
  });
});

test("does not misattribute ambiguous clicked or selected ids across workspaces", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: "shared",
    clickedSessionId: "shared",
    loadedTopLevelRows: [
      { workspaceId: "ws-a", sessionId: "shared", directory: "/work/a", updatedAt: 30 },
      { workspaceId: "ws-b", sessionId: "shared", directory: "/work/b", updatedAt: 20 },
    ],
    expandedSubagentRows: [],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["shared"],
    expandedSubagentSessionIds: [],
    sessionDirectoriesById: { shared: "/work/a" },
    clickedSession: null,
    selectedSession: null,
    loadedTopLevelSessions: [{ sessionId: "shared", directory: "/work/a" }],
    expandedSubagentSessions: [],
  });
  assert.deepEqual(result.get("ws-b"), {
    clickedSessionId: null,
    selectedSessionId: null,
    loadedTopLevelSessionIds: ["shared"],
    expandedSubagentSessionIds: [],
    sessionDirectoriesById: { shared: "/work/b" },
    clickedSession: null,
    selectedSession: null,
    loadedTopLevelSessions: [{ sessionId: "shared", directory: "/work/b" }],
    expandedSubagentSessions: [],
  });
});

test("preserves same-workspace duplicate raw session ids as scoped refs", () => {
  const result = deriveLoadedSidebarPrefetchInterest({
    selectedSessionId: "shared",
    selectedRowKey: "row-b",
    clickedSessionId: "shared",
    clickedRowKey: "row-a",
    loadedTopLevelRows: [
      { rowKey: "row-a", workspaceId: "ws-a", sessionId: "shared", directory: "/work/a", updatedAt: 30 },
      { rowKey: "row-b", workspaceId: "ws-a", sessionId: "shared", directory: "/work/b", updatedAt: 20 },
    ],
    expandedSubagentRows: [],
  });

  assert.deepEqual(result.get("ws-a"), {
    clickedSessionId: "shared",
    selectedSessionId: "shared",
    loadedTopLevelSessionIds: ["shared"],
    expandedSubagentSessionIds: [],
    sessionDirectoriesById: { shared: "/work/a" },
    clickedSession: { sessionId: "shared", directory: "/work/a" },
    selectedSession: { sessionId: "shared", directory: "/work/b" },
    loadedTopLevelSessions: [
      { sessionId: "shared", directory: "/work/a" },
      { sessionId: "shared", directory: "/work/b" },
    ],
    expandedSubagentSessions: [],
  });
});
