import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspaceSendTarget,
  resolvePendingDraftSendTargetWorkspaceScope,
  resolveRoutedClientForSendTarget,
} from "../../context/workspace-send-target.js";

test("pending draft target prefers private workspace and directory before active workspace fallback", () => {
  assert.deepEqual(
    resolvePendingDraftSendTargetWorkspaceScope({
      pendingDraft: {
        workspaceId: "ws-public",
        privateWorkspaceId: "ws-private",
        directory: "/repo/private",
      },
      resolveWorkspaceRoot: (workspaceId, fallback) =>
        workspaceId === "ws-private" ? "/repo/private-root" : fallback ?? "",
    }),
    {
      workspaceId: "ws-private",
      workspaceRoot: "/repo/private-root",
      directory: "/repo/private",
    },
  );
});

test("routed client resolver does not fall back to active client for explicit scoped target", () => {
  const activeClient = { id: "active" };
  const scopedClient = { id: "scoped" };

  assert.equal(
    resolveRoutedClientForSendTarget({
      targetWorkspace: { workspaceId: "ws-b", workspaceRoot: "/repo/b", directory: "/repo/b" },
      routedClient: (workspaceId) => (workspaceId === "ws-b" ? scopedClient : activeClient),
    }),
    scopedClient,
  );

  assert.equal(
    resolveRoutedClientForSendTarget({
      targetWorkspace: { workspaceId: "missing", workspaceRoot: "/repo/missing", directory: "/repo/missing" },
      routedClient: (workspaceId) => (workspaceId ? null : activeClient),
    }),
    null,
    "explicit scoped target must not fall back to the active client",
  );

  assert.equal(
    resolveRoutedClientForSendTarget({
      targetWorkspace: null,
      routedClient: (workspaceId) => (workspaceId ? null : activeClient),
    }),
    activeClient,
  );
});

test("send target resolver keeps direct creation on active workspace after browse-only scoped selection", () => {
  const target = createWorkspaceSendTarget({
    activePendingDraftMeta: () => null,
    resolveWorkspaceRoot: () => "",
    resolveSessionSendTargetScope: (sessionId) =>
      sessionId === "b1" ? { workspaceId: "ws-b", workspaceRoot: "/repo/b", directory: "/repo/b" } : null,
    activeWorkspaceId: () => "ws-a",
    activateWorkspace: async () => true,
    recordSendTrace: () => undefined,
    sendTraceStep: async (_event, run) => run(),
    messageFromUnknownError: (error) => String(error),
  });

  assert.equal(target.resolveSendTargetWorkspaceScope(null), null);
  assert.equal(target.resolveSendTargetWorkspaceScope("b1")?.workspaceId, "ws-b");
});

test("send-time scoped activation activates only when selected session belongs to another workspace", async () => {
  const events: string[] = [];
  const activations: string[] = [];
  const target = createWorkspaceSendTarget({
    activePendingDraftMeta: () => null,
    resolveWorkspaceRoot: () => "",
    resolveSessionSendTargetScope: (sessionId) =>
      sessionId === "b1" ? { workspaceId: "ws-b", workspaceRoot: "/repo/b", directory: "/repo/b" } : null,
    activeWorkspaceId: () => "ws-a",
    activateWorkspace: async (workspaceId) => {
      activations.push(workspaceId);
      return true;
    },
    recordSendTrace: (event) => events.push(event),
    sendTraceStep: async (event, run) => {
      events.push(event);
      return run();
    },
    messageFromUnknownError: (error) => String(error),
  });

  assert.equal(await target.ensureSelectedSessionWorkspaceActiveForSend("b1", "trace-1"), true);
  assert.deepEqual(activations, ["ws-b"]);
  assert.ok(events.includes("sendPrompt:activate-scoped-workspace-call"));

  activations.length = 0;
  assert.equal(await target.ensureSelectedSessionWorkspaceActiveForSend("unknown", "trace-2"), true);
  assert.deepEqual(activations, []);
});
