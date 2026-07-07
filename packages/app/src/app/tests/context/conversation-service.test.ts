import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationService,
  type ConversationServiceClient,
} from "../../context/conversation-service.js";
import type { ManagedAiRuntimeAuthPrimeDiagnostic } from "../../context/managed-ai-runtime-config.js";
import type {
  VesloConversationAbortInput,
  VesloConversationRunInput,
  VesloConversationSubmitRequest,
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

type FakeWorkspaceRegistryItem = {
  id: string;
  path?: string;
  directory?: string;
  baseUrl?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
  };
};

type SubmitConversationCall = {
  workspaceId: string;
  input: VesloConversationSubmitRequest;
  options?: Parameters<ConversationServiceClient["submitConversation"]>[2];
};

function createFakeClient(options: {
  listWorkspaceItems?: FakeWorkspaceRegistryItem[];
  addLocalWorkspaceItems?: FakeWorkspaceRegistryItem[];
  failWorkspaceRegistration?: boolean;
} = {}) {
  const calls: string[] = [];
  const submitConversationCalls: SubmitConversationCall[] = [];
  const listWorkspaceItems = options.listWorkspaceItems ?? [];
  let runConversationResult:
    | Awaited<ReturnType<ConversationServiceClient["runConversation"]>>
    | null = null;
  let submitConversationResult:
    | Awaited<ReturnType<ConversationServiceClient["submitConversation"]>>
    | null = null;
  const client = {
    baseUrl: "http://127.0.0.1:8787",
    listWorkspaces: async () => {
      calls.push("listWorkspaces");
      return { items: listWorkspaceItems, activeId: listWorkspaceItems[0]?.id ?? null };
    },
    addLocalWorkspace: async (input: { path: string }) => {
      calls.push(`addLocalWorkspace:${input.path}`);
      if (options.failWorkspaceRegistration) {
        throw new Error("registration unavailable");
      }
      const items = options.addLocalWorkspaceItems ?? [
        {
          id: "server-ws",
          path: input.path,
          directory: input.path,
        },
      ];
      return {
        items,
        activeId: items[0]?.id ?? null,
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
    submitConversation: async (
      workspaceId: string,
      input: VesloConversationSubmitRequest,
      submitOptions?: Parameters<ConversationServiceClient["submitConversation"]>[2],
    ) => {
      calls.push(`submitConversation:${workspaceId}:${input.options?.expectAiGatewayStart === true}`);
      submitConversationCalls.push({ workspaceId, input, options: submitOptions });
      if (submitConversationResult) return submitConversationResult;
      return {
        status: "submitted" as const,
        workspaceId,
        conversationId: input.target?.conversationId ?? "conv-a",
        opencodeSessionId: input.target?.opencodeSessionId ?? "open-a",
        runId: "run-submit",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear" as const,
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
    abortConversation: async (workspaceId: string, conversationId: string, input: VesloConversationAbortInput) => {
      const runId = input.runId?.trim() || "active";
      calls.push(`abortConversation:${workspaceId}:${conversationId}:${runId}`);
      return {
        ok: true,
        workspaceId,
        conversationId,
        opencodeSessionId: "open-a",
        runId,
        status: "submitted" as const,
        kind: "abort" as const,
      };
    },
    getConversationRunStatus: async (workspaceId: string, conversationId: string, runId: string) => {
      calls.push(`getConversationRunStatus:${workspaceId}:${conversationId}:${runId}`);
      return {
        ok: true,
        workspaceId,
        conversationId,
        runId,
        status: "running" as const,
        stale: false,
      };
    },
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
    submitConversationCalls,
    setRunConversationResult: (result: Awaited<ReturnType<ConversationServiceClient["runConversation"]>>) => {
      runConversationResult = result;
    },
    setSubmitConversationResult: (result: Awaited<ReturnType<ConversationServiceClient["submitConversation"]>>) => {
      submitConversationResult = result;
    },
  };
}

function createService(options: {
  startDisconnected?: boolean;
  workspaceVesloWorkspaceId?: string | null;
  listWorkspaceItems?: FakeWorkspaceRegistryItem[];
  addLocalWorkspaceItems?: FakeWorkspaceRegistryItem[];
  failWorkspaceRegistration?: boolean;
  engineBaseWorkspaceId?: string;
  managedAiAccess?: {
    providerId?: string | null;
    defaultModel?: { modelID?: string | null } | null;
  } | null;
  runtimeAuthorizationResult?: boolean;
  runtimeAuthorizationDiagnostic?: ManagedAiRuntimeAuthPrimeDiagnostic | null;
} = {}) {
  const { client, calls, submitConversationCalls, setRunConversationResult, setSubmitConversationResult } = createFakeClient({
    listWorkspaceItems: options.listWorkspaceItems,
    addLocalWorkspaceItems: options.addLocalWorkspaceItems,
    failWorkspaceRegistration: options.failWorkspaceRegistration,
  });
  let serverClient: ConversationServiceClient | null = options.startDisconnected ? null : client;
  const engineBaseWorkspaceId = options.engineBaseWorkspaceId ?? "server-ws";
  const ensureCalls: string[] = [];
  const rememberedScopes: RememberedScope[] = [];
  const sendTraces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const rememberedRuns: Array<{
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
    runId?: string | null;
  }> = [];
  const runtimeAuthorizationCalls: unknown[] = [];
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
    vesloServerClient: () => serverClient,
    vesloServerStatus: () => serverClient ? "connected" : "disconnected",
    isTauriRuntime: () => true,
    startupPreference: () => "local",
    ensureLocalVesloServerRunning: async () => {
      ensureCalls.push("ensure-local-server");
      serverClient = client;
      return true;
    },
    workspaces: () => [
      {
        id: "app-ws",
        name: "Repo",
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
        vesloWorkspaceId: options.workspaceVesloWorkspaceId ?? null,
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
    managedAiAccess: () => options.managedAiAccess ?? null,
    ensureManagedAiRuntimeAuthorizationForSend: async (targetWorkspace) => {
      runtimeAuthorizationCalls.push(targetWorkspace ?? null);
      calls.push(
        `ensureManagedAiRuntimeAuthorizationForSend:${targetWorkspace?.workspaceId ?? ""}:${targetWorkspace?.directory ?? ""}`,
      );
      return options.runtimeAuthorizationResult ?? true;
    },
    managedAiRuntimeAuthorizationPrimeDiagnostic: () => options.runtimeAuthorizationDiagnostic ?? null,
    activeSendTraceId: () => null,
    recordSendTrace: (event, payload) => {
      sendTraces.push({ event, payload });
    },
    sendTraceStep: async (_event, run) => run(),
    recordExternalSendTraceEntries: () => undefined,
    engineInfo: async () => ({
      baseUrl: `http://127.0.0.1:4096/workspace/${encodeURIComponent(engineBaseWorkspaceId)}/opencode`,
      projectDir: "/repo",
      opencodeUsername: "user",
      opencodePassword: "pass",
    }),
    wsDebug: () => undefined,
  });

  return {
    service,
    calls,
    submitConversationCalls,
    ensureCalls,
    rememberedScopes,
    rememberedRuns,
    sendTraces,
    runtimeAuthorizationCalls,
    setRunConversationResult,
    setSubmitConversationResult,
  };
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

test("mapped local workspace id is used for server calls while app scopes stay local", async () => {
  const mappedWorkspaceId = "server-ws-mapped";
  const opencodeBaseUrl = `http://127.0.0.1:4096/workspace/${mappedWorkspaceId}/opencode`;
  const { service, calls, rememberedScopes } = createService({
    workspaceVesloWorkspaceId: mappedWorkspaceId,
    engineBaseWorkspaceId: mappedWorkspaceId,
    listWorkspaceItems: [
      {
        id: mappedWorkspaceId,
        path: "/repo",
        directory: "/repo",
        baseUrl: opencodeBaseUrl,
      },
    ],
  });

  assert.equal(service.resolveConversationServerWorkspaceId("app-ws"), mappedWorkspaceId);

  const result = await service.createConversationFromVesloWriteApi("app-ws", "/repo", "Mapped");

  assert.equal(result?.id, "sess-created");
  assert.equal(calls.includes(`createConversation:${mappedWorkspaceId}`), true);
  assert.equal(
    calls.some((call) => call.startsWith("addLocalWorkspace:")),
    false,
    "existing mapped server workspace should not be re-registered",
  );
  assert.equal(rememberedScopes[0]?.workspaceId, "app-ws");
  assert.equal(rememberedScopes[0]?.conversationId, "conv-created");
});

test("unmapped local workspace id is not treated as a server workspace id", () => {
  const { service } = createService();

  assert.equal(service.resolveConversationServerWorkspaceId("app-ws"), "");
});

test("local workspace registration rejects exact id matches without path evidence", async () => {
  const { service, calls } = createService({
    failWorkspaceRegistration: true,
    listWorkspaceItems: [
      {
        id: "app-ws",
        path: "/other",
        directory: "/other",
      },
    ],
  });

  assert.equal(await service.ensureConversationReadWorkspaceRegistered(
    service.vesloServerClient()!,
    "app-ws",
    "/repo",
  ), "");
  assert.deepEqual(calls, [
    "listWorkspaces",
    "addLocalWorkspace:/repo",
  ]);
});

test("local workspace registration failure does not continue with fallback app workspace id", async () => {
  const cases: Array<{
    name: string;
    run: (service: ReturnType<typeof createService>["service"]) => Promise<unknown>;
  }> = [
    {
      name: "list",
      run: async (service) => {
        const result = await service.listConversationsFromVesloReadApi("app-ws", "/repo");
        assert.equal(result.source, "unavailable");
        return result;
      },
    },
    {
      name: "backfill",
      run: (service) => service.backfillConversationsToVesloReadApi("app-ws", "/repo", [
        {
          id: "sess-import",
          slug: "sess-import",
          projectID: "app-ws",
          directory: "/repo",
          version: "1",
          title: "Import",
          time: { created: 1, updated: 1 },
        },
      ]),
    },
    {
      name: "transcript",
      run: async (service) => {
        const result = await service.getTranscriptFromVesloReadApi("app-ws", "sess-a", 10, "/repo");
        assert.equal(result, null);
        return result;
      },
    },
    {
      name: "create",
      run: async (service) => {
        const result = await service.createConversationFromVesloWriteApi("app-ws", "/repo", "Create");
        assert.equal(result, null);
        return result;
      },
    },
    {
      name: "run",
      run: async (service) => {
        const result = await service.runConversationFromVesloWriteApi("sess-a", {
          kind: "prompt_async",
          directory: "/repo",
        });
        assert.equal(result, null);
        return result;
      },
    },
    {
      name: "abort",
      run: async (service) => {
        const result = await service.abortConversationFromVesloWriteApi("sess-a");
        assert.equal(result, null);
        return result;
      },
    },
    {
      name: "status",
      run: async (service) => {
        const result = await service.readConversationRunStatus({
          workspaceId: "app-ws",
          directory: "/repo",
          conversationId: "conv-a",
          runId: "run-a",
        });
        assert.equal(result, null);
        return result;
      },
    },
    {
      name: "append",
      run: (service) => service.appendTranscriptSnapshot({
        workspaceId: "app-ws",
        sessionId: "sess-a",
        directory: "/repo",
        messages: [],
        partsByMessageId: {},
      }),
    },
  ];

  for (const entry of cases) {
    const { service, calls } = createService({ failWorkspaceRegistration: true });
    await entry.run(service);
    assert.equal(
      calls.some((call) => /(?:listConversations|importConversations|getSessionTranscript|createConversation|runConversation|abortConversation|getConversationRunStatus|appendSessionTranscript):app-ws(?::|$)/.test(call)),
      false,
      `${entry.name} should not call a server API with fallback app workspace id; calls=${calls.join(",")}`,
    );
  }
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

test("passive browse reads do not start the local conversation server", async () => {
  const { service, ensureCalls } = createService({ startDisconnected: true });

  const result = await service.listConversationsFromVesloReadApi("app-ws", "/repo");

  assert.equal(result.source, "unavailable");
  assert.deepEqual(result.items, []);
  assert.deepEqual(ensureCalls, []);
});

test("status polls do not start the local conversation server", async () => {
  const { service, ensureCalls } = createService({ startDisconnected: true });

  const result = await service.readConversationRunStatus({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    runId: "run-a",
  });

  assert.equal(result, null);
  assert.deepEqual(ensureCalls, []);
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
  assert.deepEqual(rememberedScopes.map((scope) => scope.sessionId), ["open-a", "sess-a"]);
  assert.equal(rememberedScopes[0]?.conversationId, "conv-a");
  assert.equal(rememberedScopes[1]?.conversationId, "conv-a");
});

test("conversation submit remembers queued run ids under request and result identities", async () => {
  const { service, rememberedRuns, rememberedScopes, setSubmitConversationResult, sendTraces } = createService();
  setSubmitConversationResult({
    status: "queued",
    workspaceId: "server-ws",
    conversationId: "conv-submit",
    opencodeSessionId: "open-submit",
    queueItemId: "queue-submit",
    reservedRunId: "run-submit-reserved",
    queuePosition: 1,
    clientMessageId: "msg-submit",
    draftDisposition: "clear",
  });

  const result = await service.submitConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    {
      clientMessageId: "msg-submit",
      origin: "session:queue-drain",
      target: {
        conversationId: "conv-request",
        opencodeSessionId: "ui-session",
        pendingClientSessionId: "pending-submit",
      },
      draft: {
        mode: "prompt",
        text: "queued submit",
        parts: [{ type: "text", text: "queued submit" }],
      },
    },
    {
      traceId: "trace-submit",
      targetWorkspace: {
        workspaceId: "app-ws",
        workspaceRoot: "/repo",
        directory: "/repo",
      },
      conversationWorkspaceByDirectory: new Map(),
    },
  );

  assert.equal(result?.status, "queued");
  assert.deepEqual(rememberedScopes.map((scope) => scope.sessionId), [
    "pending-submit",
    "ui-session",
    "open-submit",
    "conv-request",
    "conv-submit",
  ]);
  assert.ok(rememberedScopes.every((scope) => scope.workspaceId === "app-ws"));
  assert.ok(rememberedScopes.every((scope) => scope.conversationId === "conv-submit"));
  assert.ok(rememberedScopes.every((scope) => scope.opencodeSessionId === "open-submit"));
  assert.deepEqual(rememberedRuns[0], {
    workspaceId: "app-ws",
    conversationId: "conv-submit",
    opencodeSessionId: "open-submit",
    uiSessionId: "ui-session",
    runId: "run-submit-reserved",
  });
  assert.ok(sendTraces.some((entry) =>
    entry.event === "submitConversationFromVesloWriteApi:conversation-scope-remembered" &&
    entry.payload?.aliasCount === 5
  ));
});

test("managed conversation runs prime runtime authorization before submit", async () => {
  const { service, calls, runtimeAuthorizationCalls } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
  });

  const result = await service.runConversationFromVesloWriteApi("sess-a", {
    kind: "prompt_async",
    directory: "/repo",
  }, {
    targetWorkspace: {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
    },
  });

  assert.equal(result?.status, "submitted");
  assert.deepEqual(runtimeAuthorizationCalls, [{
    workspaceId: "app-ws",
    workspaceRoot: "/repo",
    directory: "/repo",
  }]);
  const authPrimeIndex = calls.findIndex((call) => call.startsWith("ensureManagedAiRuntimeAuthorizationForSend:"));
  const runIndex = calls.findIndex((call) => call.startsWith("runConversation:"));
  assert.ok(authPrimeIndex >= 0, "runtime authorization should be primed");
  assert.ok(runIndex >= 0, "conversation should be submitted");
  assert.ok(authPrimeIndex < runIndex, "runtime authorization must be primed before submit");
});

test("managed conversation submit primes runtime authorization and forwards gateway expectation", async () => {
  const { service, calls, runtimeAuthorizationCalls } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
  });

  const result = await service.submitConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    {
      clientMessageId: "msg-submit-managed",
      origin: "session:normal",
      target: {
        conversationId: "conv-a",
        opencodeSessionId: "open-a",
      },
      draft: {
        mode: "prompt",
        text: "managed submit",
        parts: [{ type: "text", text: "managed submit" }],
      },
    },
    {
      traceId: "trace-submit-managed",
      targetWorkspace: {
        workspaceId: "app-ws",
        workspaceRoot: "/repo",
        directory: "/repo",
      },
      conversationWorkspaceByDirectory: new Map(),
    },
  );

  assert.equal(result?.status, "submitted");
  assert.deepEqual(runtimeAuthorizationCalls, [{
    workspaceId: "app-ws",
    workspaceRoot: "/repo",
    directory: "/repo",
  }]);
  const authPrimeIndex = calls.findIndex((call) => call.startsWith("ensureManagedAiRuntimeAuthorizationForSend:"));
  const submitIndex = calls.findIndex((call) => call.startsWith("submitConversation:"));
  assert.ok(authPrimeIndex >= 0, "runtime authorization should be primed");
  assert.ok(submitIndex >= 0, "conversation should be submitted");
  assert.ok(authPrimeIndex < submitIndex, "runtime authorization must be primed before submit");
  assert.ok(calls.includes("submitConversation:server-ws:true"));
});

test("conversation submit boundary injects directory and preserves composer send intent", async () => {
  const { service, submitConversationCalls, runtimeAuthorizationCalls } = createService();

  const result = await service.submitConversationFromVesloWriteApi(
    "app-ws",
    "/repo/packages/app",
    {
      clientMessageId: "msg-submit-boundary",
      origin: "session:send-now",
      source: "send-now",
      target: {
        directory: "/stale-directory",
        conversationId: "conv-a",
        opencodeSessionId: "open-a",
      },
      draft: {
        mode: "prompt",
        text: "boundary prompt",
        parts: [{ type: "text", text: "boundary prompt" }],
      },
      options: {
        model: { providerID: "openai", modelID: "gpt-4.1" },
        submitQueuePolicy: "send-now",
      },
    },
    {
      traceId: "trace-submit-boundary",
      targetWorkspace: {
        workspaceId: "app-ws",
        workspaceRoot: "/repo",
        directory: "/repo/packages/app",
      },
      conversationWorkspaceByDirectory: new Map(),
    },
  );

  assert.equal(result?.status, "submitted");
  assert.deepEqual(runtimeAuthorizationCalls, []);
  assert.equal(submitConversationCalls.length, 1);
  assert.equal(submitConversationCalls[0]?.workspaceId, "server-ws");
  assert.deepEqual(submitConversationCalls[0]?.options, { sendTraceId: "trace-submit-boundary" });
  assert.deepEqual(submitConversationCalls[0]?.input, {
    clientMessageId: "msg-submit-boundary",
    origin: "session:send-now",
    source: "send-now",
    target: {
      directory: "/repo/packages/app",
      conversationId: "conv-a",
      opencodeSessionId: "open-a",
    },
    draft: {
      mode: "prompt",
      text: "boundary prompt",
      parts: [{ type: "text", text: "boundary prompt" }],
    },
    options: {
      model: { providerID: "openai", modelID: "gpt-4.1" },
      submitQueuePolicy: "send-now",
    },
  });
});

test("managed conversation submit stops before server contact when runtime authorization is not ready", async () => {
  const authPrimeDiagnostic: ManagedAiRuntimeAuthPrimeDiagnostic = {
    reason: "request-failed",
    supportMessage: "Managed AI runtime authorization could not be refreshed. Check the local Veslo server connection and retry.",
    message: "HTTP 504",
  };
  const { service, calls, runtimeAuthorizationCalls, submitConversationCalls, sendTraces } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
    runtimeAuthorizationResult: false,
    runtimeAuthorizationDiagnostic: authPrimeDiagnostic,
  });

  await assert.rejects(
    () => service.submitConversationFromVesloWriteApi(
      "app-ws",
      "/repo",
      {
        clientMessageId: "msg-submit-auth-blocked",
        origin: "session:normal",
        target: {
          conversationId: "conv-a",
          opencodeSessionId: "open-a",
        },
        draft: {
          mode: "prompt",
          text: "managed submit",
          parts: [{ type: "text", text: "managed submit" }],
        },
      },
      {
        traceId: "trace-submit-auth-blocked",
        targetWorkspace: {
          workspaceId: "app-ws",
          workspaceRoot: "/repo",
          directory: "/repo",
        },
        conversationWorkspaceByDirectory: new Map(),
      },
    ),
    /Managed AI gateway authorization is not ready/,
  );

  assert.deepEqual(runtimeAuthorizationCalls, [{
    workspaceId: "app-ws",
    workspaceRoot: "/repo",
    directory: "/repo",
  }]);
  assert.equal(submitConversationCalls.length, 0);
  assert.equal(calls.some((call) => call.startsWith("submitConversation:")), false);
  const authPrimeResult = sendTraces.find((entry) =>
    entry.event === "submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime:result"
  );
  assert.equal(authPrimeResult?.payload?.ready, false);
  assert.equal(authPrimeResult?.payload?.authPrimeDiagnosticReason, "request-failed");
  assert.deepEqual(authPrimeResult?.payload?.authPrimeDiagnostic, authPrimeDiagnostic);
});

test("managed shell conversation submit does not prime AI gateway authorization", async () => {
  const { service, submitConversationCalls, runtimeAuthorizationCalls } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
  });

  const result = await service.submitConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    {
      clientMessageId: "msg-submit-shell",
      origin: "session:normal",
      target: {
        conversationId: "conv-a",
        opencodeSessionId: "open-a",
      },
      draft: {
        mode: "shell",
        text: "pnpm test",
        parts: [{ type: "text", text: "pnpm test" }],
      },
    },
    {
      traceId: "trace-submit-shell",
      targetWorkspace: {
        workspaceId: "app-ws",
        workspaceRoot: "/repo",
        directory: "/repo",
      },
      conversationWorkspaceByDirectory: new Map(),
    },
  );

  assert.equal(result?.status, "submitted");
  assert.deepEqual(runtimeAuthorizationCalls, []);
  assert.equal(submitConversationCalls.length, 1);
  assert.equal(submitConversationCalls[0]?.input.options?.expectAiGatewayStart, undefined);
  assert.equal(submitConversationCalls[0]?.input.draft.mode, "shell");
});

test("managed conversation runs stop before submit when runtime authorization is not ready", async () => {
  const { service, calls } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
    runtimeAuthorizationResult: false,
  });

  await assert.rejects(
    () => service.runConversationFromVesloWriteApi("sess-a", {
      kind: "prompt_async",
      directory: "/repo",
    }),
    /Managed AI gateway authorization is not ready/,
  );

  assert.equal(calls.some((call) => call.startsWith("runConversation:")), false);
});

test("conversation run requires a scoped workspace instead of falling back to the active workspace", async () => {
  const { service, calls } = createService();

  await assert.rejects(
    () => service.runConversationFromVesloWriteApi("unknown-session", {
      kind: "prompt_async",
      directory: "/repo",
    }),
    /scoped workspace/,
  );

  assert.equal(calls.some((call) => call.startsWith("runConversation:")), false);
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

test("conversation abort uses active server resolution when the local run id is missing", async () => {
  const { service, calls } = createService();

  const result = await service.abortConversationFromVesloWriteApi("missing-run", {
    workspaceId: "app-ws",
    workspaceRoot: "/repo",
    directory: "/repo",
    conversationId: "conv-missing",
    opencodeSessionId: "open-missing",
  });

  assert.equal(result?.runId, "active");
  assert.equal(calls.some((call) => call === "abortConversation:server-ws:conv-missing:active"), true);
});

test("conversation abort write-control paths may start the local conversation server", async () => {
  const { service, calls, ensureCalls } = createService({ startDisconnected: true });

  const result = await service.abortConversationFromVesloWriteApi("missing-run", {
    workspaceId: "app-ws",
    workspaceRoot: "/repo",
    directory: "/repo",
    conversationId: "conv-missing",
    opencodeSessionId: "open-missing",
  });

  assert.equal(result?.runId, "active");
  assert.deepEqual(ensureCalls, ["ensure-local-server"]);
  assert.equal(calls.some((call) => call === "abortConversation:server-ws:conv-missing:active"), true);
});
