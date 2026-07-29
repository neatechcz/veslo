import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationService,
  type ConversationServiceClient,
} from "../../context/conversation-service.js";
import type { ManagedAiRuntimeAuthPrimeDiagnostic } from "../../context/managed-ai-runtime-config.js";
import { VesloServerError } from "../../lib/veslo-server.js";
import type {
  VesloConversationAbortInput,
  VesloConversationRunInput,
  VesloConversationRunStatusResult,
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

type SessionTranscriptCall = {
  workspaceId: string;
  sessionId: string;
  limit?: number;
  directory?: string;
  options?: Parameters<ConversationServiceClient["getSessionTranscript"]>[4];
};

function createFakeClient(
  options: {
    listWorkspaceItems?: FakeWorkspaceRegistryItem[];
    addLocalWorkspaceItems?: FakeWorkspaceRegistryItem[];
    failWorkspaceRegistration?: boolean | "invalid-host-token";
    runStatusError?: unknown;
    runStatusResult?: Partial<VesloConversationRunStatusResult>;
    recoverTranscriptError?: unknown;
    recoverSessionTranscript?: (
      workspaceId: string,
      sessionId: string,
      input: { expectedRunId?: string | null },
    ) => ReturnType<ConversationServiceClient["recoverSessionTranscript"]>;
  } = {},
) {
  const calls: string[] = [];
  const submitConversationCalls: SubmitConversationCall[] = [];
  const sessionTranscriptCalls: SessionTranscriptCall[] = [];
  const listWorkspaceItems = options.listWorkspaceItems ?? [];
  let runConversationResult: Awaited<
    ReturnType<ConversationServiceClient["runConversation"]>
  > | null = null;
  let submitConversationResult: Awaited<
    ReturnType<ConversationServiceClient["submitConversation"]>
  > | null = null;
  const client = {
    baseUrl: "http://127.0.0.1:8787",
    listWorkspaces: async () => {
      calls.push("listWorkspaces");
      return {
        items: listWorkspaceItems,
        activeId: listWorkspaceItems[0]?.id ?? null,
      };
    },
    addLocalWorkspace: async (input: {
      path: string;
      directory?: string;
      baseUrl?: string;
      opencodeUsername?: string;
      opencodePassword?: string;
    }) => {
      calls.push(`addLocalWorkspace:${input.path}`);
      if (options.failWorkspaceRegistration) {
        if (options.failWorkspaceRegistration === "invalid-host-token") {
          throw new VesloServerError(401, "unauthorized", "Invalid host token");
        }
        throw new Error("registration unavailable");
      }
      const items = options.addLocalWorkspaceItems ?? [
        {
          id: "server-ws",
          path: input.path,
          directory: input.directory ?? input.path,
          baseUrl: input.baseUrl,
          opencode: input.baseUrl
            ? {
                baseUrl: input.baseUrl,
                directory: input.directory ?? input.path,
              }
            : undefined,
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
    getSessionTranscript: async (
      workspaceId: string,
      sessionId: string,
      limit?: number,
      directory?: string,
      readOptions?: Parameters<
        ConversationServiceClient["getSessionTranscript"]
      >[4],
    ) => {
      calls.push(`getSessionTranscript:${workspaceId}:${sessionId}`);
      sessionTranscriptCalls.push({
        workspaceId,
        sessionId,
        limit,
        directory,
        options: readOptions,
      });
      if (sessionId === "sess-unavailable") {
        return {
          ...transcript(sessionId),
          source: "unavailable" as const,
          messages: [],
          partsByMessageId: {},
          diagnostic: {
            reason: "database_missing",
            workspaceId,
            sessionId,
            directory: "/repo",
            dbPath: "/missing/opencode.db",
            dbPathExists: false,
          },
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
      submitOptions?: Parameters<
        ConversationServiceClient["submitConversation"]
      >[2],
    ) => {
      calls.push(
        `submitConversation:${workspaceId}:${input.options?.expectAiGatewayStart === true}`,
      );
      submitConversationCalls.push({
        workspaceId,
        input,
        options: submitOptions,
      });
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
      calls.push(
        `runConversation:${workspaceId}:${conversationId}:${input.directory ?? ""}`,
      );
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
    abortConversation: async (
      workspaceId: string,
      conversationId: string,
      input: VesloConversationAbortInput,
    ) => {
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
    getConversationRunStatus: async (
      workspaceId: string,
      conversationId: string,
      runId: string,
    ) => {
      calls.push(
        `getConversationRunStatus:${workspaceId}:${conversationId}:${runId}`,
      );
      if (options.runStatusError) throw options.runStatusError;
      return {
        ok: true,
        workspaceId,
        conversationId,
        runId,
        status: "running" as const,
        stale: false,
        ...options.runStatusResult,
      };
    },
    recoverSessionTranscript: async (
      workspaceId: string,
      sessionId: string,
      input: { expectedRunId?: string | null },
    ) => {
      calls.push(
        `recoverSessionTranscript:${workspaceId}:${sessionId}:${input.expectedRunId ?? ""}`,
      );
      if (options.recoverTranscriptError) throw options.recoverTranscriptError;
      if (options.recoverSessionTranscript) {
        return options.recoverSessionTranscript(workspaceId, sessionId, input);
      }
      return {
        workspaceId,
        conversationId: `conv-${sessionId}`,
        opencodeSessionId: sessionId,
        state: "persisted" as const,
        generation: 1,
        attempts: 1,
        runId: input.expectedRunId ?? null,
      };
    },
    appendSessionTranscript: async (
      workspaceId: string,
      sessionId: string,
      input: {
        messages: unknown[];
        partsByMessageId: Record<string, unknown[]>;
      },
    ) => {
      calls.push(
        `appendSessionTranscript:${workspaceId}:${sessionId}:${input.messages.length}`,
      );
      return {
        ...transcript(sessionId),
        messages: input.messages as VesloSessionTranscriptSnapshot["messages"],
        partsByMessageId:
          input.partsByMessageId as VesloSessionTranscriptSnapshot["partsByMessageId"],
      };
    },
  };

  return {
    client: client as unknown as ConversationServiceClient,
    calls,
    submitConversationCalls,
    sessionTranscriptCalls,
    setRunConversationResult: (
      result: Awaited<ReturnType<ConversationServiceClient["runConversation"]>>,
    ) => {
      runConversationResult = result;
    },
    setSubmitConversationResult: (
      result: Awaited<
        ReturnType<ConversationServiceClient["submitConversation"]>
      >,
    ) => {
      submitConversationResult = result;
    },
  };
}

function createService(
  options: {
    startDisconnected?: boolean;
    workspaceVesloWorkspaceId?: string | null;
    listWorkspaceItems?: FakeWorkspaceRegistryItem[];
    addLocalWorkspaceItems?: FakeWorkspaceRegistryItem[];
    failWorkspaceRegistration?: boolean | "invalid-host-token";
    refreshClientOnEnsure?: boolean;
    refreshedListWorkspaceItems?: FakeWorkspaceRegistryItem[];
    refreshedAddLocalWorkspaceItems?: FakeWorkspaceRegistryItem[];
    engineBaseWorkspaceId?: string;
    engineBaseUrl?: string | null;
    runStatusError?: unknown;
    refreshedRunStatusError?: unknown;
    runStatusResult?: Partial<VesloConversationRunStatusResult>;
    recoverTranscriptError?: unknown;
    recoverSessionTranscript?: (
      workspaceId: string,
      sessionId: string,
      input: { expectedRunId?: string | null },
    ) => ReturnType<ConversationServiceClient["recoverSessionTranscript"]>;
    refreshedRecoverTranscriptError?: unknown;
    managedAiAccess?: {
      providerId?: string | null;
      defaultModel?: { modelID?: string | null } | null;
    } | null;
    runtimeAuthorizationResult?: boolean;
    managedAiConfigFreshnessOutcome?:
      | "verified"
      | "skipped-pending"
      | "cancelled"
      | "failed"
      | "verified-reload-required";
    runtimeAuthorizationDiagnostic?: ManagedAiRuntimeAuthPrimeDiagnostic | null;
    resolveWorkspaceRootForConversationScope?: (
      workspaceId: string,
      directory?: string | null,
    ) => string;
    failServerStart?: boolean;
  } = {},
) {
  const {
    client,
    calls,
    submitConversationCalls,
    sessionTranscriptCalls,
    setRunConversationResult,
    setSubmitConversationResult,
  } = createFakeClient({
    listWorkspaceItems: options.listWorkspaceItems,
    addLocalWorkspaceItems: options.addLocalWorkspaceItems,
    failWorkspaceRegistration: options.failWorkspaceRegistration,
    runStatusError: options.runStatusError,
    runStatusResult: options.runStatusResult,
    recoverTranscriptError: options.recoverTranscriptError,
    recoverSessionTranscript: options.recoverSessionTranscript,
  });
  const refreshedFake = options.refreshClientOnEnsure
    ? createFakeClient({
        listWorkspaceItems:
          options.refreshedListWorkspaceItems ?? options.listWorkspaceItems,
        addLocalWorkspaceItems:
          options.refreshedAddLocalWorkspaceItems ??
          options.addLocalWorkspaceItems,
        runStatusError: options.refreshedRunStatusError,
        runStatusResult: options.runStatusResult,
        recoverTranscriptError: options.refreshedRecoverTranscriptError,
      })
    : null;
  let serverClient: ConversationServiceClient | null = options.startDisconnected
    ? null
    : client;
  const engineBaseWorkspaceId = options.engineBaseWorkspaceId ?? "server-ws";
  let engineBaseUrl =
    options.engineBaseUrl === undefined
      ? `http://127.0.0.1:4096/workspace/${encodeURIComponent(engineBaseWorkspaceId)}/opencode`
      : (options.engineBaseUrl ?? "");
  const ensureCalls: string[] = [];
  const ensureOptions: Array<
    { requireRuntimeChainReady?: boolean } | undefined
  > = [];
  const rememberedScopes: RememberedScope[] = [];
  const sendTraces: Array<{
    event: string;
    payload?: Record<string, unknown>;
  }> = [];
  const rememberedRuns: Array<{
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
    runId?: string | null;
  }> = [];
  const rememberedLifecycleRuns: Array<{
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
    runId?: string | null;
  }> = [];
  const runtimeAuthorizationCalls: unknown[] = [];
  const runtimeConfirmedWorkspaceIds: string[] = [];
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
    for (const id of [
      input.conversationId,
      input.opencodeSessionId,
      input.uiSessionId,
    ]) {
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
    for (const id of [
      input.conversationId,
      input.opencodeSessionId,
      input.uiSessionId,
    ]) {
      const runId = id?.trim()
        ? map.get(`${input.workspaceId}\0${id.trim()}`)
        : "";
      if (runId) return runId;
    }
    return "";
  };

  const service = createConversationService({
    vesloServerClient: () => serverClient,
    vesloServerStatus: () => (serverClient ? "connected" : "disconnected"),
    isTauriRuntime: () => true,
    startupPreference: () => "local",
    ensureLocalVesloServerRunning: async (ensureOptionsInput) => {
      ensureCalls.push("ensure-local-server");
      ensureOptions.push(ensureOptionsInput);
      if (options.failServerStart) return false;
      serverClient = refreshedFake?.client ?? client;
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
    resolveWorkspaceRootForConversationScope:
      options.resolveWorkspaceRootForConversationScope ?? (() => "/repo"),
    rememberConversationScope: (scope) => rememberedScopes.push(scope),
    rememberConversationScopesFromSessions: () => undefined,
    rememberConversationScopeFromTranscript: (
      workspaceId,
      directory,
      snapshot,
    ) => {
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
    rememberLatestConversationLifecycleRunId: (input) => {
      rememberedLifecycleRuns.push(input);
      rememberRunId(lifecycleRunIds, input);
    },
    resolveLatestConversationLifecycleRunId: (input) =>
      resolveRunId(lifecycleRunIds, input),
    managedAiAccess: () => options.managedAiAccess ?? null,
    ensureManagedAiRuntimeAuthorizationForSend: async (targetWorkspace) => {
      runtimeAuthorizationCalls.push(targetWorkspace ?? null);
      calls.push(
        `ensureManagedAiRuntimeAuthorizationForSend:${targetWorkspace?.workspaceId ?? ""}:${targetWorkspace?.directory ?? ""}`,
      );
      return options.runtimeAuthorizationResult ?? true;
    },
    prepareManagedAiRuntimeConfigForServerSend: async () => {
      calls.push("prepareManagedAiRuntimeConfigForServerSend");
      const kind = options.managedAiConfigFreshnessOutcome ?? "verified";
      return kind === "failed"
        ? { kind, error: "config sync failed" }
        : { kind };
    },
    managedAiRuntimeAuthorizationPrimeDiagnostic: () =>
      options.runtimeAuthorizationDiagnostic ?? null,
    onConversationRuntimeConfirmed: (workspaceId) =>
      runtimeConfirmedWorkspaceIds.push(workspaceId),
    activeSendTraceId: () => null,
    recordSendTrace: (event, payload) => {
      sendTraces.push({ event, payload });
    },
    sendTraceStep: async (_event, run) => run(),
    recordExternalSendTraceEntries: () => undefined,
    engineInfo: async () => ({
      baseUrl: engineBaseUrl,
      projectDir: "/repo",
      opencodeUsername: "user",
      opencodePassword: "pass",
    }),
    wsDebug: () => undefined,
  });

  return {
    service,
    calls,
    refreshedCalls: refreshedFake?.calls ?? [],
    submitConversationCalls,
    sessionTranscriptCalls,
    ensureCalls,
    ensureOptions,
    rememberedScopes,
    rememberedRuns,
    rememberedLifecycleRuns,
    sendTraces,
    runtimeAuthorizationCalls,
    runtimeConfirmedWorkspaceIds,
    setRunConversationResult,
    setSubmitConversationResult,
    setEngineBaseUrl: (nextBaseUrl: string | null) => {
      engineBaseUrl = nextBaseUrl ?? "";
    },
  };
}

test("conversation read workspace registration is isolated per server client and directory", async () => {
  const { service, calls } = createService();
  const firstClient = service.vesloServerClient()!;
  const refreshedClient = { ...firstClient };

  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      firstClient,
      "app-ws",
      "/repo",
    ),
    "server-ws",
  );
  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      refreshedClient,
      "app-ws",
      "/repo",
    ),
    "server-ws",
  );

  assert.deepEqual(
    calls.filter((call) => call.startsWith("addLocalWorkspace")),
    ["addLocalWorkspace:/repo", "addLocalWorkspace:/repo"],
  );
});

test("live conversation registration refreshes when the runtime URL changes", async () => {
  const { service, calls, setEngineBaseUrl } = createService({
    engineBaseUrl: "http://127.0.0.1:4096/workspace/server-ws/opencode",
  });
  const client = service.vesloServerClient()!;
  const options = { requireLiveOpencodeBaseUrl: true };

  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
      options,
    ),
    "server-ws",
  );
  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
      options,
    ),
    "server-ws",
  );
  setEngineBaseUrl("http://127.0.0.1:4196/workspace/server-ws/opencode");
  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
      options,
    ),
    "server-ws",
  );

  assert.deepEqual(
    calls.filter((call) => call.startsWith("addLocalWorkspace")),
    ["addLocalWorkspace:/repo", "addLocalWorkspace:/repo"],
  );
});

test("conversation read workspace registration labels a fulfilled registration as a cache hit", async () => {
  const { service, sendTraces } = createService();
  const client = service.vesloServerClient()!;

  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
    ),
    "server-ws",
  );
  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
    ),
    "server-ws",
  );

  assert.deepEqual(
    sendTraces
      .filter(
        (entry) => entry.event === "conversation-workspace-registration:flight",
      )
      .map((entry) => entry.payload?.action),
    ["start", "settle", "cache-hit"],
  );
});

test("a settling older resolution cannot evict a newer entry for the same key", async () => {
  const { service } = createService({ engineBaseUrl: null });
  const preflight = {
    traceId: "trace-supersession",
    targetWorkspace: {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
    },
    conversationWorkspaceByDirectory: new Map(),
  };
  const request = {
    clientMessageId: "msg-supersession",
    origin: "session:normal",
    target: { conversationId: "conv-a", opencodeSessionId: "open-a" },
    draft: {
      mode: "prompt" as const,
      text: "hello",
      parts: [{ type: "text" as const, text: "hello" }],
    },
  };

  // Start a send whose outer resolution will settle unsuccessfully.
  const older = service.submitConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    request,
    preflight,
  );
  const olderSettled = older.then(
    () => undefined,
    () => undefined,
  );

  // Let the outer resolution register itself before superseding it.
  await Promise.resolve();
  await Promise.resolve();
  const cacheKey = [...preflight.conversationWorkspaceByDirectory.keys()][0];
  assert.ok(cacheKey, "the outer resolution should be memoized while in flight");

  // A newer send installs its own resolution for the same key. The older one is
  // still in flight and must not delete this entry when it finally settles —
  // that is the case the identity comparison exists for.
  const newer = Promise.resolve({
    serverClient: {} as never,
    serverWorkspaceId: "server-ws",
    workspaceId: "app-ws",
    directory: "/repo",
  });
  preflight.conversationWorkspaceByDirectory.set(cacheKey, newer);

  await olderSettled;

  assert.equal(
    preflight.conversationWorkspaceByDirectory.get(cacheKey),
    newer,
    "the newer entry must survive the older resolution settling",
  );
});

test("server submit removes a missing-live-binding resolution from the shared preflight cache", async () => {
  const { service, setEngineBaseUrl, submitConversationCalls } = createService({
    engineBaseUrl: null,
  });
  const preflight = {
    traceId: "trace-live-binding-cache",
    targetWorkspace: {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
    },
    conversationWorkspaceByDirectory: new Map(),
  };
  const request = {
    clientMessageId: "msg-live-binding-cache",
    origin: "session:normal",
    target: { conversationId: "conv-a", opencodeSessionId: "open-a" },
    draft: {
      mode: "prompt" as const,
      text: "hello",
      parts: [{ type: "text" as const, text: "hello" }],
    },
  };

  await assert.rejects(
    service.submitConversationFromVesloWriteApi(
      "app-ws",
      "/repo",
      request,
      preflight,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ConversationServerSubmitPreflightError" &&
      (error as Error & { code?: string; httpAttempted?: boolean }).code ===
        "local_live_binding_unavailable" &&
      (error as Error & { httpAttempted?: boolean }).httpAttempted === false,
  );
  assert.equal(preflight.conversationWorkspaceByDirectory.size, 0);

  setEngineBaseUrl("http://127.0.0.1:4096/workspace/server-ws/opencode");
  const result = await service.submitConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    request,
    preflight,
  );

  assert.equal(result?.status, "submitted");
  assert.equal(submitConversationCalls.length, 1);
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

  assert.equal(
    service.resolveConversationServerWorkspaceId("app-ws"),
    mappedWorkspaceId,
  );

  const result = await service.createConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    "Mapped",
  );

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

test("terminal transcript recovery returns the exact fetched snapshot for session-store hydration", async () => {
  const { service, calls } = createService();

  const snapshot = await service.recoverConversationTranscript({
    workspaceId: "app-ws",
    sessionId: "open-a",
    directory: "/repo",
    expectedRunId: "run-a",
  });

  assert.equal(snapshot?.sessionId, "open-a");
  assert.ok(calls.includes("recoverSessionTranscript:server-ws:open-a:run-a"));
  assert.ok(calls.includes("getSessionTranscript:server-ws:open-a"));
});

test("invalidated terminal recovery stops before its transcript read", async () => {
  let resolveRecover!: (result: {
    workspaceId: string;
    conversationId: string;
    opencodeSessionId: string;
    state: "persisted";
    generation: number;
    attempts: number;
    runId: string | null;
  }) => void;
  const recoverStarted = new Promise<{
    workspaceId: string;
    conversationId: string;
    opencodeSessionId: string;
    state: "persisted";
    generation: number;
    attempts: number;
    runId: string | null;
  }>((resolve) => {
    resolveRecover = resolve;
  });
  const { service, calls } = createService({
    recoverSessionTranscript: () => recoverStarted,
  });
  const cancellation = new AbortController();
  const recovery = service.recoverConversationTranscript(
    {
      workspaceId: "app-ws",
      sessionId: "open-a",
      directory: "/repo",
      expectedRunId: "run-a",
    },
    cancellation.signal,
  );

  cancellation.abort();
  resolveRecover({
    workspaceId: "server-ws",
    conversationId: "conv-open-a",
    opencodeSessionId: "open-a",
    state: "persisted",
    generation: 1,
    attempts: 1,
    runId: "run-a",
  });

  assert.equal(await recovery, null);
  assert.equal(
    calls.includes("getSessionTranscript:server-ws:open-a"),
    false,
    "a new send must prevent an obsolete terminal recovery from starting its transcript read",
  );
});

test("terminal transcript recovery uses the projection trace client contract", async () => {
  const { service, sessionTranscriptCalls, sendTraces } = createService();

  const snapshot = await service.recoverConversationTranscript({
    workspaceId: "app-ws",
    sessionId: "open-a",
    directory: "/repo",
    expectedRunId: "run-a",
    diagnosticTraceId: "trace-terminal-a",
  });

  assert.equal(snapshot?.sessionId, "open-a");
  assert.deepEqual(sessionTranscriptCalls, [
    {
      workspaceId: "server-ws",
      sessionId: "open-a",
      limit: 140,
      directory: "/repo",
      options: {
        includeLatestRunArtifacts: true,
        caller: "terminal-recovery",
        sendTraceId: "trace-terminal-a",
      },
    },
  ]);
  const events = sendTraces.filter((entry) =>
    entry.event.startsWith("session-transcript-projection:"),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    event: "session-transcript-projection:request",
    payload: {
      traceId: "trace-terminal-a",
      caller: "terminal-recovery",
      displayLimit: 140,
      sourceLimit: 200,
    },
  });
  assert.deepEqual(
    {
      traceId: events[1]?.payload?.traceId,
      caller: events[1]?.payload?.caller,
      displayLimit: events[1]?.payload?.displayLimit,
      sourceLimit: events[1]?.payload?.sourceLimit,
      outcome: events[1]?.payload?.outcome,
    },
    {
      traceId: "trace-terminal-a",
      caller: "terminal-recovery",
      displayLimit: 140,
      sourceLimit: 200,
      outcome: "loaded",
    },
  );
});

test("accepted terminal transcript recovery reconnects once and keeps the accepted run scope", async () => {
  const { service, calls, ensureCalls, ensureOptions } = createService({
    startDisconnected: true,
    runStatusResult: { status: "completed" },
  });

  const snapshot = await service.recoverAcceptedConversationTranscript({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    sessionId: "ses-ui",
    runId: "run-a",
    clientMessageId: "msg-a",
  });

  assert.equal(snapshot?.sessionId, "open-a");
  assert.deepEqual(ensureCalls, ["ensure-local-server"]);
  assert.deepEqual(ensureOptions, [{ requireRuntimeChainReady: false }]);
  assert.ok(calls.includes("getConversationRunStatus:server-ws:conv-a:run-a"));
  assert.ok(calls.includes("recoverSessionTranscript:server-ws:open-a:run-a"));
  assert.ok(calls.includes("getSessionTranscript:server-ws:open-a"));
});

test("accepted terminal transcript recovery uses a healthy client without an unnecessary ensure", async () => {
  const { service, calls, ensureCalls } = createService();

  const snapshot = await service.recoverAcceptedConversationTranscript({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    sessionId: "ses-ui",
    runId: "run-a",
    clientMessageId: "msg-a",
  });

  assert.equal(snapshot?.sessionId, "open-a");
  assert.deepEqual(ensureCalls, []);
  assert.equal(
    calls.some((call) => call.startsWith("getConversationRunStatus:")),
    false,
  );
  assert.ok(calls.includes("recoverSessionTranscript:server-ws:open-a:run-a"));
});

test("accepted terminal transcript recovery refreshes a stale client after a direct transport error", async () => {
  const {
    service,
    calls,
    refreshedCalls,
    ensureCalls,
    ensureOptions,
    sendTraces,
  } = createService({
    recoverTranscriptError: new Error("transport down"),
    refreshClientOnEnsure: true,
    runStatusResult: { status: "completed" },
  });

  const snapshot = await service.recoverAcceptedConversationTranscript({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    sessionId: "ses-ui",
    runId: "run-a",
    clientMessageId: "msg-a",
  });

  assert.equal(snapshot?.sessionId, "open-a");
  assert.ok(calls.includes("recoverSessionTranscript:server-ws:open-a:run-a"));
  assert.deepEqual(ensureCalls, ["ensure-local-server"]);
  assert.deepEqual(ensureOptions, [{ requireRuntimeChainReady: false }]);
  assert.ok(
    refreshedCalls.includes("getConversationRunStatus:server-ws:conv-a:run-a"),
  );
  assert.ok(
    refreshedCalls.includes("recoverSessionTranscript:server-ws:open-a:run-a"),
  );
  assert.ok(
    sendTraces.some(
      (entry) =>
        entry.event === "accepted-run-transcript-recovery:direct-read-error",
    ),
  );
});

test("accepted terminal transcript recovery lets the lifecycle owner retry a client timeout", async () => {
  const { service, calls, ensureCalls } = createService({
    recoverTranscriptError: new Error("Request timed out after 30000ms"),
    runStatusResult: { status: "completed" },
  });

  await assert.rejects(
    service.recoverAcceptedConversationTranscript({
      workspaceId: "app-ws",
      directory: "/repo",
      conversationId: "conv-a",
      opencodeSessionId: "open-a",
      sessionId: "ses-ui",
      runId: "run-a",
      clientMessageId: "msg-a",
    }),
    /Request timed out after 30000ms/,
  );
  assert.deepEqual(ensureCalls, []);
  assert.deepEqual(calls, [
    "listWorkspaces",
    "addLocalWorkspace:/repo",
    "recoverSessionTranscript:server-ws:open-a:run-a",
  ]);
});

test("conversation write refreshes stale server workspace registration with live OpenCode URL", async () => {
  const staleBaseUrl = "http://127.0.0.1:60956/workspace/server-ws/opencode";
  const { service, calls } = createService({
    listWorkspaceItems: [
      {
        id: "server-ws",
        path: "/repo",
        directory: "/repo",
        baseUrl: staleBaseUrl,
      },
    ],
  });

  const result = await service.createConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    "Refresh",
  );

  assert.equal(result?.id, "sess-created");
  assert.deepEqual(
    calls.filter(
      (call) =>
        call === "listWorkspaces" ||
        call.startsWith("addLocalWorkspace:") ||
        call.startsWith("createConversation:"),
    ),
    [
      "listWorkspaces",
      "addLocalWorkspace:/repo",
      "createConversation:server-ws",
    ],
  );
});

test("conversation read registration joins an in-flight live registration", async () => {
  const { service, calls, sendTraces } = createService();
  const client = service.vesloServerClient()!;
  let releaseList!: (value: {
    items: FakeWorkspaceRegistryItem[];
    activeId: string | null;
  }) => void;
  let signalListStarted!: () => void;
  const pendingList = new Promise<{
    items: FakeWorkspaceRegistryItem[];
    activeId: string | null;
  }>((resolve) => {
    releaseList = resolve;
  });
  const listStarted = new Promise<void>((resolve) => {
    signalListStarted = resolve;
  });
  let listCalls = 0;
  client.listWorkspaces = async () => {
    listCalls += 1;
    signalListStarted();
    return await pendingList;
  };

  const live = service.ensureConversationReadWorkspaceRegistered(
    client,
    "app-ws",
    "/repo",
    {
      requireLiveOpencodeBaseUrl: true,
    },
  );
  await listStarted;
  const read = service.ensureConversationReadWorkspaceRegistered(
    client,
    "app-ws",
    "/repo",
  );

  assert.equal(
    listCalls,
    1,
    "read must await the live control sequence instead of starting another one",
  );
  releaseList({ items: [], activeId: null });
  assert.equal(await live, "server-ws");
  assert.equal(await read, "server-ws");
  assert.equal(listCalls, 1);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("addLocalWorkspace")),
    ["addLocalWorkspace:/repo"],
  );
  assert.deepEqual(
    sendTraces
      .filter(
        (entry) => entry.event === "conversation-workspace-registration:flight",
      )
      .map((entry) => entry.payload?.action),
    ["start", "join", "settle"],
  );
});

test("empty live registration cannot satisfy a later read registration", async () => {
  const { service, calls } = createService({ engineBaseUrl: "" });
  const client = service.vesloServerClient()!;

  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
      {
        requireLiveOpencodeBaseUrl: true,
      },
    ),
    "",
  );
  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
    ),
    "server-ws",
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("addLocalWorkspace")),
    ["addLocalWorkspace:/repo"],
  );
});

test("live registration does not reuse a read-only registration", async () => {
  const { service, calls } = createService();
  const client = service.vesloServerClient()!;

  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
    ),
    "server-ws",
  );
  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      client,
      "app-ws",
      "/repo",
      {
        requireLiveOpencodeBaseUrl: true,
      },
    ),
    "server-ws",
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("addLocalWorkspace")),
    ["addLocalWorkspace:/repo", "addLocalWorkspace:/repo"],
  );
});

test("conversation write refreshes stale local host token once before declaring registration unavailable", async () => {
  const { service, calls, refreshedCalls, ensureCalls, sendTraces } =
    createService({
      failWorkspaceRegistration: "invalid-host-token",
      refreshClientOnEnsure: true,
    });

  const result = await service.createConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    "Refresh token",
  );

  assert.equal(result?.id, "sess-created");
  assert.deepEqual(ensureCalls, ["ensure-local-server"]);
  assert.deepEqual(
    calls.filter(
      (call) =>
        call === "listWorkspaces" || call.startsWith("addLocalWorkspace:"),
    ),
    ["listWorkspaces", "addLocalWorkspace:/repo"],
  );
  assert.deepEqual(
    refreshedCalls.filter(
      (call) =>
        call === "listWorkspaces" ||
        call.startsWith("addLocalWorkspace:") ||
        call.startsWith("createConversation:"),
    ),
    [
      "listWorkspaces",
      "addLocalWorkspace:/repo",
      "createConversation:server-ws",
    ],
  );
  assert.ok(
    sendTraces.some(
      (entry) =>
        entry.event ===
        "conversation-workspace-registration:host-token-refresh:start",
    ),
  );
  assert.ok(
    sendTraces.some(
      (entry) =>
        entry.event ===
          "conversation-workspace-registration:host-token-refresh:end" &&
        entry.payload?.hasRefreshedClient === true,
    ),
  );
});

test("conversation write blocks first submit when live OpenCode URL is unavailable", async () => {
  const { service, calls, sendTraces } = createService({
    engineBaseUrl: "",
    listWorkspaceItems: [
      {
        id: "server-ws",
        path: "/repo",
        directory: "/repo",
        baseUrl: "http://127.0.0.1:60956/workspace/server-ws/opencode",
      },
    ],
  });

  const result = await service.createConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    "Missing runtime",
  );

  assert.equal(result, null);
  assert.equal(
    calls.some((call) => call.startsWith("createConversation:")),
    false,
  );
  assert.ok(
    sendTraces.some(
      (entry) => entry.event === "conversation-read:live-opencode-unavailable",
    ),
  );
});

test("conversation create reports malformed preflight cache instead of throwing", async () => {
  const { service, sendTraces } = createService();

  const result = await service.createConversationFromVesloWriteApi(
    "app-ws",
    "/repo",
    "Legacy",
    {
      traceId: "trace-legacy",
      targetWorkspace: null,
    } as any,
  );

  assert.equal(result?.id, "sess-created");
  const validation = sendTraces.find(
    (entry) =>
      entry.event ===
      "createConversationFromVesloWriteApi:conversation-preflight-contract:validation-failed",
  );
  assert.ok(
    validation,
    "malformed preflight should be diagnosed at the service boundary",
  );
  assert.equal(
    validation.payload?.schema,
    "conversation-send-preflight-context",
  );
  assert.equal(validation.payload?.hasConversationWorkspaceByDirectory, false);
  assert.equal(
    validation.payload?.conversationWorkspaceByDirectoryType,
    "undefined",
  );
});

test("conversation run reports malformed preflight cache instead of hiding it", async () => {
  const { service, sendTraces } = createService();

  const result = await service.submitConversationRunViaVesloWriteApi(
    "sess-a",
    {
      kind: "prompt_async",
      directory: "/repo",
    },
    {
      preflight: {
        traceId: "trace-run",
        targetWorkspace: null,
      } as any,
    },
  );

  assert.equal(result?.status, "submitted");
  const start = sendTraces.find(
    (entry) => entry.event === "submitConversationRunViaVesloWriteApi:start",
  );
  assert.ok(start, "run start should include the preflight contract summary");
  assert.equal(start.payload?.hasConversationWorkspaceByDirectory, false);
  assert.equal(
    start.payload?.conversationWorkspaceByDirectoryType,
    "undefined",
  );

  const validation = sendTraces.find(
    (entry) =>
      entry.event ===
      "submitConversationRunViaVesloWriteApi:conversation-preflight-contract:validation-failed",
  );
  assert.ok(
    validation,
    "malformed run preflight should be diagnosed at the service boundary",
  );
  assert.equal(
    validation.payload?.schema,
    "conversation-send-preflight-context",
  );
  assert.equal(validation.payload?.hasConversationWorkspaceByDirectory, false);
  assert.equal(
    validation.payload?.conversationWorkspaceByDirectoryType,
    "undefined",
  );
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

  assert.equal(
    await service.ensureConversationReadWorkspaceRegistered(
      service.vesloServerClient()!,
      "app-ws",
      "/repo",
    ),
    "",
  );
  assert.deepEqual(calls, ["listWorkspaces", "addLocalWorkspace:/repo"]);
});

test("local workspace registration failure does not continue with fallback app workspace id", async () => {
  const cases: Array<{
    name: string;
    run: (
      service: ReturnType<typeof createService>["service"],
    ) => Promise<unknown>;
  }> = [
    {
      name: "list",
      run: async (service) => {
        const result = await service.listConversationsFromVesloReadApi(
          "app-ws",
          "/repo",
        );
        assert.equal(result.source, "unavailable");
        return result;
      },
    },
    {
      name: "backfill",
      run: (service) =>
        service.backfillConversationsToVesloReadApi("app-ws", "/repo", [
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
        const result = await service.getTranscriptFromVesloReadApi(
          "app-ws",
          "sess-a",
          10,
          "/repo",
        );
        assert.equal(result, null);
        return result;
      },
    },
    {
      name: "create",
      run: async (service) => {
        const result = await service.createConversationFromVesloWriteApi(
          "app-ws",
          "/repo",
          "Create",
        );
        assert.equal(result, null);
        return result;
      },
    },
    {
      name: "run",
      run: async (service) => {
        const result = await service.submitConversationRunViaVesloWriteApi(
          "sess-a",
          {
            kind: "prompt_async",
            directory: "/repo",
          },
        );
        assert.equal(result, null);
        return result;
      },
    },
    {
      name: "abort",
      run: async (service) => {
        const result =
          await service.abortConversationFromVesloWriteApi("sess-a");
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
  ];

  for (const entry of cases) {
    const { service, calls } = createService({
      failWorkspaceRegistration: true,
    });
    await entry.run(service);
    assert.equal(
      calls.some((call) =>
        /(?:listConversations|importConversations|getSessionTranscript|createConversation|runConversation|abortConversation|getConversationRunStatus):app-ws(?::|$)/.test(
          call,
        ),
      ),
      false,
      `${entry.name} should not call a server API with fallback app workspace id; calls=${calls.join(",")}`,
    );
  }
});

test("conversation transcript read preserves unavailable diagnostics at the app boundary", async () => {
  const { service, rememberedScopes, sendTraces } = createService();

  const snapshot = await service.getTranscriptFromVesloReadApi(
    "app-ws",
    "sess-unavailable",
    12,
    "/repo",
  );

  assert.equal(snapshot?.source, "unavailable");
  assert.equal(snapshot?.sessionId, "sess-unavailable");
  assert.equal(snapshot?.diagnostic?.reason, "database_missing");
  assert.deepEqual(snapshot?.messages, []);
  assert.deepEqual(
    sendTraces.find(
      (entry) => entry.event === "getTranscriptFromVesloReadApi:unavailable",
    ),
    {
      event: "getTranscriptFromVesloReadApi:unavailable",
      payload: {
        workspaceId: "app-ws",
        serverWorkspaceId: "server-ws",
        sessionId: "sess-unavailable",
        directory: "/repo",
        limit: 12,
        diagnostic: {
          reason: "database_missing",
          workspaceId: "server-ws",
          sessionId: "sess-unavailable",
          directory: "/repo",
          dbPath: "/missing/opencode.db",
          dbPathExists: false,
        },
      },
    },
  );
  assert.equal(
    rememberedScopes.length,
    1,
    "unavailable snapshots still carry identity sidecars that must be remembered",
  );
});

test("passive browse reads do not start the local conversation server", async () => {
  const { service, ensureCalls } = createService({ startDisconnected: true });

  const result = await service.listConversationsFromVesloReadApi(
    "app-ws",
    "/repo",
  );

  assert.equal(result.source, "unavailable");
  assert.deepEqual(result.items, []);
  assert.deepEqual(ensureCalls, []);
});

test("projection transcript reads emit content-free request and settle trace events", async () => {
  const { service, sendTraces } = createService();

  const snapshot = await service.getTranscriptFromVesloReadApi(
    "app-ws",
    "sess-a",
    140,
    "/repo",
    {
      includeLatestRunArtifacts: true,
      caller: "passive-selection",
      sendTraceId: "trace-projection-a",
    },
  );

  assert.equal(snapshot?.sessionId, "sess-a");
  const events = sendTraces.filter((entry) =>
    entry.event.startsWith("session-transcript-projection:"),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    event: "session-transcript-projection:request",
    payload: {
      traceId: "trace-projection-a",
      caller: "passive-selection",
      displayLimit: 140,
      sourceLimit: 200,
    },
  });
  assert.equal(events[1]?.event, "session-transcript-projection:settle");
  assert.deepEqual(
    {
      traceId: events[1]?.payload?.traceId,
      caller: events[1]?.payload?.caller,
      displayLimit: events[1]?.payload?.displayLimit,
      sourceLimit: events[1]?.payload?.sourceLimit,
      outcome: events[1]?.payload?.outcome,
      source: events[1]?.payload?.source,
      messageCount: events[1]?.payload?.messageCount,
    },
    {
      traceId: "trace-projection-a",
      caller: "passive-selection",
      displayLimit: 140,
      sourceLimit: 200,
      outcome: "loaded",
      source: "sqlite",
      messageCount: 0,
    },
  );
  assert.equal(typeof events[1]?.payload?.durationMs, "number");
  assert.equal("workspaceId" in (events[1]?.payload ?? {}), false);
  assert.equal("directory" in (events[1]?.payload ?? {}), false);
  assert.equal("sessionId" in (events[1]?.payload ?? {}), false);
});

test("stale projection reads stop after registration before issuing a transcript request", async () => {
  const { service, calls, sendTraces } = createService();
  let continuationChecks = 0;

  const snapshot = await service.getTranscriptFromVesloReadApi(
    "app-ws",
    "sess-stale",
    140,
    "/repo",
    {
      includeLatestRunArtifacts: true,
      caller: "passive-selection",
      shouldContinue: () => ++continuationChecks < 3,
    },
  );

  assert.equal(snapshot, null);
  assert.equal(calls.some((call) => call.startsWith("getSessionTranscript:")), false);
  const events = sendTraces.filter((entry) =>
    entry.event.startsWith("session-transcript-projection:"),
  );
  assert.deepEqual(events.map((entry) => entry.event), [
    "session-transcript-projection:request",
    "session-transcript-projection:settle",
  ]);
  assert.deepEqual(
    {
      outcome: events[1]?.payload?.outcome,
      phase: events[1]?.payload?.phase,
    },
    { outcome: "stale", phase: "after-registration" },
  );
});

test("live transcript reads do not start the local conversation server without active recovery opt-in", async () => {
  const { service, ensureCalls, sendTraces } = createService({
    startDisconnected: true,
  });

  const result = await service.getTranscriptFromVesloReadApi(
    "app-ws",
    "sess-a",
    50,
    "/repo",
  );

  assert.equal(result, null);
  assert.deepEqual(ensureCalls, []);
  const declined = sendTraces.find(
    (entry) => entry.event === "conversation-read:server-start-declined",
  );
  assert.ok(
    declined,
    "default live-read should stay passive and trace the decline",
  );
  assert.equal(declined.payload?.intent, "live-read");
  assert.equal(declined.payload?.reason, "getTranscriptFromVesloReadApi");
});

test("exact accepted-run status recovery uses the server-only connection owner", async () => {
  const { service, calls, ensureCalls, ensureOptions, sendTraces } =
    createService({ startDisconnected: true });

  const result = await service.recoverAcceptedConversationRunStatus({
    workspaceId: "app-ws",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    sessionId: "sess-a",
    directory: "/repo",
    runId: "run-a",
  });

  assert.equal(result?.runId, "run-a");
  assert.deepEqual(ensureCalls, ["ensure-local-server"]);
  assert.deepEqual(ensureOptions, [{ requireRuntimeChainReady: false }]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("getConversationRunStatus")),
    ["getConversationRunStatus:server-ws:conv-a:run-a"],
  );
  const attempt = sendTraces.find(
    (entry) =>
      entry.event === "accepted-run-status-recovery:server-only-ensure-started",
  );
  assert.ok(attempt, "accepted-run server-only recovery should be traceable");
  assert.equal(attempt.payload?.workspaceId, "app-ws");
  assert.equal(attempt.payload?.conversationId, "conv-a");
  assert.equal(attempt.payload?.runId, "run-a");
});

test("accepted-run recovery revalidates an existing stale client before its exact reread", async () => {
  const { service, ensureCalls, ensureOptions, sendTraces } = createService({
    runStatusError: new Error("transport down"),
    refreshClientOnEnsure: true,
  });

  const result = await service.recoverAcceptedConversationRunStatus({
    workspaceId: "app-ws",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    sessionId: "sess-a",
    directory: "/repo",
    runId: "run-a",
  });

  assert.equal(result?.runId, "run-a");
  assert.deepEqual(ensureCalls, ["ensure-local-server"]);
  assert.deepEqual(ensureOptions, [{ requireRuntimeChainReady: false }]);
  const attempt = sendTraces.find(
    (entry) =>
      entry.event === "accepted-run-status-recovery:server-only-ensure-started",
  );
  assert.equal(attempt?.payload?.hadClientBeforeEnsure, true);
});

test("repeated selected transcript reads remain passive", async () => {
  const { service, ensureCalls, sendTraces } = createService({
    startDisconnected: true,
  });

  const first = await service.getTranscriptFromVesloReadApi(
    "app-ws",
    "sess-a",
    50,
    "/repo",
  );
  const second = await service.getTranscriptFromVesloReadApi(
    "app-ws",
    "sess-a",
    50,
    "/repo",
  );

  assert.equal(first, null);
  assert.equal(second, null);
  assert.deepEqual(ensureCalls, []);
  assert.equal(
    sendTraces.filter(
      (entry) => entry.event === "conversation-read:server-start-declined",
    ).length,
    2,
  );
});

test("status polls do not start the local conversation server", async () => {
  const { service, ensureCalls, sendTraces } = createService({
    startDisconnected: true,
  });

  const result = await service.readConversationRunStatus({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    runId: "run-a",
  });

  assert.equal(result, null);
  assert.deepEqual(ensureCalls, []);
  const unavailable = sendTraces.find(
    (entry) => entry.event === "readConversationRunStatus:unavailable",
  );
  assert.ok(unavailable, "status-poll unavailability should be traceable");
  assert.equal(unavailable.payload?.reason, "no-server-client");
  assert.equal(unavailable.payload?.workspaceId, "app-ws");
  assert.equal(unavailable.payload?.conversationId, "conv-a");
  assert.equal(unavailable.payload?.runId, "run-a");
});

test("status polls trace unavailable workspace registration without fallback server id", async () => {
  const { service, calls, sendTraces } = createService({
    failWorkspaceRegistration: true,
  });

  const result = await service.readConversationRunStatus({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    runId: "run-a",
  });

  assert.equal(result, null);
  assert.equal(
    calls.some((call) => call.startsWith("getConversationRunStatus:app-ws:")),
    false,
  );
  const unavailable = sendTraces.find(
    (entry) =>
      entry.event === "readConversationRunStatus:unavailable" &&
      entry.payload?.reason === "workspace-registration-unavailable",
  );
  assert.ok(
    unavailable,
    "workspace registration failure should be traceable for status polls",
  );
  assert.equal(unavailable.payload?.workspaceId, "app-ws");
  assert.equal(unavailable.payload?.directory, "/repo");
  assert.equal(unavailable.payload?.conversationId, "conv-a");
  assert.equal(unavailable.payload?.runId, "run-a");
});

test("status polls trace 404 run misses before returning null", async () => {
  const { service, sendTraces } = createService({
    runStatusError: new VesloServerError(
      404,
      "run_not_found",
      "Run was not found for this conversation",
    ),
  });

  const result = await service.readConversationRunStatus({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    runId: "run-missing",
  });

  assert.equal(result, null);
  const notFound = sendTraces.find(
    (entry) => entry.event === "readConversationRunStatus:not-found",
  );
  assert.ok(notFound, "404 run status misses should be traceable");
  assert.equal(notFound.payload?.workspaceId, "app-ws");
  assert.equal(notFound.payload?.serverWorkspaceId, "server-ws");
  assert.equal(notFound.payload?.conversationId, "conv-a");
  assert.equal(notFound.payload?.runId, "run-missing");
  assert.equal(notFound.payload?.status, 404);
  assert.equal(notFound.payload?.code, "run_not_found");
});

test("status polls preserve durable error and client correlation fields", async () => {
  const { service } = createService({
    runStatusResult: {
      status: "failed",
      clientMessageId: "msg-failed",
      error: "sanitized durable failure",
    },
  });

  const result = await service.readConversationRunStatus({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    runId: "run-failed",
  });

  assert.deepEqual(result, {
    ok: true,
    workspaceId: "server-ws",
    conversationId: "conv-a",
    runId: "run-failed",
    status: "failed",
    stale: false,
    clientMessageId: "msg-failed",
    error: "sanitized durable failure",
  });
});

test("latest status reads remember the resolved durable lifecycle run", async () => {
  const { service, rememberedLifecycleRuns } = createService({
    runStatusResult: {
      runId: "run-recovered",
      status: "failed",
      error: "restored failure",
    },
  });

  const result = await service.readConversationRunStatus({
    workspaceId: "app-ws",
    directory: "/repo",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    sessionId: "sess-a",
    runId: "latest",
  });

  assert.equal(result?.runId, "run-recovered");
  assert.deepEqual(rememberedLifecycleRuns, [
    {
      workspaceId: "app-ws",
      conversationId: "conv-a",
      opencodeSessionId: "open-a",
      uiSessionId: "sess-a",
      runId: "run-recovered",
    },
  ]);
});

test("latest lifecycle resolution fails closed when the selected session lacks an exact workspace scope", () => {
  const { service, sendTraces } = createService();

  const scope = service.resolveConversationRunForSession(
    "sess-without-scope",
    null,
    { allowLatest: true },
  );

  assert.equal(scope, null);
  assert.deepEqual(sendTraces, [
    {
      event: "resolveConversationRunForSession:latest-missing-scope",
      payload: {
        sessionId: "sess-without-scope",
        workspaceIdHint: null,
      },
    },
  ]);
});

test("conversation run remembers submitted run ids under Veslo and UI identities", async () => {
  const {
    service,
    rememberedRuns,
    rememberedScopes,
    runtimeConfirmedWorkspaceIds,
  } = createService();

  const result = await service.submitConversationRunViaVesloWriteApi("sess-a", {
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
  assert.deepEqual(
    rememberedScopes.map((scope) => scope.sessionId),
    ["open-a", "sess-a"],
  );
  assert.equal(rememberedScopes[0]?.conversationId, "conv-a");
  assert.equal(rememberedScopes[1]?.conversationId, "conv-a");
  assert.deepEqual(runtimeConfirmedWorkspaceIds, ["app-ws"]);
});

test("conversation submit keeps queued run scope without replacing active run ownership", async () => {
  const {
    service,
    rememberedRuns,
    rememberedScopes,
    setSubmitConversationResult,
    sendTraces,
    runtimeConfirmedWorkspaceIds,
  } = createService();
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
  assert.deepEqual(
    rememberedScopes.map((scope) => scope.sessionId),
    [
      "pending-submit",
      "ui-session",
      "open-submit",
      "conv-request",
      "conv-submit",
    ],
  );
  assert.ok(rememberedScopes.every((scope) => scope.workspaceId === "app-ws"));
  assert.ok(
    rememberedScopes.every((scope) => scope.conversationId === "conv-submit"),
  );
  assert.ok(
    rememberedScopes.every(
      (scope) => scope.opencodeSessionId === "open-submit",
    ),
  );
  assert.deepEqual(rememberedRuns, []);
  assert.deepEqual(runtimeConfirmedWorkspaceIds, []);
  assert.ok(
    sendTraces.some(
      (entry) =>
        entry.event ===
          "submitConversationFromVesloWriteApi:conversation-scope-remembered" &&
        entry.payload?.aliasCount === 5,
    ),
  );
});

test("managed conversation runs prime runtime authorization before submit", async () => {
  const { service, calls, runtimeAuthorizationCalls } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
  });

  const result = await service.submitConversationRunViaVesloWriteApi(
    "sess-a",
    {
      kind: "prompt_async",
      directory: "/repo",
    },
    {
      targetWorkspace: {
        workspaceId: "app-ws",
        workspaceRoot: "/repo",
        directory: "/repo",
      },
    },
  );

  assert.equal(result?.status, "submitted");
  assert.deepEqual(runtimeAuthorizationCalls, [
    {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
    },
  ]);
  const authPrimeIndex = calls.findIndex((call) =>
    call.startsWith("ensureManagedAiRuntimeAuthorizationForSend:"),
  );
  const freshnessIndex = calls.findIndex(
    (call) => call === "prepareManagedAiRuntimeConfigForServerSend",
  );
  const runIndex = calls.findIndex((call) =>
    call.startsWith("runConversation:"),
  );
  assert.ok(freshnessIndex >= 0, "managed config freshness should be checked");
  assert.ok(authPrimeIndex >= 0, "runtime authorization should be primed");
  assert.ok(runIndex >= 0, "conversation should be submitted");
  assert.ok(
    freshnessIndex < authPrimeIndex,
    "managed config must be fresh before runtime authorization",
  );
  assert.ok(
    authPrimeIndex < runIndex,
    "runtime authorization must be primed before submit",
  );
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
  assert.deepEqual(runtimeAuthorizationCalls, [
    {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
    },
  ]);
  const authPrimeIndex = calls.findIndex((call) =>
    call.startsWith("ensureManagedAiRuntimeAuthorizationForSend:"),
  );
  const freshnessIndex = calls.findIndex(
    (call) => call === "prepareManagedAiRuntimeConfigForServerSend",
  );
  const submitIndex = calls.findIndex((call) =>
    call.startsWith("submitConversation:"),
  );
  assert.ok(freshnessIndex >= 0, "managed config freshness should be checked");
  assert.ok(authPrimeIndex >= 0, "runtime authorization should be primed");
  assert.ok(submitIndex >= 0, "conversation should be submitted");
  assert.ok(
    freshnessIndex < authPrimeIndex,
    "managed config must be fresh before runtime authorization",
  );
  assert.ok(
    authPrimeIndex < submitIndex,
    "runtime authorization must be primed before submit",
  );
  assert.ok(calls.includes("submitConversation:server-ws:true"));
});

test("managed server submit blocks before auth prime when guarded config reload is required", async () => {
  const { service, calls } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
    managedAiConfigFreshnessOutcome: "verified-reload-required",
  });

  await assert.rejects(
    service.submitConversationFromVesloWriteApi("app-ws", "/repo", {
      clientMessageId: "msg-reload-blocked",
      origin: "session:normal",
      target: { conversationId: "conv-a", opencodeSessionId: "open-a" },
      draft: {
        mode: "prompt",
        text: "hello",
        parts: [{ type: "text", text: "hello" }],
      },
    }),
    /another run is active/,
  );

  assert.ok(calls.includes("prepareManagedAiRuntimeConfigForServerSend"));
  assert.ok(
    !calls.some((call) =>
      call.startsWith("ensureManagedAiRuntimeAuthorizationForSend:"),
    ),
  );
  assert.ok(!calls.some((call) => call.startsWith("submitConversation:")));
});

test("managed server submit preserves the draft path while the live model roster is pending", async () => {
  const { service, calls } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
    managedAiConfigFreshnessOutcome: "skipped-pending",
  });

  await assert.rejects(
    service.submitConversationFromVesloWriteApi("app-ws", "/repo", {
      clientMessageId: "msg-roster-pending",
      origin: "session:normal",
      target: { conversationId: "conv-a", opencodeSessionId: "open-a" },
      draft: {
        mode: "prompt",
        text: "keep my draft",
        parts: [{ type: "text", text: "keep my draft" }],
      },
    }),
    /configuration freshness is not ready/,
  );

  assert.ok(calls.includes("prepareManagedAiRuntimeConfigForServerSend"));
  assert.ok(
    !calls.some((call) =>
      call.startsWith("ensureManagedAiRuntimeAuthorizationForSend:"),
    ),
  );
  assert.ok(!calls.some((call) => call.startsWith("submitConversation:")));
});

test("conversation submit boundary injects directory and preserves composer send intent", async () => {
  const { service, submitConversationCalls, runtimeAuthorizationCalls } =
    createService();

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
  assert.deepEqual(submitConversationCalls[0]?.options, {
    sendTraceId: "trace-submit-boundary",
  });
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
    supportMessage:
      "Managed AI runtime authorization could not be refreshed. Check the local Veslo server connection and retry.",
    message: "HTTP 504",
  };
  const {
    service,
    calls,
    runtimeAuthorizationCalls,
    submitConversationCalls,
    sendTraces,
  } = createService({
    managedAiAccess: {
      providerId: "codex_oauth",
      defaultModel: { modelID: "gpt-5.5" },
    },
    runtimeAuthorizationResult: false,
    runtimeAuthorizationDiagnostic: authPrimeDiagnostic,
  });

  await assert.rejects(
    () =>
      service.submitConversationFromVesloWriteApi(
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

  assert.deepEqual(runtimeAuthorizationCalls, [
    {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
    },
  ]);
  assert.equal(submitConversationCalls.length, 0);
  assert.equal(
    calls.some((call) => call.startsWith("submitConversation:")),
    false,
  );
  const authPrimeResult = sendTraces.find(
    (entry) =>
      entry.event ===
      "submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime:result",
  );
  assert.equal(authPrimeResult?.payload?.ready, false);
  assert.equal(
    authPrimeResult?.payload?.authPrimeDiagnosticReason,
    "request-failed",
  );
  assert.deepEqual(
    authPrimeResult?.payload?.authPrimeDiagnostic,
    authPrimeDiagnostic,
  );
});

test("managed shell conversation submit does not prime AI gateway authorization", async () => {
  const { service, submitConversationCalls, runtimeAuthorizationCalls } =
    createService({
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
  assert.equal(
    submitConversationCalls[0]?.input.options?.expectAiGatewayStart,
    undefined,
  );
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
    () =>
      service.submitConversationRunViaVesloWriteApi("sess-a", {
        kind: "prompt_async",
        directory: "/repo",
      }),
    /Managed AI gateway authorization is not ready/,
  );

  assert.equal(
    calls.some((call) => call.startsWith("runConversation:")),
    false,
  );
});

test("conversation run requires a scoped workspace instead of falling back to the active workspace", async () => {
  const { service, calls, sendTraces } = createService();

  await assert.rejects(
    () =>
      service.submitConversationRunViaVesloWriteApi("unknown-session", {
        kind: "prompt_async",
        directory: "/repo",
      }),
    /scoped workspace/,
  );

  assert.equal(
    calls.some((call) => call.startsWith("runConversation:")),
    false,
  );
  const blocked = sendTraces.find(
    (entry) =>
      entry.event ===
      "submitConversationRunViaVesloWriteApi:blocked-missing-workspace-scope",
  );
  assert.ok(
    blocked,
    "missing scoped workspace should be visible in send traces",
  );
  assert.equal(blocked.payload?.sessionId, "unknown-session");
  assert.equal(blocked.payload?.scopeWorkspaceId, null);
  assert.equal(blocked.payload?.targetWorkspaceId, null);
  assert.equal(blocked.payload?.hasPreflight, false);
});

test("conversation run diagnoses foreign target workspace before submit", async () => {
  const { service, calls, sendTraces } = createService();

  await assert.rejects(
    () =>
      service.submitConversationRunViaVesloWriteApi(
        "sess-a",
        {
          kind: "prompt_async",
          directory: "/repo",
        },
        {
          targetWorkspace: {
            workspaceId: "other-ws",
            workspaceRoot: "/other",
            directory: "/other",
          },
        },
      ),
    /workspace does not match/,
  );

  assert.equal(
    calls.some((call) => call.startsWith("runConversation:")),
    false,
  );
  const blocked = sendTraces.find(
    (entry) =>
      entry.event ===
      "submitConversationRunViaVesloWriteApi:blocked-workspace-scope-mismatch",
  );
  assert.ok(blocked, "workspace mismatch should be visible in send traces");
  assert.equal(blocked.payload?.sessionId, "sess-a");
  assert.equal(blocked.payload?.scopeWorkspaceId, "app-ws");
  assert.equal(blocked.payload?.targetWorkspaceId, "other-ws");
  assert.equal(blocked.payload?.scopeDirectory, "/repo");
  assert.equal(blocked.payload?.targetDirectory, "/other");
});

test("conversation run diagnoses missing directory before submit", async () => {
  const { service, calls, sendTraces } = createService({
    resolveWorkspaceRootForConversationScope: () => "",
  });

  await assert.rejects(
    () =>
      service.submitConversationRunViaVesloWriteApi(
        "unknown-session",
        {
          kind: "prompt_async",
        },
        {
          targetWorkspace: {
            workspaceId: "app-ws",
            workspaceRoot: "",
            directory: "",
          },
        },
      ),
    /directory is required/,
  );

  assert.equal(
    calls.some((call) => call.startsWith("runConversation:")),
    false,
  );
  const blocked = sendTraces.find(
    (entry) =>
      entry.event ===
      "submitConversationRunViaVesloWriteApi:blocked-missing-directory",
  );
  assert.ok(
    blocked,
    "missing conversation directory should be visible in send traces",
  );
  assert.equal(blocked.payload?.sessionId, "unknown-session");
  assert.equal(blocked.payload?.workspaceId, "app-ws");
  assert.equal(blocked.payload?.scopeWorkspaceId, null);
  assert.equal(blocked.payload?.targetWorkspaceId, "app-ws");
  assert.equal(blocked.payload?.workspaceRoot, null);
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

  const result = await service.submitConversationRunViaVesloWriteApi("sess-a", {
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

  const result = await service.abortConversationFromVesloWriteApi(
    "missing-run",
    {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
      conversationId: "conv-missing",
      opencodeSessionId: "open-missing",
    },
  );

  assert.equal(result?.runId, "active");
  assert.equal(
    calls.some(
      (call) => call === "abortConversation:server-ws:conv-missing:active",
    ),
    true,
  );
});

test("conversation abort write-control paths may start the local conversation server", async () => {
  const { service, calls, ensureCalls } = createService({
    startDisconnected: true,
  });

  const result = await service.abortConversationFromVesloWriteApi(
    "missing-run",
    {
      workspaceId: "app-ws",
      workspaceRoot: "/repo",
      directory: "/repo",
      conversationId: "conv-missing",
      opencodeSessionId: "open-missing",
    },
  );

  assert.equal(result?.runId, "active");
  assert.deepEqual(ensureCalls, ["ensure-local-server"]);
  assert.equal(
    calls.some(
      (call) => call === "abortConversation:server-ws:conv-missing:active",
    ),
    true,
  );
});
