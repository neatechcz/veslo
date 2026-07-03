import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationService,
  type ConversationServiceClient,
} from "../../context/conversation-service.js";
import type {
  VesloConversationRunInput,
  VesloSessionTranscriptSnapshot,
} from "../../lib/veslo-server.js";

type RememberedScope = {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

function transcript(sessionId: string): VesloSessionTranscriptSnapshot {
  return {
    workspaceId: "server-ws",
    sessionId,
    directory: "/repo",
    conversationId: `conv-${sessionId}`,
    opencodeSessionId: `open-${sessionId}`,
    limit: 12,
    messages: [],
    partsByMessageId: {},
    source: "sqlite",
  };
}

function createFakeClient() {
  const calls: string[] = [];
  let runConversationResult:
    | Awaited<ReturnType<ConversationServiceClient["runConversation"]>>
    | null = null;
  const client = {
    baseUrl: "http://127.0.0.1:8787",
    listWorkspaces: async () => {
      calls.push("listWorkspaces");
      return { items: [], activeId: null };
    },
    addLocalWorkspace: async (input: { path: string }) => {
      calls.push(`addLocalWorkspace:${input.path}`);
      return {
        items: [
          {
            id: "server-ws",
            path: input.path,
            directory: input.path,
          },
        ],
        activeId: "server-ws",
      };
    },
    listConversations: async (workspaceId: string) => {
      calls.push(`listConversations:${workspaceId}`);
      return { workspaceId, items: [], source: "sqlite" as const };
    },
    importConversations: async (workspaceId: string) => {
      calls.push(`importConversations:${workspaceId}`);
      return { workspaceId, items: [] };
    },
    getSessionTranscript: async (workspaceId: string, sessionId: string) => {
      calls.push(`getSessionTranscript:${workspaceId}:${sessionId}`);
      if (sessionId === "sess-unavailable") {
        return {
          ...transcript(sessionId),
          source: "unavailable" as const,
          messages: [],
          partsByMessageId: {},
        };
      }
      return transcript(sessionId);
    },
    createConversation: async (workspaceId: string) => {
      calls.push(`createConversation:${workspaceId}`);
      return {
        id: "sess-created",
        title: "Created",
        time: { created: 1, updated: 1 },
        conversationId: "conv-created",
        opencodeSessionId: "open-created",
      };
    },
    runConversation: async (
      workspaceId: string,
      conversationId: string,
      input: VesloConversationRunInput,
    ) => {
      calls.push(`runConversation:${workspaceId}:${conversationId}:${input.directory ?? ""}`);
      if (runConversationResult) return runConversationResult;
      return {
        ok: true,
        workspaceId,
        conversationId,
        opencodeSessionId: "open-a",
        runId: "run-a",
        status: "submitted" as const,
        kind: input.kind,
      };
    },
    abortConversation: async (workspaceId: string, conversationId: string, input: { runId: string }) => {
      calls.push(`abortConversation:${workspaceId}:${conversationId}:${input.runId}`);
      return {
        ok: true,
        workspaceId,
        conversationId,
        opencodeSessionId: "open-a",
        runId: input.runId,
        status: "submitted" as const,
        kind: "abort" as const,
      };
    },
    getConversationRunStatus: async (workspaceId: string, conversationId: string, runId: string) => ({
      ok: true,
      workspaceId,
      conversationId,
      runId,
      status: "running" as const,
      stale: false,
    }),
    appendSessionTranscript: async (workspaceId: string, sessionId: string, input: { messages: unknown[]; partsByMessageId: Record<string, unknown[]> }) => {
      calls.push(`appendSessionTranscript:${workspaceId}:${sessionId}:${input.messages.length}`);
      return {
        ...transcript(sessionId),
        messages: input.messages as VesloSessionTranscriptSnapshot["messages"],
        partsByMessageId: input.partsByMessageId as VesloSessionTranscriptSnapshot["partsByMessageId"],
      };
    },
  };

  return {
    client: client as unknown as ConversationServiceClient,
    calls,
    setRunConversationResult: (result: Awaited<ReturnType<ConversationServiceClient["runConversation"]>>) => {
      runConversationResult = result;
    },
  };
}

function createService() {
  const { client, calls, setRunConversationResult } = createFakeClient();
  const rememberedScopes: RememberedScope[] = [];
  const rememberedRuns: Array<{
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
    runId?: string | null;
  }> = [];
  const runIds = new Map<string, string>();
  const lifecycleRunIds = new Map<string, string>();
  const rememberRunId = (
    map: Map<string, string>,
    input: {
      workspaceId: string;
      conversationId?: string | null;
      opencodeSessionId?: string | null;
      uiSessionId?: string | null;
      runId?: string | null;
    },
  ) => {
    const runId = input.runId?.trim();
    if (!runId) return;
    for (const id of [input.conversationId, input.opencodeSessionId, input.uiSessionId]) {
      if (id?.trim()) map.set(`${input.workspaceId}\0${id.trim()}`, runId);
    }
  };
  const resolveRunId = (
    map: Map<string, string>,
    input: {
      workspaceId: string;
      conversationId?: string | null;
      opencodeSessionId?: string | null;
      uiSessionId?: string | null;
    },
  ) => {
    for (const id of [input.conversationId, input.opencodeSessionId, input.uiSessionId]) {
      const runId = id?.trim() ? map.get(`${input.workspaceId}\0${id.trim()}`) : "";
      if (runId) return runId;
    }
    return "";
  };

  const service = createConversationService({
    vesloServerClient: () => client,
    vesloServerStatus: () => "connected",
    isTauriRuntime: () => true,
    startupPreference: () => "local",
    ensureLocalVesloServerRunning: async () => true,
    workspaces: () => [
      {
        id: "app-ws",
        name: "Repo",
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
      },
    ],
    activeWorkspaceId: () => "app-ws",
    activeWorkspaceRoot: () => "/repo",
    sessionDirectoryOverrideById: () => ({}),
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-a"
        ? {
            sessionId,
            workspaceId: "app-ws",
            workspaceRoot: "/repo",
            directory: "/repo",
            conversationId: "conv-a",
            opencodeSessionId: "open-a",
          }
        : null,
    resolveWorkspaceRootForConversationScope: () => "/repo",
    rememberConversationScope: (scope) => rememberedScopes.push(scope),
    rememberConversationScopesFromSessions: () => undefined,
    rememberConversationScopeFromTranscript: (workspaceId, directory, snapshot) => {
      if (!snapshot) return;
      rememberedScopes.push({
        sessionId: snapshot.opencodeSessionId || snapshot.sessionId,
        workspaceId,
        workspaceRoot: directory ?? snapshot.directory ?? "",
        directory: directory ?? snapshot.directory ?? "",
        conversationId: snapshot.conversationId,
        opencodeSessionId: snapshot.opencodeSessionId,
      });
    },
    rememberLatestConversationRunId: (input) => {
      rememberedRuns.push(input);
      rememberRunId(runIds, input);
    },
    resolveLatestConversationRunId: (input) => resolveRunId(runIds, input),
    rememberLatestConversationLifecycleRunId: (input) => rememberRunId(lifecycleRunIds, input),
    resolveLatestConversationLifecycleRunId: (input) => resolveRunId(lifecycleRunIds, input),
    managedAiAccess: () => null,
    activeSendTraceId: () => null,
    recordSendTrace: () => undefined,
    sendTraceStep: async (_event, run) => run(),
    recordExternalSendTraceEntries: () => undefined,
    engineInfo: async () => ({
      baseUrl: "http://127.0.0.1:4096/workspace/server-ws/opencode",
      projectDir: "/repo",
      opencodeUsername: "user",
      opencodePassword: "pass",
    }),
    wsDebug: () => undefined,
  });

  return { service, calls, rememberedScopes, rememberedRuns, setRunConversationResult };
}

test("conversation read workspace registration is cached per client and directory", async () => {
  const { service, calls } = createService();

  assert.equal(await service.ensureConversationReadWorkspaceRegistered(
    service.vesloServerClient()!,
    "app-ws",
    "/repo",
  ), "server-ws");
  assert.equal(await service.ensureConversationReadWorkspaceRegistered(
    service.vesloServerClient()!,
    "app-ws",
    "/repo",
  ), "server-ws");

  assert.deepEqual(calls.filter((call) => call.startsWith("addLocalWorkspace")), [
    "addLocalWorkspace:/repo",
  ]);
});

test("conversation transcript read preserves unavailable snapshots at the app boundary", async () => {
  const { service, rememberedScopes } = createService();

  const snapshot = await service.getTranscriptFromVesloReadApi(
    "app-ws",
    "sess-unavailable",
    12,
    "/repo",
  );

  assert.equal(snapshot?.source, "unavailable");
  assert.equal(snapshot?.sessionId, "sess-unavailable");
  assert.deepEqual(snapshot?.messages, []);
  assert.equal(
    rememberedScopes.length,
    1,
    "unavailable snapshots still carry identity sidecars that must be remembered",
  );
});

test("conversation transcript append forwards empty available snapshots", async () => {
  const { service, calls } = createService();

  await service.appendTranscriptSnapshot({
    workspaceId: "app-ws",
    sessionId: "open-empty",
    directory: "/repo",
    limit: 140,
    reason: "live-recovery",
    messages: [],
    partsByMessageId: {},
  });

  assert.deepEqual(calls.filter((call) => call.startsWith("appendSessionTranscript")), [
    "appendSessionTranscript:server-ws:open-empty:0",
  ]);
});

test("conversation run remembers submitted run ids under Veslo and UI identities", async () => {
  const { service, rememberedRuns, rememberedScopes } = createService();

  const result = await service.runConversationFromVesloWriteApi("sess-a", {
    kind: "prompt_async",
    directory: "/repo",
  });

  assert.equal(result?.status, "submitted");
  assert.deepEqual(rememberedRuns[0], {
    workspaceId: "app-ws",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    uiSessionId: "sess-a",
    runId: "run-a",
  });
  assert.equal(rememberedScopes[0]?.sessionId, "open-a");
  assert.equal(rememberedScopes[0]?.conversationId, "conv-a");
});

test("queued conversation runs keep the active run id as the current abort target", async () => {
  const { service, rememberedRuns, setRunConversationResult } = createService();
  setRunConversationResult({
    ok: true,
    workspaceId: "server-ws",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    reservedRunId: "run-reserved",
    queueItemId: "queue-a",
    activeRunId: "  run-active  ",
    queuePosition: 1,
    status: "queued",
    kind: "prompt_async",
  });

  const result = await service.runConversationFromVesloWriteApi("sess-a", {
    kind: "prompt_async",
    directory: "/repo",
  });

  assert.equal(result?.status, "queued");
  assert.deepEqual(rememberedRuns[0], {
    workspaceId: "app-ws",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    uiSessionId: "sess-a",
    runId: "run-active",
  });
});

test("conversation abort requires an explicit scoped run id before calling Veslo abort", async () => {
  const { service, calls } = createService();

  await assert.rejects(
    () => service.abortConversationFromVesloWriteApi("missing-run", {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
      conversationId: "conv-missing",
      opencodeSessionId: "open-missing",
    }),
    /Conversation run id is not available for abort\./,
  );

  assert.equal(calls.some((call) => call.startsWith("abortConversation")), false);
});
