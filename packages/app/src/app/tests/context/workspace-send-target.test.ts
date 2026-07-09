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

test("send target keeps the selected pending draft workspace after active workspace switch", () => {
  const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const target = createWorkspaceSendTarget({
    activePendingDraftMeta: () => ({
      workspaceId: "ws-a",
      privateWorkspaceId: null,
      directory: "/repo/a",
    }),
    resolveWorkspaceRoot: (workspaceId, fallback) => (workspaceId === "ws-a" ? "/repo/a" : fallback ?? ""),
    resolveSessionSendTargetScope: (sessionId) =>
      sessionId
        ? null
        : {
            workspaceId: "ws-b",
            workspaceRoot: "/repo/b",
            directory: "/repo/b",
          },
    activeWorkspaceId: () => "ws-b",
    activateWorkspace: async () => true,
    recordSendTrace: (event, payload) => events.push({ event, payload }),
    sendTraceStep: async (_event, run) => run(),
    messageFromUnknownError: (error) => String(error),
  });

  assert.deepEqual(target.resolveSendTargetWorkspaceScope(null), {
    workspaceId: "ws-a",
    workspaceRoot: "/repo/a",
    directory: "/repo/a",
  });
  assert.deepEqual(events, []);
});

test("send target keeps pending draft scope while it still matches active workspace", () => {
  const target = createWorkspaceSendTarget({
    activePendingDraftMeta: () => ({
      workspaceId: "ws-a",
      privateWorkspaceId: null,
      directory: "/repo/a/pending",
    }),
    resolveWorkspaceRoot: () => "/repo/a",
    resolveSessionSendTargetScope: () => null,
    activeWorkspaceId: () => "ws-a",
    activateWorkspace: async () => true,
    recordSendTrace: () => undefined,
    sendTraceStep: async (_event, run) => run(),
    messageFromUnknownError: (error) => String(error),
  });

  assert.deepEqual(target.resolveSendTargetWorkspaceScope(null), {
    workspaceId: "ws-a",
    workspaceRoot: "/repo/a",
    directory: "/repo/a/pending",
  });
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

test("send-time scoped activation does not treat active fallback as explicit session scope", async () => {
  const traces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const target = createWorkspaceSendTarget({
    activePendingDraftMeta: () => null,
    resolveWorkspaceRoot: () => "",
    resolveSessionSendTargetScope: () => ({
      workspaceId: "ws-a",
      workspaceRoot: "/repo/a",
      directory: "/repo/a",
    }),
    resolveSelectedSessionBrowseScope: () => null,
    activeWorkspaceId: () => "ws-a",
    activateWorkspace: async () => {
      throw new Error("unexpected activation");
    },
    recordSendTrace: (event, payload) => traces.push({ event, payload }),
    sendTraceStep: async (event, run) => {
      traces.push({ event });
      return run();
    },
    messageFromUnknownError: (error) => String(error),
  });

  assert.equal(await target.ensureSelectedSessionWorkspaceActiveForSend("unknown", "trace-1"), true);
  const events = traces.map((entry) => entry.event);
  assert.ok(events.includes("sendPrompt:scoped-workspace-skipped-no-scope"));
  assert.ok(!events.includes("sendPrompt:scoped-workspace-already-active"));
  const skipped = traces.find((entry) => entry.event === "sendPrompt:scoped-workspace-skipped-no-scope");
  assert.equal(skipped?.payload?.reason, "active-fallback-not-authoritative");
  assert.equal(skipped?.payload?.sessionId, "unknown");
  assert.equal(skipped?.payload?.selectedSessionId, "unknown");
  assert.equal(skipped?.payload?.activeWorkspaceId, "ws-a");
  assert.equal(skipped?.payload?.sendTargetWorkspaceId, "ws-a");
  assert.equal(skipped?.payload?.hasBrowseScope, false);
  assert.equal(skipped?.payload?.hasSendTargetWorkspace, true);
  assert.equal(skipped?.payload?.scopeCandidateCount, 1);
});

test("send-time scoped activation blocks when browse and authoritative send-target scopes are both missing", async () => {
  const traces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const target = createWorkspaceSendTarget({
    activePendingDraftMeta: () => null,
    resolveWorkspaceRoot: () => "",
    resolveSessionSendTargetScope: () => null,
    resolveSelectedSessionBrowseScope: () => null,
    activeWorkspaceId: () => "ws-a",
    activateWorkspace: async () => {
      throw new Error("unexpected activation");
    },
    recordSendTrace: (event, payload) => traces.push({ event, payload }),
    sendTraceStep: async (event, run) => {
      traces.push({ event });
      return run();
    },
    messageFromUnknownError: (error) => String(error),
  });

  assert.equal(await target.ensureSelectedSessionWorkspaceActiveForSend("missing", "trace-1"), false);
  assert.deepEqual(traces.map((entry) => entry.event), ["sendPrompt:scoped-workspace-blocked-missing-scope"]);
  assert.equal(traces[0]?.payload?.sessionId, "missing");
  assert.equal(traces[0]?.payload?.selectedSessionId, "missing");
  assert.equal(traces[0]?.payload?.activeWorkspaceId, "ws-a");
  assert.equal(traces[0]?.payload?.browseScopeWorkspaceId, null);
  assert.equal(traces[0]?.payload?.sendTargetWorkspaceId, null);
  assert.equal(traces[0]?.payload?.hasBrowseScope, false);
  assert.equal(traces[0]?.payload?.hasSendTargetWorkspace, false);
  assert.equal(traces[0]?.payload?.scopeCandidateCount, 0);
});

test("send-time scoped activation can recover from a missing hydrated browse scope", async () => {
  const events: string[] = [];
  const activations: string[] = [];
  const target = createWorkspaceSendTarget({
    activePendingDraftMeta: () => null,
    resolveWorkspaceRoot: () => "",
    resolveSessionSendTargetScope: (sessionId) =>
      sessionId === "b1" ? { workspaceId: "ws-b", workspaceRoot: "/repo/b", directory: "/repo/b" } : null,
    resolveSelectedSessionBrowseScope: () => null,
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
  assert.ok(!events.includes("sendPrompt:scoped-workspace-skipped-no-scope"));
});
