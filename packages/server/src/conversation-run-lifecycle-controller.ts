import type { ConversationRunQueueStore } from "./conversation-run-queue-store.js";
import type { OrchestratorLifecycleClient } from "./orchestrator-lifecycle-client.js";

export type ConversationRunLifecycleTimerPort = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  unref?(handle: unknown): void;
};

export type ConversationRunLifecycleTracePort = {
  record(event: string, payload?: Record<string, unknown>): void;
};

export type ConversationRunLifecycleSubmitOpenCodePort = (input: unknown) => Promise<unknown>;

export type ConversationRunLifecycleAiGatewayProviderWatchPort = {
  waitForProviderStart(input: unknown): Promise<unknown>;
};

export type ConversationRunLifecycleControllerOptions = {
  lifecycleClient?: OrchestratorLifecycleClient | null;
  queueStore?: ConversationRunQueueStore | null;
  submitOpenCode?: ConversationRunLifecycleSubmitOpenCodePort | null;
  aiGatewayProviderWatch?: ConversationRunLifecycleAiGatewayProviderWatchPort | null;
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
  start(): void;
  stop(): void;
  snapshotForTests(): ConversationRunLifecycleSnapshot;
};

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
  const activeTimers = new Set<unknown>();
  let started = false;
  let diagnosticsRuns = 0;

  const recordTrace = (event: string, payload?: Record<string, unknown>) => {
    options.trace?.record(event, payload);
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
