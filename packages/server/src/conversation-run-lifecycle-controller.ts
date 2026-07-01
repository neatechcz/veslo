import type { ConversationRunQueueStore } from "./conversation-run-queue-store.js";
import { ApiError } from "./errors.js";
import {
  OrchestratorLifecycleRequestError,
  RunAlreadyActiveError,
  type LifecycleRunStatus,
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
  expectAiGatewayStart: boolean;
  lifecycleOwner: OrchestratorLifecycleClient | null;
};

export type ConversationRunLifecycleSubmitOpenCodePort = (
  input: ConversationRunLifecycleSubmitOpenCodeInput,
) => Promise<unknown>;

export type ConversationRunLifecycleAiGatewayProviderWatchPort = {
  waitForProviderStart(input: unknown): Promise<unknown>;
};

export type ConversationRunLifecycleSubmitInput = {
  runTrace: ConversationRunLifecycleTracer;
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
  kind: ConversationRunLifecycleKind;
  body: Record<string, unknown>;
  clientMessageId: string | null;
  origin: string | null;
  expectAiGatewayStart: boolean;
};

export type ConversationRunLifecycleSubmitResult = {
  httpStatus: number;
  payload: Record<string, unknown>;
};

export type ConversationRunLifecycleControllerOptions = {
  lifecycleClient?: OrchestratorLifecycleClient | null;
  queueStore?: ConversationRunQueueStore | null;
  submitOpenCode?: ConversationRunLifecycleSubmitOpenCodePort | null;
  aiGatewayProviderWatch?: ConversationRunLifecycleAiGatewayProviderWatchPort | null;
  scheduleQueueDrain?: (workspaceId: string, conversationId: string, delayMs: number) => void;
  queueDrainPollMs?: number;
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
  ports: {
    lifecycleClient: boolean;
    queueStore: boolean;
    submitOpenCode: boolean;
    aiGatewayProviderWatch: boolean;
  };
};

export type ConversationRunLifecycleController = {
  submitRun(input: ConversationRunLifecycleSubmitInput): Promise<ConversationRunLifecycleSubmitResult>;
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

function normalizeIntervalMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
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
    });
    const queued = options.queueStore.enqueue({
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
    });
    options.scheduleQueueDrain?.(input.workspace.id, input.target.conversationId, queueDrainPollMs);
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

  const clearTimer = (handle: unknown) => {
    if (!activeTimers.delete(handle)) return;
    clearScheduledTimeout(handle);
  };

  const clearAllTimers = () => {
    for (const handle of [...activeTimers]) {
      clearTimer(handle);
    }
  };

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
          await input.runTrace.step(
            "server:conversation-run:lifecycle-register",
            () => lifecycleOwner.register({
              workspaceId: input.workspace.id,
              conversationId: input.target.conversationId,
              runId: input.runId,
              engineSessionId: input.target.opencodeSessionId,
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
        } catch (error) {
          if (error instanceof RunAlreadyActiveError) {
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
      const upstream = await options.submitOpenCode({
        runTrace: input.runTrace,
        workspace: input.workspace,
        target: input.target,
        runId: input.runId,
        kind: input.kind,
        body: input.body,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
        expectAiGatewayStart: input.expectAiGatewayStart,
        lifecycleOwner,
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
    start() {
      if (started) return;
      started = true;
      recordTrace("conversation-run-lifecycle:start");
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
