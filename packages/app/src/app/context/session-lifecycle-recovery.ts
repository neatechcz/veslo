import type { VesloConversationRunLifecycleStatus } from "../lib/veslo-server";

export type SessionLifecycleRecoveryScope = {
  sessionId: string;
  workspaceId: string;
  conversationId: string;
  opencodeSessionId?: string | null;
  directory?: string | null;
  runId: string;
};

export type SessionLifecycleRecoveryStatus = {
  runId?: string | null;
  status: VesloConversationRunLifecycleStatus;
  stale: boolean;
};

export type SessionLifecycleRecoveryControllerOptions = {
  sessionStatusById: () => Record<string, string>;
  selectedSessionId: () => string | null;
  resolveConversationRunForSession: (
    sessionId: string,
    workspaceIdHint?: string | null,
  ) => SessionLifecycleRecoveryScope | null;
  readConversationRunStatus: (
    scope: SessionLifecycleRecoveryScope,
  ) => Promise<SessionLifecycleRecoveryStatus | null>;
  setSessionStatusForWorkspace: (
    sessionId: string | null | undefined,
    status: string,
    workspaceId?: string | null,
  ) => void;
  notifySessionBusy: (sessionId: string, status: string, workspaceId?: string) => void;
  scheduleTranscriptIngestion: (
    sessionId: string,
    workspaceId: string | undefined,
    reason: string,
    delayMs?: number,
  ) => void;
  scheduleBackgroundTranscriptIngestion: (
    sessionId: string,
    workspaceId: string,
    reason: string,
    delayMs?: number,
  ) => void;
  trace?: (event: string, payload?: Record<string, unknown>) => void;
  initialDelayMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  scheduleTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

const ACTIVE_UI_STATUSES = new Set(["running", "retry", "submitted", "blocked"]);
const TERMINAL_LIFECYCLE_STATUSES = new Set<VesloConversationRunLifecycleStatus>([
  "completed",
  "failed",
  "aborted",
]);

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 600;

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

const unique = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const parseStatusKey = (key: string) => {
  const index = key.indexOf("\0");
  if (index < 0) {
    return { workspaceId: "", sessionId: normalize(key) };
  }
  return {
    workspaceId: normalize(key.slice(0, index)),
    sessionId: normalize(key.slice(index + 1)),
  };
};

const recoveryKey = (scope: SessionLifecycleRecoveryScope) => {
  const workspaceId = normalize(scope.workspaceId);
  const conversationId = normalize(scope.conversationId);
  const runId = normalize(scope.runId);
  return workspaceId && conversationId && runId ? `${workspaceId}\0${conversationId}\0${runId}` : "";
};

export function createSessionLifecycleRecoveryController(
  options: SessionLifecycleRecoveryControllerOptions,
) {
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  const pollMs = Math.max(250, options.pollMs ?? DEFAULT_POLL_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const setTimer = options.scheduleTimer ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const clearTimer = options.clearTimer ?? ((timer: unknown) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  });

  type Watch = {
    scope: SessionLifecycleRecoveryScope;
    attempts: number;
    inFlight: boolean;
    timer: unknown | null;
  };

  const watches = new Map<string, Watch>();

  const trace = (event: string, payload?: Record<string, unknown>) => {
    options.trace?.(event, payload);
  };

  const clearWatch = (key: string) => {
    const watch = watches.get(key);
    if (!watch) return;
    if (watch.timer) clearTimer(watch.timer);
    watches.delete(key);
  };

  const scheduleWatch = (key: string, delayMs: number) => {
    const watch = watches.get(key);
    if (!watch || watch.timer) return;
    watch.timer = setTimer(() => {
      const current = watches.get(key);
      if (!current) return;
      current.timer = null;
      void pollWatch(key);
    }, delayMs);
  };

  const recoverTerminalRun = (
    scope: SessionLifecycleRecoveryScope,
    status: VesloConversationRunLifecycleStatus,
  ) => {
    const workspaceId = normalize(scope.workspaceId);
    const sessionIds = unique([
      scope.sessionId,
      scope.opencodeSessionId,
      scope.conversationId,
    ]);
    for (const sessionId of sessionIds) {
      options.setSessionStatusForWorkspace(sessionId, "idle", workspaceId);
      options.notifySessionBusy(sessionId, "idle", workspaceId);
    }

    const selectedSessionId = normalize(options.selectedSessionId());
    const transcriptSessionId =
      (selectedSessionId && sessionIds.includes(selectedSessionId) ? selectedSessionId : "") ||
      normalize(scope.opencodeSessionId) ||
      normalize(scope.sessionId);
    if (transcriptSessionId && workspaceId) {
      if (selectedSessionId && sessionIds.includes(selectedSessionId)) {
        options.scheduleTranscriptIngestion(transcriptSessionId, workspaceId, "lifecycle recovery", 0);
      } else {
        options.scheduleBackgroundTranscriptIngestion(transcriptSessionId, workspaceId, "lifecycle recovery", 0);
      }
    }

    trace("session-lifecycle-recovery:terminal", {
      workspaceId,
      conversationId: scope.conversationId,
      runId: scope.runId,
      status,
      sessionIds,
    });
  };

  async function pollWatch(key: string): Promise<void> {
    const watch = watches.get(key);
    if (!watch) return;
    if (watch.inFlight) {
      scheduleWatch(key, pollMs);
      return;
    }
    watch.inFlight = true;
    watch.attempts += 1;
    try {
      const status = await options.readConversationRunStatus(watch.scope);
      trace("session-lifecycle-recovery:poll", {
        workspaceId: watch.scope.workspaceId,
        conversationId: watch.scope.conversationId,
        runId: watch.scope.runId,
        status: status?.status ?? null,
        stale: status?.stale ?? null,
        attempt: watch.attempts,
      });
      if (status && status.stale !== true && TERMINAL_LIFECYCLE_STATUSES.has(status.status)) {
        recoverTerminalRun(watch.scope, status.status);
        clearWatch(key);
        return;
      }
    } catch (error) {
      trace("session-lifecycle-recovery:error", {
        workspaceId: watch.scope.workspaceId,
        conversationId: watch.scope.conversationId,
        runId: watch.scope.runId,
        attempt: watch.attempts,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const current = watches.get(key);
      if (current) current.inFlight = false;
    }

    const current = watches.get(key);
    if (!current) return;
    if (current.attempts >= maxAttempts) {
      trace("session-lifecycle-recovery:exhausted", {
        workspaceId: current.scope.workspaceId,
        conversationId: current.scope.conversationId,
        runId: current.scope.runId,
        attempts: current.attempts,
      });
      clearWatch(key);
      return;
    }
    scheduleWatch(key, pollMs);
  }

  const reconcile = () => {
    const desired = new Map<string, SessionLifecycleRecoveryScope>();
    for (const [rawKey, rawStatus] of Object.entries(options.sessionStatusById())) {
      const status = normalize(rawStatus);
      if (!ACTIVE_UI_STATUSES.has(status)) continue;
      const parsed = parseStatusKey(rawKey);
      if (!parsed.sessionId) continue;
      const scope = options.resolveConversationRunForSession(parsed.sessionId, parsed.workspaceId);
      if (!scope) continue;
      const key = recoveryKey(scope);
      if (key) desired.set(key, scope);
    }

    for (const key of [...watches.keys()]) {
      if (!desired.has(key)) clearWatch(key);
    }

    for (const [key, scope] of desired) {
      const existing = watches.get(key);
      if (existing) {
        existing.scope = scope;
        continue;
      }
      watches.set(key, {
        scope,
        attempts: 0,
        inFlight: false,
        timer: null,
      });
      trace("session-lifecycle-recovery:watch", {
        workspaceId: scope.workspaceId,
        conversationId: scope.conversationId,
        runId: scope.runId,
        sessionId: scope.sessionId,
      });
      scheduleWatch(key, initialDelayMs);
    }
  };

  return {
    reconcile,
    dispose() {
      for (const key of [...watches.keys()]) clearWatch(key);
    },
    activeWatchCount() {
      return watches.size;
    },
  };
}
