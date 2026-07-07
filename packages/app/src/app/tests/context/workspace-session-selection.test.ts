import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import {
  SESSION_BY_WORKSPACE_KEY,
  SESSION_BY_WORKSPACE_KEY_V2,
  createWorkspaceSessionSelection,
} from "../../context/workspace-session-selection.js";

const memoryStorage = (initial?: Record<string, string>) => {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    dump: () => Object.fromEntries(store),
  };
};

test("browse-only scoped session does not replace the active workspace last session", () => {
  createRoot((dispose) => {
    try {
      let activeWorkspaceId = "ws-a";
      const storage = memoryStorage({
        [SESSION_BY_WORKSPACE_KEY]: JSON.stringify({ "ws-a": "a1" }),
      });

      const selection = createWorkspaceSessionSelection({
        activeWorkspaceId: () => activeWorkspaceId,
        workspaces: () => [
          { id: "ws-a", path: "/repo/a", workspaceType: "local" },
          { id: "ws-b", path: "/repo/b", workspaceType: "local" },
        ],
        storage,
      });

      selection.setSelectedSessionId("a1");
      assert.equal(selection.activeWorkspaceLastSessionId(), "a1");

      selection.setSessionBrowseScope({
        sessionId: "b1",
        workspaceId: "ws-b",
        workspaceRoot: "/repo/b",
        directory: "/repo/b",
        conversationId: "conv-b1",
        opencodeSessionId: "b1",
      });
      selection.setSelectedSessionId("b1");

      assert.equal(
        selection.activeWorkspaceLastSessionId(),
        "a1",
        "workspace A should keep its last session while the UI browses a workspace B conversation",
      );
      assert.equal(selection.resolveSelectedSessionBrowseScope("b1")?.workspaceId, "ws-b");
      assert.deepEqual(selection.scopedSessionIds().sort(), ["b1", "conv-b1"].sort());

      activeWorkspaceId = "ws-b";
      assert.equal(
        selection.activeWorkspaceLastSessionId(),
        "b1",
        "after activating workspace B, its scoped selected session should become the workspace last session",
      );

      activeWorkspaceId = "ws-a";
      assert.equal(selection.activeWorkspaceLastSessionId(), "a1");
    } finally {
      dispose();
    }
  });
});

test("direct session creation target ignores previously browsed workspace scope", () => {
  createRoot((dispose) => {
    try {
      const selection = createWorkspaceSessionSelection({
        activeWorkspaceId: () => "ws-a",
        activeWorkspaceRoot: () => "/repo/a",
        workspaces: () => [
          { id: "ws-a", path: "/repo/a", workspaceType: "local" },
          { id: "ws-b", path: "/repo/b", workspaceType: "local" },
        ],
        storage: memoryStorage(),
      });

      selection.setSessionBrowseScope({
        sessionId: "b1",
        workspaceId: "ws-b",
        workspaceRoot: "/repo/b",
        directory: "/repo/b",
      });
      selection.setSelectedSessionId("b1");

      assert.deepEqual(selection.resolveSendTargetWorkspaceScope(null), {
        workspaceId: "ws-a",
        workspaceRoot: "/repo/a",
        directory: "/repo/a",
      });
      assert.equal(selection.resolveSendTargetWorkspaceScope("b1")?.workspaceId, "ws-b");
    } finally {
      dispose();
    }
  });
});

test("active workspace last session ignores stored ids scoped to another workspace", () => {
  createRoot((dispose) => {
    try {
      const storage = memoryStorage({
        [SESSION_BY_WORKSPACE_KEY]: JSON.stringify({ "ws-a": "b1" }),
      });
      const selection = createWorkspaceSessionSelection({
        activeWorkspaceId: () => "ws-a",
        activeWorkspaceRoot: () => "/repo/a",
        workspaces: () => [
          { id: "ws-a", path: "/repo/a", workspaceType: "local" },
          { id: "ws-b", path: "/repo/b", workspaceType: "local" },
        ],
        storage,
      });

      selection.setSessionBrowseScope({
        sessionId: "b1",
        workspaceId: "ws-b",
        workspaceRoot: "/repo/b",
        directory: "/repo/b",
      });

      assert.equal(selection.activeWorkspaceLastSessionId(), null);
    } finally {
      dispose();
    }
  });
});

test("same-workspace ambiguous session scope does not fall back to active workspace", () => {
  createRoot((dispose) => {
    try {
      const selection = createWorkspaceSessionSelection({
        activeWorkspaceId: () => "ws-a",
        activeWorkspaceRoot: () => "/repo",
        workspaces: () => [
          { id: "ws-a", path: "/repo", workspaceType: "local" },
        ],
        storage: memoryStorage(),
      });

      selection.rememberConversationScope({
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/a",
        conversationId: "conv-a",
        opencodeSessionId: "same-session",
      });
      selection.rememberConversationScope({
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/b",
        conversationId: "conv-b",
        opencodeSessionId: "same-session",
      });

      assert.equal(selection.resolveSelectedSessionBrowseScope("same-session"), null);
      assert.equal(selection.resolveSendTargetWorkspaceScope("same-session"), null);
    } finally {
      dispose();
    }
  });
});

test("displayed conversation guard rejects directory drift", () => {
  createRoot((dispose) => {
    try {
      const selection = createWorkspaceSessionSelection({
        activeWorkspaceId: () => "ws-a",
        activeWorkspaceRoot: () => "/repo",
        workspaces: () => [
          { id: "ws-a", path: "/repo", workspaceType: "local" },
        ],
        storage: memoryStorage(),
      });

      selection.setSessionBrowseScope({
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/a",
        conversationId: "conv-same",
        opencodeSessionId: "same-session",
      });
      selection.setSelectedSessionId("same-session");
      const guard = selection.captureDisplayedConversationGuard("same-session");

      selection.setSessionBrowseScope({
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/b",
        conversationId: "conv-same",
        opencodeSessionId: "same-session",
      });

      assert.equal(selection.displayedConversationStillMatches(guard), false);
    } finally {
      dispose();
    }
  });
});

test("legacy v1 last-session entries stay untrusted when scoped candidates are ambiguous", () => {
  createRoot((dispose) => {
    try {
      const storage = memoryStorage({
        [SESSION_BY_WORKSPACE_KEY]: JSON.stringify({ "ws-a": "same-session" }),
      });
      const selection = createWorkspaceSessionSelection({
        activeWorkspaceId: () => "ws-a",
        activeWorkspaceRoot: () => "/repo",
        workspaces: () => [
          { id: "ws-a", path: "/repo", workspaceType: "local" },
        ],
        storage,
      });

      selection.rememberConversationScope({
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/a",
        conversationId: "conv-a",
        opencodeSessionId: "same-session",
      });
      selection.rememberConversationScope({
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/b",
        conversationId: "conv-b",
        opencodeSessionId: "same-session",
      });

      assert.equal(selection.activeWorkspaceLastSessionId(), null);
    } finally {
      dispose();
    }
  });
});

test("last-session persistence writes a scoped v2 entry for the selected conversation", () => {
  createRoot((dispose) => {
    try {
      const storage = memoryStorage();
      const selection = createWorkspaceSessionSelection({
        activeWorkspaceId: () => "ws-a",
        activeWorkspaceRoot: () => "/repo",
        workspaces: () => [
          { id: "ws-a", path: "/repo", workspaceType: "local" },
        ],
        storage,
      });

      selection.setSessionBrowseScope({
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/a",
        conversationId: "conv-a",
        opencodeSessionId: "same-session",
      });
      selection.setSelectedSessionId("same-session");

      const persisted = JSON.parse(storage.dump()["veslo.workspace-last-session.v2"] ?? "{}");
      assert.deepEqual(persisted["ws-a"], {
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/a",
        conversationId: "conv-a",
        opencodeSessionId: "same-session",
      });
    } finally {
      dispose();
    }
  });
});

test("scoped v2 last-session storage hydrates browse scope after restart", () => {
  createRoot((dispose) => {
    try {
      const storage = memoryStorage({
        [SESSION_BY_WORKSPACE_KEY_V2]: JSON.stringify({
          "ws-a": {
            sessionId: "same-session",
            workspaceId: "ws-a",
            workspaceRoot: "/repo",
            directory: "/repo/packages/a",
            conversationId: "conv-a",
            opencodeSessionId: "same-session",
          },
        }),
      });
      const selection = createWorkspaceSessionSelection({
        activeWorkspaceId: () => "ws-a",
        activeWorkspaceRoot: () => "/repo",
        workspaces: () => [
          { id: "ws-a", path: "/repo", workspaceType: "local" },
        ],
        storage,
      });

      assert.equal(selection.activeWorkspaceLastSessionId(), "same-session");
      assert.deepEqual(selection.resolveSelectedSessionBrowseScope("same-session"), {
        sessionId: "same-session",
        workspaceId: "ws-a",
        workspaceRoot: "/repo",
        directory: "/repo/packages/a",
        conversationId: "conv-a",
        opencodeSessionId: "same-session",
        updatedAt: 0,
      });
    } finally {
      dispose();
    }
  });
});
