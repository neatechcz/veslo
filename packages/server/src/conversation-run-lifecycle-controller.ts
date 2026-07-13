import {
  ConversationRunQueueConflictError,
  type ConversationRunQueueStore,
} from "./conversation-run-queue-store.js";
import { ApiError } from "./errors.js";
import {
  OrchestratorLifecycleRequestError,
  RunAlreadyActiveError,
  type LifecycleRunStatus,
  type LifecycleRunStatusResult,
  type OrchestratorLifecycleClient,
} from "./orchestrator-lifecycle-client.js";
import type { WorkspaceInfo } from "./types.js";

export type ConversationRunLifecycleKind = "prompt_async" | "command" | "shell" | "summarize";

export type ConversationRunLifecycleTracer = {
  entries: Array<Record<string, unknown>>;
  traceId: string | null;
  record(event: string, payload?: Record<string, unknown>): void;
  step<T>(event: string, fn: () => Promise<T>, payload?: Record<string, unknown>): Promise<T>;
};

export type ConversationRunLifecycleTarget = {
  directory: string;
  binding?: unknown | null;
  opencodeSessionId: string;
  conversationId: string;
};

export type ConversationRunLifecycleTimerPort = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  unref?(handle: unknown): void;
};

export type ConversationRunLifecycleTracePort = {
  record(event: string, payload?: Record<string, unknown>): void;
};

export type ConversationRunLifecycleSubmitOpenCodeInput = {
  runTrace: ConversationRunLifecycleTracer;
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
  kind: ConversationRunLifecycleKind;
  body: Record<string, unknown>;
  clientMessageId: string | null;
  origin: string | null;
};

export type ConversationRunLifecycleSubmitOpenCodePort = (
  input: ConversationRunLifecycleSubmitOpenCodeInput,
) => Promise<unknown>;

export type ConversationRunLifecycleAiGatewayActiveRunInput = {
  traceId: string | null;
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  clientMessageId: string | null;
  origin: string | null;
  runtimeAuthorizationActorTokenHash: string | null;
};

export type ConversationRunLifecycleAiGatewayActiveRunPort = {
  register(input: ConversationRunLifecycleAiGatewayActiveRunInput): void;
  unregister(input: Omit<
    ConversationRunLifecycleAiGatewayActiveRunInput,
    "traceId" | "clientMessageId" | "origin" | "runtimeAuthorizationActorTokenHash"
  >): void;
};

export type ConversationRunLifecycleProviderStartWatchInput = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  clientMessageId: string | null;
  origin: string | null;
  startedAt: number;
};

export type ConversationRunLifecycleProviderStartWatchResult = {
  started: boolean;
  timeoutMs: number;
};

export type ConversationRunLifecycleAiGatewayProviderWatchPort = {
  waitForProviderStart(
    input: ConversationRunLifecycleProviderStartWatchInput,
  ): Promise<ConversationRunLifecycleProviderStartWatchResult>;
};

export type ConversationRunLifecycleAbortOpenCodeInput = {
  runTrace: ConversationRunLifecycleTracer;
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
};

export type ConversationRunLifecycleAbortOpenCodePort = (
  input: ConversationRunLifecycleAbortOpenCodeInput,
) => Promise<unknown>;

export type ConversationRunLifecycleAbortActiveGatewayProxyRequestsInput = {
  workspaceId: string;
  runId: string;
  sessionId: string;
  reason: string;
};

export type ConversationRunLifecycleAbortActiveGatewayProxyRequestsPort = (
  input: ConversationRunLifecycleAbortActiveGatewayProxyRequestsInput,
) => unknown[];

export type ConversationRunLifecycleScheduleReconcileInput = {
  workspace: WorkspaceInfo;
  conversationId: string;
  runId: string;
  directory?: string | null;
  opencodeSessionId?: string | null;
  reason: string;
  abortRequested?: boolean;
  delayMs?: number;
  attempt?: number;
};

export type ConversationRunLifecycleSubmitQueuePolicy = "normal" | "send-now" | "server-queue-only";

export type ConversationRunLifecycleSubmitInput = {
  runTrace: ConversationRunLifecycleTracer;
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
  kind: ConversationRunLifecycleKind;
  body: Record<string, unknown>;
  clientMessageId: string | null;
  origin: string | null;
  submitQueuePolicy?: ConversationRunLifecycleSubmitQueuePolicy;
  expectAiGatewayStart: boolean;
  runtimeAuthorizationActorTokenHash?: string | null;
};

export type ConversationRunLifecycleSubmitResult = {
  httpStatus: number;
  payload: Record<string, unknown>;
};

export type ConversationRunLifecycleAbortInput = {
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
};

export type ConversationRunLifecycleAbortResult = {
  upstream: unknown;
  abortedGatewayRequestCount: number;
};

export type ConversationRunLifecycleControllerOptions = {
  lifecycleClient?: OrchestratorLifecycleClient | null;
  queueStore?: ConversationRunQueueStore | null;
  resolveWorkspace?: (workspaceId: string) => WorkspaceInfo | null;
  createBackgroundRunTrace?: () => ConversationRunLifecycleTracer;
  submitOpenCode?: ConversationRunLifecycleSubmitOpenCodePort | null;
  abortOpenCode?: ConversationRunLifecycleAbortOpenCodePort | null;
  abortActiveGatewayProxyRequests?: ConversationRunLifecycleAbortActiveGatewayProxyRequestsPort | null;
  aiGatewayActiveRun?: ConversationRunLifecycleAiGatewayActiveRunPort | null;
  aiGatewayProviderWatch?: ConversationRunLifecycleAiGatewayProviderWatchPort | null;
  queueDrainPollMs?: number;
  resolveLifecycleReconcileInitialDelayMs?: () => number;
  resolveLifecycleReconcilePollMs?: () => number;
  resolveLifecycleReconcileMaxAttempts?: () => number;
  ingestTerminalTranscript?: (input: {
    workspace: WorkspaceInfo;
    directory: string;
    opencodeSessionId: string;
    runId: string;
  }) => Promise<void>;
  timers?: Partial<ConversationRunLifecycleTimerPort>;
  trace?: ConversationRunLifecycleTracePort | null;
  diagnostics?: {
    intervalMs?: number | null;
  };
};

export type ConversationRunLifecycleSnapshot = {
  started: boolean;
  activeTimerCount: number;
  diagnostics: {
    enabled: boolean;
    intervalMs: number | null;
    runs: number;
  };
  lifecycle: {
    pendingQueueDrains: Array<{ workspaceId: string; conversationId: string }>;
    pendingLifecycleReconciles: Array<{ workspaceId: string; conversationId: string; runId: string }>;
    inFlightQueueDrains: Array<{ workspaceId: string; conversationId: string }>;
    inFlightLifecycleReconciles: Array<{ workspaceId: string; conversationId: string; runId: string }>;
  };
  ports: {
    lifecycleClient: boolean;
    queueStore: boolean;
    submitOpenCode: boolean;
    aiGatewayProviderWatch: boolean;
  };
};

export type ConversationRunLifecycleController = {
  submitRun(input: ConversationRunLifecycleSubmitInput): Promise<ConversationRunLifecycleSubmitResult>;
  submitAcceptedRun(
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient | null,
  ): Promise<unknown>;
  scheduleQueueDrain(workspaceId: string, conversationId: string, delayMs?: number): void;
  drainConversationQueue(workspaceId: string, conversationId: string): Promise<void>;
  scheduleLifecycleReconcile(input: ConversationRunLifecycleScheduleReconcileInput): void;
  reconcileConversationRunLifecycle(input: ConversationRunLifecycleScheduleReconcileInput): Promise<void>;
  abortRun(input: ConversationRunLifecycleAbortInput): Promise<ConversationRunLifecycleAbortResult>;
  start(): void;
  stop(): void;
  snapshotForTests(): ConversationRunLifecycleSnapshot;
};

const ACTIVE_LIFECYCLE_STATUSES = new Set<LifecycleRunStatus>(["submitted", "running", "blocked"]);

function lifecycleRunKind(kind: ConversationRunLifecycleKind) {
  return kind === "prompt_async" ? "prompt" : kind;
}

function isActiveLifecycleStatus(status: LifecycleRunStatus | string | null | undefined): boolean {
  return Boolean(status && ACTIVE_LIFECYCLE_STATUSES.has(status as LifecycleRunStatus));
}

function lifecycleRequestApiError(error: OrchestratorLifecycleRequestError): ApiError {
  const status = error.status === 401 || error.status === 403
    ? 503
    : error.status === 404
      ? 404
      : error.status === 501
        ? 501
        : 503;
  const code = status === 404
    ? "lifecycle_not_found"
    : status === 501
      ? "lifecycle_unsupported"
      : "lifecycle_unavailable";
  return new ApiError(status, code, "Run lifecycle owner is unavailable", {
    upstreamStatus: error.status,
    path: error.path,
    body: error.body,
  });
}

function parseQueuedRunKind(kind: string): ConversationRunLifecycleKind {
  if (kind === "prompt_async" || kind === "command" || kind === "shell" || kind === "summarize") {
    return kind;
  }
  throw new Error("queued run kind must be prompt_async, command, shell, or summarize");
}

function optionalBodyBoolean(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  return typeof value === "boolean" ? value : null;
}

function optionalBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeIntervalMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function normalizeNonNegativeDelayMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function sortQueueDiagnostics(
  entries: Array<{ workspaceId: string; conversationId: string }>,
): Array<{ workspaceId: string; conversationId: string }> {
  return entries.sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId) || a.conversationId.localeCompare(b.conversationId)
  );
}

function sortReconcileDiagnostics(
  entries: Array<{ workspaceId: string; conversationId: string; runId: string }>,
): Array<{ workspaceId: string; conversationId: string; runId: string }> {
  return entries.sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId) ||
    a.conversationId.localeCompare(b.conversationId) ||
    a.runId.localeCompare(b.runId)
  );
}

function queueDiagnosticsFromKeys(keys: Iterable<string>): Array<{ workspaceId: string; conversationId: string }> {
  const entries: Array<{ workspaceId: string; conversationId: string }> = [];
  for (const key of keys) {
    const [workspaceId, conversationId] = key.split("\0");
    if (!workspaceId || !conversationId) continue;
    entries.push({ workspaceId, conversationId });
  }
  return sortQueueDiagnostics(entries);
}

function reconcileDiagnosticsFromKeys(
  keys: Iterable<string>,
): Array<{ workspaceId: string; conversationId: string; runId: string }> {
  const entries: Array<{ workspaceId: string; conversationId: string; runId: string }> = [];
  for (const key of keys) {
    const [workspaceId, conversationId, runId] = key.split("\0");
    if (!workspaceId || !conversationId || !runId) continue;
    entries.push({ workspaceId, conversationId, runId });
  }
  return sortReconcileDiagnostics(entries);
}

function lifecycleStatusTraceFields(
  status: LifecycleRunStatusResult | null | undefined,
): Record<string, unknown> {
  return {
    clientMessageId: status?.clientMessageId ?? null,
    origin: status?.origin ?? null,
    activityKind: status?.activityKind ?? null,
    waitReason: status?.waitReason ?? null,
    lastUsefulProgressAt: status?.lastUsefulProgressAt ?? null,
    retrySince: status?.retrySince ?? null,
    noProgressSeconds: status?.noProgressSeconds ?? null,
  };
}

function lifecycleNoProgressThresholdSeconds(maxAttempts: number, pollMs: number): number {
  return Math.max(60, Math.ceil((Math.max(1, maxAttempts) * Math.max(1, pollMs)) / 1000));
}

function shouldFailStaleActiveLifecycleRun(
  status: LifecycleRunStatusResult | null | undefined,
  maxAttempts: number,
  pollMs: number,
): boolean {
  if (!status || !isActiveLifecycleStatus(status.status)) return false;
  if (status.stale === true) return true;
  const noProgressSeconds = status.noProgressSeconds;
  return typeof noProgressSeconds === "number" &&
    Number.isFinite(noProgressSeconds) &&
    noProgressSeconds >= lifecycleNoProgressThresholdSeconds(maxAttempts, pollMs);
}

function createNoopRunTrace(): ConversationRunLifecycleTracer {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    traceId: null,
    record(event: string, payload: Record<string, unknown> = {}) {
      entries.push({ event, ...payload });
    },
    async step<T>(_event: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

export function createConversationRunLifecycleController(
  options: ConversationRunLifecycleControllerOptions = {},
): ConversationRunLifecycleController {
  const scheduleTimeout = options.timers?.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearScheduledTimeout = options.timers?.clearTimeout ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const unrefTimer = options.timers?.unref ??
    ((handle) => (handle as { unref?: () => void } | null | undefined)?.unref?.());
  const diagnosticsIntervalMs = normalizeIntervalMs(options.diagnostics?.intervalMs);
  const queueDrainPollMs = normalizeIntervalMs(options.queueDrainPollMs) ?? 1_500;
  const activeTimers = new Set<unknown>();
  const queueDrainTimers = new Map<string, unknown>();
  const queueDrainInFlight = new Set<string>();
  const lifecycleReconcileTimers = new Map<string, unknown>();
  const lifecycleReconcileInFlight = new Set<string>();
  let started = false;
  let diagnosticsRuns = 0;

  const recordTrace = (event: string, payload?: Record<string, unknown>) => {
    options.trace?.record(event, payload);
  };

  const queueRun = (input: ConversationRunLifecycleSubmitInput, activeRunId: string | null) => {
    if (!options.queueStore) {
      throw new Error("Conversation run queue store is required for queued lifecycle admission");
    }
    const bodyJson = JSON.stringify({
      ...input.body,
      directory: input.target.directory,
      kind: input.kind,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submitQueuePolicy ? { submitQueuePolicy: input.submitQueuePolicy } : {}),
      ...(input.runtimeAuthorizationActorTokenHash
        ? { runtimeAuthorizationActorTokenHash: input.runtimeAuthorizationActorTokenHash }
        : {}),
    });
    let queued: ReturnType<ConversationRunQueueStore["enqueue"]>;
    try {
      queued = options.queueStore.enqueue({
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        opencodeSessionId: input.target.opencodeSessionId,
        directory: input.target.directory,
        reservedRunId: input.runId,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
        kind: input.kind,
        bodyJson,
        activeRunId,
      });
    } catch (error) {
      if (error instanceof ConversationRunQueueConflictError) {
        throw new ApiError(409, "idempotency_conflict", error.message, {
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          clientMessageId: input.clientMessageId,
        });
      }
      throw error;
    }
    input.runTrace.record("server:conversation-run:queued", {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      opencodeSessionId: input.target.opencodeSessionId,
      runId: queued.item.reservedRunId,
      queueItemId: queued.item.queueItemId,
      activeRunId: queued.item.activeRunId,
      queuePosition: queued.queuePosition,
      inserted: queued.inserted,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      submitQueuePolicy: input.submitQueuePolicy ?? null,
    });
    scheduleQueueDrain(input.workspace.id, input.target.conversationId, queueDrainPollMs);
    return {
      httpStatus: queued.inserted ? 202 : 200,
      payload: {
        ok: true,
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        opencodeSessionId: input.target.opencodeSessionId,
        runId: queued.item.reservedRunId,
        reservedRunId: queued.item.reservedRunId,
        queueItemId: queued.item.queueItemId,
        activeRunId: queued.item.activeRunId,
        queuePosition: queued.queuePosition,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
        status: "queued",
        kind: input.kind,
        debugTrace: input.runTrace.entries,
      },
    };
  };

  const activeRunMatchesClientMessage = (
    active: LifecycleRunStatusResult | null,
    input: ConversationRunLifecycleSubmitInput,
  ): boolean => {
    return Boolean(
      active &&
        input.clientMessageId &&
        active.clientMessageId &&
        active.clientMessageId === input.clientMessageId,
    );
  };

  const existingActiveRunPayload = (
    input: ConversationRunLifecycleSubmitInput,
    active: LifecycleRunStatusResult,
  ) => ({
    httpStatus: 200,
    payload: {
      ok: true,
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      opencodeSessionId: input.target.opencodeSessionId,
      runId: active.runId,
      clientMessageId: active.clientMessageId ?? input.clientMessageId,
      origin: active.origin ?? input.origin,
      status: "submitted",
      kind: input.kind,
      reusedActiveRun: true,
      debugTrace: input.runTrace.entries,
    },
  });

  const registerActiveAiGatewayRun = (input: ConversationRunLifecycleSubmitInput) => {
    if (input.expectAiGatewayStart !== true || !options.aiGatewayActiveRun) {
      return false;
    }
    options.aiGatewayActiveRun.register({
      traceId: input.runTrace.traceId,
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      opencodeSessionId: input.target.opencodeSessionId,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      runtimeAuthorizationActorTokenHash: input.runtimeAuthorizationActorTokenHash?.trim() || null,
    });
    return true;
  };

  const unregisterActiveAiGatewayRun = (input: ConversationRunLifecycleSubmitInput) => {
    options.aiGatewayActiveRun?.unregister({
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      opencodeSessionId: input.target.opencodeSessionId,
    });
  };

  const unregisterScheduledAiGatewayRun = (
    input: ConversationRunLifecycleScheduleReconcileInput,
    opencodeSessionId?: string | null,
  ) => {
    const normalizedOpencodeSessionId = opencodeSessionId?.trim() || input.opencodeSessionId?.trim() || "";
    if (!normalizedOpencodeSessionId) return;
    options.aiGatewayActiveRun?.unregister({
      workspaceId: input.workspace.id,
      conversationId: input.conversationId,
      runId: input.runId,
      opencodeSessionId: normalizedOpencodeSessionId,
    });
    recordTrace("server:ai-gateway-active-run:unregister", {
      workspaceId: input.workspace.id,
      conversationId: input.conversationId,
      runId: input.runId,
      opencodeSessionId: normalizedOpencodeSessionId,
      reason: input.reason,
    });
  };

  const scheduleAcceptedRunReconcile = (
    input: ConversationRunLifecycleSubmitInput,
    reason: string,
    delayMs: number,
  ) => {
    scheduleLifecycleReconcile({
      workspace: input.workspace,
      conversationId: input.target.conversationId,
      runId: input.runId,
      directory: input.target.directory,
      opencodeSessionId: input.target.opencodeSessionId,
      reason,
      delayMs,
    });
  };

  const markLifecycleFailed = async (
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient | null,
    event: string,
    reason: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!lifecycleOwner) return;
    await input.runTrace.step(
      event,
      () => lifecycleOwner.markFailed(input.workspace.id, input.runId, reason),
      {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        runId: input.runId,
        ...payload,
      },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const tracePayload = {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        runId: input.runId,
        reason,
        message,
        ...payload,
      };
      input.runTrace.record(`${event}:error`, tracePayload);
      recordTrace(`${event}:error`, tracePayload);
    });
  };

  const scheduleProviderStartWatch = (
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient | null,
    providerWatchStartedAt: number,
  ): boolean => {
    if (!lifecycleOwner || input.expectAiGatewayStart !== true) return false;

    const tracePayload = {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      opencodeSessionId: input.target.opencodeSessionId,
    };

    if (!options.aiGatewayProviderWatch) {
      input.runTrace.record("server:conversation-run:ai-gateway-provider-start-watch:unavailable", tracePayload);
      return false;
    }

    input.runTrace.record("server:conversation-run:ai-gateway-provider-start-watch:scheduled", tracePayload);
    void (async () => {
      try {
        const providerStart = await input.runTrace.step(
          "server:conversation-run:ai-gateway-provider-start-watch",
          () => options.aiGatewayProviderWatch!.waitForProviderStart({
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            runId: input.runId,
            opencodeSessionId: input.target.opencodeSessionId,
            clientMessageId: input.clientMessageId,
            origin: input.origin,
            startedAt: providerWatchStartedAt,
          }),
          tracePayload,
        );
        if (!providerStart.started) {
          input.runTrace.record("server:conversation-run:ai-gateway-provider-start-watch:timeout", {
            ...tracePayload,
            timeoutMs: providerStart.timeoutMs,
            message: `AI gateway provider request did not start within ${providerStart.timeoutMs}ms.`,
          });
          scheduleAcceptedRunReconcile(input, "ai-gateway-provider-start-timeout", 0);
        }
      } catch (error) {
        input.runTrace.record("server:conversation-run:ai-gateway-provider-start-watch:error", {
          ...tracePayload,
          message: error instanceof Error ? error.message : String(error),
        });
        scheduleAcceptedRunReconcile(input, "ai-gateway-provider-start-watch-error", 0);
      }
    })();
    return true;
  };

  const submitAcceptedRun = async (
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient | null,
  ) => {
    if (!options.submitOpenCode) {
      throw new Error("OpenCode submit port is required for admitted conversation runs");
    }
    const providerWatchStartedAt = Date.now();
    let activeAiGatewayRunRegistered = registerActiveAiGatewayRun(input);
    const unregisterRegisteredAiGatewayRun = () => {
      if (!activeAiGatewayRunRegistered) return;
      activeAiGatewayRunRegistered = false;
      unregisterActiveAiGatewayRun(input);
    };

    let upstream: unknown;
    try {
      upstream = await options.submitOpenCode({
        runTrace: input.runTrace,
        workspace: input.workspace,
        target: input.target,
        runId: input.runId,
        kind: input.kind,
        body: input.body,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
      });
    } catch (error) {
      await markLifecycleFailed(
        input,
        lifecycleOwner,
        "server:conversation-run:lifecycle-mark-failed",
        error instanceof Error ? error.message : String(error),
      );
      scheduleAcceptedRunReconcile(input, "submit-failed", 0);
      unregisterRegisteredAiGatewayRun();
      throw error;
    }

    const providerWatchOwnsGatewayRun = scheduleProviderStartWatch(
      input,
      lifecycleOwner,
      providerWatchStartedAt,
    );
    if (!providerWatchOwnsGatewayRun) {
      unregisterRegisteredAiGatewayRun();
    }

    scheduleAcceptedRunReconcile(
      input,
      "accepted",
      options.resolveLifecycleReconcileInitialDelayMs?.() ?? 0,
    );
    return upstream;
  };

  const clearTimer = (handle: unknown) => {
    if (!activeTimers.delete(handle)) return;
    clearScheduledTimeout(handle);
  };

  const clearAllTimers = () => {
    for (const handle of [...activeTimers]) {
      clearTimer(handle);
    }
    queueDrainTimers.clear();
    lifecycleReconcileTimers.clear();
  };

  const queueKey = (workspaceId: string, conversationId: string) => `${workspaceId}\0${conversationId}`;
  const reconcileKey = (workspaceId: string, conversationId: string, runId: string) =>
    `${workspaceId}\0${conversationId}\0${runId}`;

  function scheduleQueueDrain(workspaceId: string, conversationId: string, delayMs = 0): void {
    const normalizedConversationId = conversationId.trim();
    if (!workspaceId.trim() || !normalizedConversationId) return;
    const key = queueKey(workspaceId, normalizedConversationId);
    const normalizedDelayMs = normalizeNonNegativeDelayMs(delayMs);
    const existing = queueDrainTimers.get(key);
    if (existing) {
      if (normalizedDelayMs > 0) return;
      clearTimer(existing);
      queueDrainTimers.delete(key);
    }
    const handle = scheduleTimeout(() => {
      activeTimers.delete(handle);
      queueDrainTimers.delete(key);
      void drainConversationQueue(workspaceId, normalizedConversationId);
    }, normalizedDelayMs);
    activeTimers.add(handle);
    queueDrainTimers.set(key, handle);
    unrefTimer(handle);
    recordTrace("server:conversation-run:queue-drain-scheduled", {
      workspaceId,
      conversationId: normalizedConversationId,
      delayMs: normalizedDelayMs,
    });
  }

  function scheduleLifecycleReconcile(input: ConversationRunLifecycleScheduleReconcileInput): void {
    const conversationId = input.conversationId.trim();
    const runId = input.runId.trim();
    if (!input.workspace.id.trim() || !conversationId || !runId) return;
    const key = reconcileKey(input.workspace.id, conversationId, runId);
    const delayMs = normalizeNonNegativeDelayMs(input.delayMs);
    const existing = lifecycleReconcileTimers.get(key);
    if (existing) {
      if (delayMs > 0 && input.abortRequested !== true) return;
      clearTimer(existing);
      lifecycleReconcileTimers.delete(key);
    }
    const handle = scheduleTimeout(() => {
      activeTimers.delete(handle);
      lifecycleReconcileTimers.delete(key);
      void reconcileConversationRunLifecycle({
        ...input,
        conversationId,
        runId,
        attempt: input.attempt ?? 0,
      });
    }, delayMs);
    activeTimers.add(handle);
    lifecycleReconcileTimers.set(key, handle);
    unrefTimer(handle);
    recordTrace("server:conversation-run:lifecycle-reconcile-scheduled", {
      workspaceId: input.workspace.id,
      conversationId,
      runId,
      opencodeSessionId: input.opencodeSessionId?.trim() || null,
      reason: input.reason,
      abortRequested: input.abortRequested === true,
      attempt: input.attempt ?? 0,
      delayMs,
    });
  }

  async function reconcileConversationRunLifecycle(input: ConversationRunLifecycleScheduleReconcileInput): Promise<void> {
    const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
    if (!lifecycleOwner) return;
    const conversationId = input.conversationId.trim();
    const runId = input.runId.trim();
    if (!conversationId || !runId) return;
    const key = reconcileKey(input.workspace.id, conversationId, runId);
    const pollMs = normalizeIntervalMs(options.resolveLifecycleReconcilePollMs?.()) ?? 1_000;
    const maxAttempts = Math.max(1, Math.floor(options.resolveLifecycleReconcileMaxAttempts?.() ?? 600));
    if (lifecycleReconcileInFlight.has(key)) {
      scheduleLifecycleReconcile({
        ...input,
        conversationId,
        runId,
        delayMs: pollMs,
      });
      return;
    }

    const attempt = input.attempt ?? 0;
    const scheduleNextAttempt = async (status?: LifecycleRunStatusResult | null) => {
      const nextAttempt = attempt + 1;
      if (nextAttempt >= maxAttempts) {
        recordTrace("server:conversation-run:lifecycle-reconcile-exhausted", {
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: input.reason,
          abortRequested: input.abortRequested === true,
          attempts: nextAttempt,
          status: status?.status ?? null,
          stale: status?.stale ?? null,
          ...lifecycleStatusTraceFields(status),
        });
        if (shouldFailStaleActiveLifecycleRun(status, maxAttempts, pollMs)) {
          await lifecycleOwner.markFailed(
            input.workspace.id,
            status?.runId?.trim() || runId,
            "run lifecycle reconcile exhausted after stale/no-progress active status",
          ).then(() => {
            recordTrace("server:conversation-run:lifecycle-reconcile-stale-failed", {
              workspaceId: input.workspace.id,
              conversationId,
              runId: status?.runId?.trim() || runId,
              reason: input.reason,
              attempts: nextAttempt,
              status: status?.status ?? null,
              stale: status?.stale ?? null,
              ...lifecycleStatusTraceFields(status),
            });
            unregisterScheduledAiGatewayRun(input);
            scheduleQueueDrain(input.workspace.id, conversationId, 0);
          }).catch((error) => {
            recordTrace("server:conversation-run:lifecycle-mark-failed-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId: status?.runId?.trim() || runId,
              reason: input.reason,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return;
      }
      scheduleLifecycleReconcile({
        ...input,
        conversationId,
        runId,
        attempt: nextAttempt,
        delayMs: pollMs,
      });
    };

    lifecycleReconcileInFlight.add(key);
    try {
      const status = await lifecycleOwner.status(input.workspace.id, conversationId, runId);
      recordTrace("server:conversation-run:lifecycle-reconcile", {
        workspaceId: input.workspace.id,
        conversationId,
        runId,
        reason: input.reason,
        abortRequested: input.abortRequested === true,
        status: status?.status ?? null,
        stale: status?.stale ?? null,
        ...lifecycleStatusTraceFields(status),
        attempt,
      });

      if (!status) {
        unregisterScheduledAiGatewayRun(input);
        if (input.abortRequested === true) {
          await lifecycleOwner.markAborted(
            input.workspace.id,
            runId,
            "user abort reconciled after missing lifecycle status",
          ).catch((error) => {
            recordTrace("server:conversation-run:lifecycle-mark-aborted-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              reason: input.reason,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        scheduleQueueDrain(input.workspace.id, conversationId, 0);
        return;
      }

      if (status.stale === true) {
        recordTrace("server:conversation-run:lifecycle-reconcile-stale", {
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: input.reason,
          status: status.status,
          abortRequested: input.abortRequested === true,
          attempt,
        });
        await scheduleNextAttempt(status);
        return;
      }

      if (!isActiveLifecycleStatus(status.status)) {
        unregisterScheduledAiGatewayRun(input);
        if (input.abortRequested === true && status.status !== "aborted") {
          await lifecycleOwner.markAborted(
            input.workspace.id,
            runId,
            "user abort reconciled after engine became inactive",
          ).catch((error) => {
            recordTrace("server:conversation-run:lifecycle-mark-aborted-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              reason: input.reason,
              status: status.status,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        const directory = input.directory?.trim() ?? "";
        const opencodeSessionId = input.opencodeSessionId?.trim() ?? "";
        if (directory && opencodeSessionId && options.ingestTerminalTranscript) {
          void options.ingestTerminalTranscript({
              workspace: input.workspace,
              directory,
              opencodeSessionId,
              runId,
            }).then(() => {
            recordTrace("server:conversation-run:terminal-transcript-ingest", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              opencodeSessionId,
              status: status.status,
            });
          }).catch((error) => {
            recordTrace("server:conversation-run:terminal-transcript-ingest-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              opencodeSessionId,
              status: status.status,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        scheduleQueueDrain(input.workspace.id, conversationId, 0);
        return;
      }

      await scheduleNextAttempt(status);
    } catch (error) {
      recordTrace("server:conversation-run:lifecycle-reconcile-error", {
        workspaceId: input.workspace.id,
        conversationId,
        runId,
        reason: input.reason,
        abortRequested: input.abortRequested === true,
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      await scheduleNextAttempt();
    } finally {
      lifecycleReconcileInFlight.delete(key);
    }
  }

  async function drainConversationQueue(workspaceId: string, conversationId: string): Promise<void> {
    const normalizedConversationId = conversationId.trim();
    if (!workspaceId.trim() || !normalizedConversationId || !options.queueStore) return;
    const key = queueKey(workspaceId, normalizedConversationId);
    if (queueDrainInFlight.has(key)) return;
    queueDrainInFlight.add(key);
    let item = null as ReturnType<ConversationRunQueueStore["nextPending"]>;
    let runTrace: ConversationRunLifecycleTracer | null = null;
    try {
      const workspace = options.resolveWorkspace?.(workspaceId) ?? null;
      if (!workspace) return;
      const lifecycleOwner = workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
      runTrace = options.createBackgroundRunTrace?.() ?? createNoopRunTrace();
      if (lifecycleOwner) {
        try {
          const latest = await lifecycleOwner.status(workspace.id, normalizedConversationId, "latest");
          if (latest && isActiveLifecycleStatus(latest.status)) {
            if (latest.stale === true) {
              const activeRunId = latest.runId?.trim() || "latest";
              runTrace.record("server:conversation-run:queue-drain-stale-active-deferred", {
                workspaceId,
                conversationId: normalizedConversationId,
                runId: activeRunId,
                status: latest.status,
                stale: latest.stale,
                ...lifecycleStatusTraceFields(latest),
              });
              scheduleLifecycleReconcile({
                workspace,
                conversationId: normalizedConversationId,
                runId: activeRunId,
                reason: "queue-drain-active-stale",
                delayMs: 0,
              });
              return;
            }
            scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
            return;
          }
        } catch (error) {
          runTrace.record("server:conversation-run:queue-drain-status-error", {
            workspaceId,
            conversationId: normalizedConversationId,
            message: error instanceof Error ? error.message : String(error),
          });
          scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
          return;
        }
      }

      item = options.queueStore.nextPending(workspaceId, normalizedConversationId);
      if (!item) return;
      const claimed = options.queueStore.markStarting(item.queueItemId);
      if (!claimed || claimed.state !== "starting") {
        runTrace.record("server:conversation-run:queue-drain-claim-lost", {
          workspaceId,
          conversationId: normalizedConversationId,
          queueItemId: item.queueItemId,
          state: claimed?.state ?? null,
        });
        return;
      }
      item = claimed;

      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(item.bodyJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("queued run body must be an object");
        }
        body = parsed as Record<string, unknown>;
      } catch (error) {
        const failed = options.queueStore.markFailed(
          item.queueItemId,
          error instanceof Error ? error.message : String(error),
        );
        if (!failed) {
          runTrace.record("server:conversation-run:queue-drain-terminal-transition-stale", {
            workspaceId,
            conversationId: normalizedConversationId,
            queueItemId: item.queueItemId,
            transition: "failed",
          });
        }
        return;
      }

      const kind = parseQueuedRunKind(item.kind);
      const expectAiGatewayStart = optionalBodyBoolean(body, "expectAiGatewayStart") === true;
      const runtimeAuthorizationActorTokenHash =
        optionalBodyString(body, "runtimeAuthorizationActorTokenHash") || null;
      const target: ConversationRunLifecycleTarget = {
        directory: item.directory,
        binding: null,
        opencodeSessionId: item.opencodeSessionId,
        conversationId: item.conversationId,
      };

      if (lifecycleOwner) {
        try {
          await runTrace.step(
            "server:conversation-run:queue-lifecycle-register",
            () => lifecycleOwner.register({
              workspaceId: workspace.id,
              conversationId: item!.conversationId,
              runId: item!.reservedRunId,
              engineSessionId: item!.opencodeSessionId,
              clientMessageId: item!.clientMessageId,
              origin: item!.origin,
              directory: item!.directory,
              kind: lifecycleRunKind(kind),
            }),
            {
              workspaceId: workspace.id,
              conversationId: item.conversationId,
              runId: item.reservedRunId,
              engineSessionId: item.opencodeSessionId,
              queueItemId: item.queueItemId,
            },
          );
        } catch (error) {
          if (error instanceof RunAlreadyActiveError) {
            const pending = options.queueStore.markPending(item.queueItemId, error.activeRunId);
            if (!pending) {
              runTrace.record("server:conversation-run:queue-drain-terminal-transition-stale", {
                workspaceId,
                conversationId: normalizedConversationId,
                queueItemId: item.queueItemId,
                transition: "pending",
              });
              return;
            }
            scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
            return;
          }
          const failed = options.queueStore.markFailed(
            item.queueItemId,
            error instanceof Error ? error.message : String(error),
          );
          if (!failed) {
            runTrace.record("server:conversation-run:queue-drain-terminal-transition-stale", {
              workspaceId,
              conversationId: normalizedConversationId,
              queueItemId: item.queueItemId,
              transition: "failed",
            });
          }
          return;
        }
      }

      await submitAcceptedRun({
        runTrace,
        workspace,
        target,
        runId: item.reservedRunId,
        kind,
        body,
        clientMessageId: item.clientMessageId,
        origin: item.origin,
        expectAiGatewayStart,
        runtimeAuthorizationActorTokenHash,
      }, lifecycleOwner);
      const submitted = options.queueStore.markSubmitted(item.queueItemId);
      if (!submitted) {
        runTrace.record("server:conversation-run:queue-drain-terminal-transition-stale", {
          workspaceId,
          conversationId: normalizedConversationId,
          queueItemId: item.queueItemId,
          transition: "submitted",
        });
      }
      scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
    } catch (error) {
      if (item) {
        const failed = options.queueStore.markFailed(
          item.queueItemId,
          error instanceof Error ? error.message : String(error),
        );
        if (!failed) {
          (runTrace ?? createNoopRunTrace()).record("server:conversation-run:queue-drain-terminal-transition-stale", {
            workspaceId,
            conversationId: normalizedConversationId,
            queueItemId: item.queueItemId,
            transition: "failed",
          });
        }
      }
    } finally {
      queueDrainInFlight.delete(key);
    }
  }

  async function abortRun(input: ConversationRunLifecycleAbortInput): Promise<ConversationRunLifecycleAbortResult> {
    if (!options.abortOpenCode) {
      throw new Error("OpenCode abort port is required for conversation aborts");
    }
    const runTrace = options.createBackgroundRunTrace?.() ?? createNoopRunTrace();
    const abortedGatewayRequests = options.abortActiveGatewayProxyRequests?.({
      workspaceId: input.workspace.id,
      runId: input.runId,
      sessionId: input.target.opencodeSessionId,
      reason: "conversation-abort",
    }) ?? [];

    const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
    if (lifecycleOwner) {
      await lifecycleOwner.markAbortRequested(input.workspace.id, input.runId).catch((error) => {
        recordTrace("server:conversation-run:lifecycle-abort-requested-error", {
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          runId: input.runId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      scheduleLifecycleReconcile({
        workspace: input.workspace,
        conversationId: input.target.conversationId,
        runId: input.runId,
        directory: input.target.directory,
        opencodeSessionId: input.target.opencodeSessionId,
        reason: "abort-requested",
        abortRequested: true,
        delayMs: 0,
      });
    }

    let upstream: unknown;
    try {
      upstream = await options.abortOpenCode({
        runTrace,
        workspace: input.workspace,
        target: input.target,
        runId: input.runId,
      });
      if (lifecycleOwner) {
        await lifecycleOwner.markAborted(
          input.workspace.id,
          input.runId,
          "user abort reconciled after OpenCode abort",
        ).catch((error) => {
          recordTrace("server:conversation-run:lifecycle-mark-aborted-error", {
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            runId: input.runId,
            reason: "abort-requested",
            message: error instanceof Error ? error.message : String(error),
          });
        });
        scheduleQueueDrain(input.workspace.id, input.target.conversationId, 0);
      }
    } catch (error) {
      if (!lifecycleOwner) throw error;
      const message = error instanceof Error ? error.message : String(error);
      recordTrace("server:conversation-run:opencode-abort-error", {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        runId: input.runId,
        message,
      });
      upstream = {
        ok: false,
        error: "opencode_abort_failed",
        message,
      };
    }

    return {
      upstream,
      abortedGatewayRequestCount: abortedGatewayRequests.length,
    };
  }

  function schedulePendingQueueDrains(): void {
    const recoverStarting = options.queueStore?.recoverStarting;
    if (typeof recoverStarting === "function") {
      for (const recovered of recoverStarting.call(options.queueStore)) {
        recordTrace("server:conversation-run:queue-starting-recovered", {
          workspaceId: recovered.workspaceId,
          conversationId: recovered.conversationId,
        });
      }
    }
    const pendingConversationKeys = options.queueStore?.pendingConversationKeys;
    if (typeof pendingConversationKeys !== "function") return;
    for (const pending of pendingConversationKeys.call(options.queueStore)) {
      scheduleQueueDrain(pending.workspaceId, pending.conversationId, queueDrainPollMs);
    }
  }

  const scheduleDiagnosticsTimer = () => {
    if (!started || diagnosticsIntervalMs === null) return;
    const handle = scheduleTimeout(() => {
      activeTimers.delete(handle);
      if (!started) return;
      diagnosticsRuns += 1;
      recordTrace("conversation-run-lifecycle:diagnostics", { runs: diagnosticsRuns });
      scheduleDiagnosticsTimer();
    }, diagnosticsIntervalMs);
    activeTimers.add(handle);
    unrefTimer(handle);
  };

  return {
    async submitRun(input) {
      const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
      input.runTrace.record("server:conversation-run:lifecycle-owner", {
        workspaceId: input.workspace.id,
        runId: input.runId,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
        enabled: Boolean(lifecycleOwner),
        workspaceType: input.workspace.workspaceType,
      });
      if (input.submitQueuePolicy === "server-queue-only") {
        input.runTrace.record("server:conversation-run:queue-policy-server-only", {
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          runId: input.runId,
          clientMessageId: input.clientMessageId,
          origin: input.origin,
        });
        return queueRun(input, null);
      }
      if (lifecycleOwner) {
        try {
          const active = await input.runTrace.step(
            "server:conversation-run:lifecycle-active-peek",
            () => lifecycleOwner.active(input.workspace.id, input.target.conversationId),
            {
              workspaceId: input.workspace.id,
              conversationId: input.target.conversationId,
            },
          );
          if (active && isActiveLifecycleStatus(active.status)) {
            if (activeRunMatchesClientMessage(active, input)) {
              input.runTrace.record("server:conversation-run:lifecycle-active-reused", {
                workspaceId: input.workspace.id,
                conversationId: input.target.conversationId,
                runId: active.runId,
                clientMessageId: input.clientMessageId,
                origin: input.origin,
              });
              return existingActiveRunPayload(input, active);
            }
            return queueRun(input, active.runId);
          }
        } catch (error) {
          input.runTrace.record("server:conversation-run:lifecycle-active-peek-skipped", {
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          const registered = await input.runTrace.step(
            "server:conversation-run:lifecycle-register",
            () => lifecycleOwner.register({
              workspaceId: input.workspace.id,
              conversationId: input.target.conversationId,
              runId: input.runId,
              engineSessionId: input.target.opencodeSessionId,
              clientMessageId: input.clientMessageId,
              origin: input.origin,
              directory: input.target.directory,
              kind: lifecycleRunKind(input.kind),
            }),
            {
              workspaceId: input.workspace.id,
              conversationId: input.target.conversationId,
              runId: input.runId,
              engineSessionId: input.target.opencodeSessionId,
              kind: lifecycleRunKind(input.kind),
            },
          );
          if (registered && registered.runId !== input.runId && activeRunMatchesClientMessage(registered, input)) {
            input.runTrace.record("server:conversation-run:lifecycle-register-reused", {
              workspaceId: input.workspace.id,
              conversationId: input.target.conversationId,
              runId: registered.runId,
              clientMessageId: input.clientMessageId,
              origin: input.origin,
            });
            return existingActiveRunPayload(input, registered);
          }
        } catch (error) {
          if (error instanceof RunAlreadyActiveError) {
            try {
              const active = await input.runTrace.step(
                "server:conversation-run:lifecycle-active-after-register-conflict",
                () => lifecycleOwner.active(input.workspace.id, input.target.conversationId),
                {
                  workspaceId: input.workspace.id,
                  conversationId: input.target.conversationId,
                  activeRunId: error.activeRunId || null,
                },
              );
              if (active && isActiveLifecycleStatus(active.status) && activeRunMatchesClientMessage(active, input)) {
                input.runTrace.record("server:conversation-run:lifecycle-register-conflict-reused", {
                  workspaceId: input.workspace.id,
                  conversationId: input.target.conversationId,
                  runId: active.runId,
                  clientMessageId: input.clientMessageId,
                  origin: input.origin,
                });
                return existingActiveRunPayload(input, active);
              }
            } catch (activeError) {
              input.runTrace.record("server:conversation-run:lifecycle-register-conflict-active-skipped", {
                workspaceId: input.workspace.id,
                conversationId: input.target.conversationId,
                activeRunId: error.activeRunId || null,
                message: activeError instanceof Error ? activeError.message : String(activeError),
              });
            }
            return queueRun(input, error.activeRunId || null);
          }
          if (error instanceof OrchestratorLifecycleRequestError) {
            throw lifecycleRequestApiError(error);
          }
          throw error;
        }
      }
      if (!options.submitOpenCode) {
        throw new Error("OpenCode submit port is required for admitted conversation runs");
      }
      const upstream = await submitAcceptedRun(input, lifecycleOwner);
      input.runTrace.record("server:conversation-run:submitted", {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        opencodeSessionId: input.target.opencodeSessionId,
        runId: input.runId,
        kind: input.kind,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
      });
      return {
        httpStatus: 200,
        payload: {
          ok: true,
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          opencodeSessionId: input.target.opencodeSessionId,
          runId: input.runId,
          clientMessageId: input.clientMessageId,
          origin: input.origin,
          status: "submitted",
          kind: input.kind,
          upstream,
          debugTrace: input.runTrace.entries,
        },
      };
    },
    submitAcceptedRun,
    scheduleQueueDrain,
    drainConversationQueue,
    scheduleLifecycleReconcile,
    reconcileConversationRunLifecycle,
    abortRun,
    start() {
      if (started) return;
      started = true;
      recordTrace("conversation-run-lifecycle:start");
      schedulePendingQueueDrains();
      scheduleDiagnosticsTimer();
    },
    stop() {
      if (!started && activeTimers.size === 0) return;
      started = false;
      clearAllTimers();
      recordTrace("conversation-run-lifecycle:stop");
    },
    snapshotForTests() {
      return {
        started,
        activeTimerCount: activeTimers.size,
        diagnostics: {
          enabled: diagnosticsIntervalMs !== null,
          intervalMs: diagnosticsIntervalMs,
          runs: diagnosticsRuns,
        },
        lifecycle: {
          pendingQueueDrains: queueDiagnosticsFromKeys(queueDrainTimers.keys()),
          pendingLifecycleReconciles: reconcileDiagnosticsFromKeys(lifecycleReconcileTimers.keys()),
          inFlightQueueDrains: queueDiagnosticsFromKeys(queueDrainInFlight.keys()),
          inFlightLifecycleReconciles: reconcileDiagnosticsFromKeys(lifecycleReconcileInFlight.keys()),
        },
        ports: {
          lifecycleClient: Boolean(options.lifecycleClient),
          queueStore: Boolean(options.queueStore),
          submitOpenCode: Boolean(options.submitOpenCode),
          aiGatewayProviderWatch: Boolean(options.aiGatewayProviderWatch),
        },
      };
    },
  };
}
