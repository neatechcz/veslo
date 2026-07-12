import type {
  VesloConversationRunActivityKind,
  VesloConversationRunLifecycleStatus,
  VesloConversationRunWaitReason,
  VesloSessionTranscriptSnapshot,
} from "../lib/veslo-server";

export type SessionLifecycleRecoveryScope = {
  sessionId: string;
  workspaceId: string;
  conversationId: string;
  opencodeSessionId?: string | null;
  directory?: string | null;
  runId: string;
  clientMessageId?: string | null;
};

export type AcceptedConversationRunInput = SessionLifecycleRecoveryScope & {
  clientMessageId: string;
};

export type SessionLifecycleRecoveryStatus = {
  runId?: string | null;
  status: VesloConversationRunLifecycleStatus;
  stale: boolean;
  error?: string | null;
  clientMessageId?: string | null;
  activityKind?: VesloConversationRunActivityKind | null;
  waitReason?: VesloConversationRunWaitReason | null;
  lastUsefulProgressAt?: number | null;
  retrySince?: number | null;
  noProgressSeconds?: number | null;
  recoveryState?: "watching" | "exhausted";
};

export type SessionRunDiagnostic = SessionLifecycleRecoveryStatus & {
  sessionId: string;
  workspaceId: string;
  conversationId: string;
  opencodeSessionId?: string | null;
};

export type SessionLifecycleRecoveryControllerOptions = {
  sessionStatusById: () => Record<string, string>;
  selectedSessionId: () => string | null;
  resolveConversationRunForSession: (
    sessionId: string,
    workspaceIdHint?: string | null,
    options?: { allowLatest?: boolean },
  ) => SessionLifecycleRecoveryScope | null;
  readConversationRunStatus: (
    scope: SessionLifecycleRecoveryScope,
  ) => Promise<SessionLifecycleRecoveryStatus | null>;
  onConversationRunStatus?: (
    scope: SessionLifecycleRecoveryScope,
    status: SessionLifecycleRecoveryStatus | null,
  ) => void;
  onConversationRunTerminal?: (
    scope: SessionLifecycleRecoveryScope,
    status: SessionLifecycleRecoveryStatus,
  ) => void;
  setSessionStatusForWorkspace: (
    sessionId: string | null | undefined,
    status: string,
    workspaceId?: string | null,
  ) => void;
  notifySessionBusy: (sessionId: string, status: string, workspaceId?: string) => void;
  recoverConversationTranscript?: (scope: {
    workspaceId: string;
    sessionId: string;
    directory?: string | null;
    expectedRunId?: string | null;
  }) => Promise<VesloSessionTranscriptSnapshot | null>;
  hydrateConversationTranscript?: (snapshot: VesloSessionTranscriptSnapshot) => void;
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

const retargetSnapshotForUiSession = (
  snapshot: VesloSessionTranscriptSnapshot,
  sessionId: string,
): VesloSessionTranscriptSnapshot => {
  const targetSessionId = normalize(sessionId);
  const snapshotSessionId = normalize(snapshot.sessionId);
  if (!targetSessionId || !snapshotSessionId || targetSessionId === snapshotSessionId) return snapshot;
  return {
    ...snapshot,
    sessionId: targetSessionId,
    opencodeSessionId: snapshot.opencodeSessionId?.trim() || snapshotSessionId,
  };
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
    admitted: boolean;
    lastStatus: SessionLifecycleRecoveryStatus | null;
  };

  const watches = new Map<string, Watch>();
  const exhaustedWatches = new Map<string, Watch>();
  const latestProbeScopes = new Set<string>();
  const currentRunKeyByConversation = new Map<string, string>();
  const admittedRunKeys = new Set<string>();
  const settledRunKeys = new Set<string>();
  const terminalHydrations = new Set<string>();
  let disposed = false;

  const conversationKey = (scope: SessionLifecycleRecoveryScope) =>
    `${normalize(scope.workspaceId)}\0${normalize(scope.conversationId)}`;

  const trace = (event: string, payload?: Record<string, unknown>) => {
    options.trace?.(event, payload);
  };

  const clearWatch = (key: string, clearOptions: { clearDiagnostic?: boolean } = {}) => {
    const watch = watches.get(key);
    if (!watch) return;
    if (watch.timer) clearTimer(watch.timer);
    watches.delete(key);
    if (clearOptions.clearDiagnostic !== false) {
      options.onConversationRunStatus?.(watch.scope, null);
    }
  };

  const clearReplacedConversationWatches = (scope: SessionLifecycleRecoveryScope, keepKey: string) => {
    const targetConversationKey = conversationKey(scope);
    for (const [key, watch] of [...watches, ...exhaustedWatches]) {
      if (key === keepKey || conversationKey(watch.scope) !== targetConversationKey) continue;
      if (watches.has(key)) clearWatch(key);
      exhaustedWatches.delete(key);
      admittedRunKeys.delete(key);
    }
    currentRunKeyByConversation.set(targetConversationKey, keepKey);
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
    source: "watch" | "latest-probe",
    admitted = false,
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
    const selectedRun = Boolean(selectedSessionId && sessionIds.includes(selectedSessionId));
    const transcriptSessionId = normalize(scope.opencodeSessionId) || normalize(scope.sessionId);
    const key = recoveryKey(scope);
    const shouldHydrate = transcriptSessionId && workspaceId && (admitted || source === "latest-probe" || !selectedRun);
    if (shouldHydrate && key && options.recoverConversationTranscript && !terminalHydrations.has(key)) {
      terminalHydrations.add(key);
      void options.recoverConversationTranscript({
        workspaceId,
        sessionId: transcriptSessionId,
        directory: scope.directory,
        expectedRunId: scope.runId,
      }).then((snapshot) => {
        if (disposed) {
          terminalHydrations.delete(key);
          return;
        }
        if (!snapshot) {
          terminalHydrations.delete(key);
          latestProbeScopes.delete(conversationKey(scope));
          trace("session-lifecycle-recovery:terminal-transcript-unavailable", {
            workspaceId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            sessionId: transcriptSessionId,
          });
          return;
        }
        if (currentRunKeyByConversation.get(conversationKey(scope)) !== key) return;
        options.hydrateConversationTranscript?.(retargetSnapshotForUiSession(snapshot, scope.sessionId));
      }).catch((error) => {
        terminalHydrations.delete(key);
        latestProbeScopes.delete(conversationKey(scope));
        trace("session-lifecycle-recovery:terminal-transcript-error", {
          workspaceId,
          conversationId: scope.conversationId,
          runId: scope.runId,
          sessionId: transcriptSessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    trace("session-lifecycle-recovery:terminal", {
      workspaceId,
      conversationId: scope.conversationId,
      runId: scope.runId,
      status,
      source,
      sessionIds,
    });
  };

  const retainQueuedRun = (scope: SessionLifecycleRecoveryScope) => {
    const workspaceId = normalize(scope.workspaceId);
    const sessionIds = unique([
      scope.sessionId,
      scope.opencodeSessionId,
      scope.conversationId,
    ]);
    for (const sessionId of sessionIds) {
      options.setSessionStatusForWorkspace(sessionId, "submitted", workspaceId);
      options.notifySessionBusy(sessionId, "submitted", workspaceId);
    }
    trace("session-lifecycle-recovery:queued", {
      workspaceId,
      conversationId: scope.conversationId,
      runId: scope.runId,
      sessionIds,
    });
  };

  async function pollWatch(key: string, immediate = false): Promise<void> {
    const watch = watches.get(key);
    if (!watch) return;
    if (immediate && watch.timer) {
      clearTimer(watch.timer);
      watch.timer = null;
    }
    if (watch.inFlight) {
      return;
    }
    watch.inFlight = true;
    watch.attempts += 1;
    const pollStartedAt = Date.now();
    try {
      const status = await options.readConversationRunStatus(watch.scope);
      if (watches.get(key) !== watch) {
        trace("session-lifecycle-recovery:superseded-poll", {
          workspaceId: watch.scope.workspaceId,
          conversationId: watch.scope.conversationId,
          runId: watch.scope.runId,
          attempt: watch.attempts,
          durationMs: Date.now() - pollStartedAt,
        });
        return;
      }
      trace("session-lifecycle-recovery:poll", {
        workspaceId: watch.scope.workspaceId,
        conversationId: watch.scope.conversationId,
        runId: watch.scope.runId,
        status: status?.status ?? null,
        stale: status?.stale ?? null,
        waitReason: status?.waitReason ?? null,
        noProgressSeconds: status?.noProgressSeconds ?? null,
        attempt: watch.attempts,
        durationMs: Date.now() - pollStartedAt,
      });
      const terminal = Boolean(status && status.stale !== true && TERMINAL_LIFECYCLE_STATUSES.has(status.status));
      if (!status) {
        options.onConversationRunStatus?.(watch.scope, null);
      } else {
        watch.lastStatus = watch.admitted ? { ...status, recoveryState: "watching" } : status;
        options.onConversationRunStatus?.(watch.scope, watch.lastStatus);
        if (status.status === "queued") retainQueuedRun(watch.scope);
      }
      if (terminal && status) {
        settledRunKeys.add(key);
        options.onConversationRunTerminal?.(watch.scope, status);
        recoverTerminalRun(watch.scope, status.status, "watch", watch.admitted);
        clearWatch(key, { clearDiagnostic: false });
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
      if (current.timer) clearTimer(current.timer);
      current.timer = null;
      watches.delete(key);
      const exhaustedStatus: SessionLifecycleRecoveryStatus = {
        ...(current.lastStatus ?? {
          runId: current.scope.runId,
          status: "submitted",
          stale: false,
          clientMessageId: current.scope.clientMessageId ?? null,
        }),
        recoveryState: "exhausted",
      };
      current.lastStatus = exhaustedStatus;
      exhaustedWatches.set(key, current);
      options.onConversationRunStatus?.(current.scope, exhaustedStatus);
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

    for (const [key, watch] of watches) {
      const replacement = [...desired.values()].some((next) =>
        next.workspaceId === watch.scope.workspaceId &&
        next.conversationId === watch.scope.conversationId &&
        next.runId !== watch.scope.runId
      );
      if (replacement) clearWatch(key);
    }

    for (const [key, scope] of desired) {
      const existing = watches.get(key);
      if (existing) {
        existing.scope = {
          ...scope,
          clientMessageId: scope.clientMessageId ?? existing.scope.clientMessageId,
        };
        continue;
      }
      watches.set(key, {
        scope,
        attempts: 0,
        inFlight: false,
        timer: null,
        admitted: admittedRunKeys.has(key),
        lastStatus: null,
      });
      clearReplacedConversationWatches(scope, key);
      trace("session-lifecycle-recovery:watch", {
        workspaceId: scope.workspaceId,
        conversationId: scope.conversationId,
        runId: scope.runId,
        sessionId: scope.sessionId,
      });
      scheduleWatch(key, initialDelayMs);
    }
  };

  const probeSelectedConversationLatestRun = async (): Promise<boolean> => {
    const sessionId = normalize(options.selectedSessionId());
    if (!sessionId) return false;
    const scope = options.resolveConversationRunForSession(sessionId, null, { allowLatest: true });
    if (!scope || scope.runId !== "latest") return false;
    const scopeKey = `${normalize(scope.workspaceId)}\0${normalize(scope.conversationId)}`;
    if (!scopeKey || latestProbeScopes.has(scopeKey)) return false;
    latestProbeScopes.add(scopeKey);
    try {
      const status = await options.readConversationRunStatus(scope);
      if (!status) {
        latestProbeScopes.delete(scopeKey);
        return true;
      }
      const runId = normalize(status.runId);
      if (!runId) return true;
      const resolvedScope = { ...scope, runId };
      currentRunKeyByConversation.set(conversationKey(resolvedScope), recoveryKey(resolvedScope));
      const terminal = status.stale !== true && TERMINAL_LIFECYCLE_STATUSES.has(status.status);
      options.onConversationRunStatus?.(resolvedScope, status);
      if (terminal) {
        options.onConversationRunTerminal?.(resolvedScope, status);
        recoverTerminalRun(resolvedScope, status.status, "latest-probe");
        return true;
      }
      const key = recoveryKey(resolvedScope);
      if (key && !watches.has(key)) {
        watches.set(key, {
          scope: resolvedScope,
          attempts: 0,
          inFlight: false,
          timer: null,
          admitted: false,
          lastStatus: status,
        });
        clearReplacedConversationWatches(resolvedScope, key);
        scheduleWatch(key, pollMs);
      }
      return true;
    } catch (error) {
      latestProbeScopes.delete(scopeKey);
      trace("session-lifecycle-recovery:latest-probe-error", {
        workspaceId: scope.workspaceId,
        conversationId: scope.conversationId,
        sessionId: scope.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  };

  return {
    admitAcceptedConversationRun(input: AcceptedConversationRunInput) {
      const scope: SessionLifecycleRecoveryScope = {
        ...input,
        sessionId: normalize(input.sessionId),
        workspaceId: normalize(input.workspaceId),
        conversationId: normalize(input.conversationId),
        opencodeSessionId: normalize(input.opencodeSessionId) || null,
        directory: normalize(input.directory) || null,
        runId: normalize(input.runId),
        clientMessageId: normalize(input.clientMessageId),
      };
      const key = recoveryKey(scope);
      if (!key || !scope.sessionId || !scope.clientMessageId) return false;
      if (watches.has(key) || exhaustedWatches.has(key) || settledRunKeys.has(key)) return true;
      clearReplacedConversationWatches(scope, key);
      admittedRunKeys.add(key);

      const submittedStatus: SessionLifecycleRecoveryStatus = {
        runId: scope.runId,
        status: "submitted",
        stale: false,
        clientMessageId: scope.clientMessageId,
        recoveryState: "watching",
      };
      watches.set(key, {
        scope,
        attempts: 0,
        inFlight: false,
        timer: null,
        admitted: true,
        lastStatus: submittedStatus,
      });
      const workspaceId = normalize(scope.workspaceId);
      for (const sessionId of unique([scope.sessionId, scope.opencodeSessionId, scope.conversationId])) {
        options.setSessionStatusForWorkspace(sessionId, "submitted", workspaceId);
        options.notifySessionBusy(sessionId, "submitted", workspaceId);
      }
      options.onConversationRunStatus?.(scope, submittedStatus);
      trace("session-lifecycle-recovery:admitted", {
        workspaceId: scope.workspaceId,
        conversationId: scope.conversationId,
        runId: scope.runId,
        sessionId: scope.sessionId,
      });
      void pollWatch(key, true);
      return true;
    },
    reconcile,
    probeSelectedConversationLatestRun,
    observeSessionLifecycleEvent(
      sessionId: string,
      workspaceId?: string | null,
      eventType?: "session.idle" | "session.error",
    ) {
      const scope = options.resolveConversationRunForSession(sessionId, workspaceId);
      const key = scope ? recoveryKey(scope) : "";
      if (!scope || !key) return false;
      const exhausted = exhaustedWatches.get(key);
      if (exhausted) {
        exhaustedWatches.delete(key);
        exhausted.attempts = 0;
        exhausted.inFlight = false;
        exhausted.timer = null;
        if (exhausted.lastStatus) {
          exhausted.lastStatus = { ...exhausted.lastStatus, recoveryState: "watching" };
          options.onConversationRunStatus?.(exhausted.scope, exhausted.lastStatus);
        }
        watches.set(key, exhausted);
      }
      if (!watches.has(key)) {
        watches.set(key, {
          scope,
          attempts: 0,
          inFlight: false,
          timer: null,
          admitted: admittedRunKeys.has(key),
          lastStatus: null,
        });
        clearReplacedConversationWatches(scope, key);
        trace("session-lifecycle-recovery:watch", {
          workspaceId: scope.workspaceId,
          conversationId: scope.conversationId,
          runId: scope.runId,
          sessionId: scope.sessionId,
          source: eventType ?? "observation",
        });
      }
      trace("session-lifecycle-recovery:observation", {
        workspaceId: scope.workspaceId,
        conversationId: scope.conversationId,
        runId: scope.runId,
        sessionId: scope.sessionId,
        eventType: eventType ?? null,
      });
      void pollWatch(key, true);
      return true;
    },
    resumeExhaustedWatches(workspaceId?: string | null) {
      const targetWorkspaceId = normalize(workspaceId);
      let resumed = 0;
      for (const [key, watch] of [...exhaustedWatches]) {
        if (targetWorkspaceId && normalize(watch.scope.workspaceId) !== targetWorkspaceId) continue;
        exhaustedWatches.delete(key);
        watch.attempts = 0;
        watch.inFlight = false;
        watch.timer = null;
        if (watch.lastStatus) watch.lastStatus = { ...watch.lastStatus, recoveryState: "watching" };
        watches.set(key, watch);
        if (watch.lastStatus) options.onConversationRunStatus?.(watch.scope, watch.lastStatus);
        void pollWatch(key, true);
        resumed += 1;
      }
      return resumed;
    },
    resumeExhaustedWatchForSession(sessionId: string, workspaceId?: string | null) {
      const targetSessionId = normalize(sessionId);
      const targetWorkspaceId = normalize(workspaceId);
      if (!targetSessionId) return 0;
      let resumed = 0;
      for (const [key, watch] of [...exhaustedWatches]) {
        if (targetWorkspaceId && normalize(watch.scope.workspaceId) !== targetWorkspaceId) continue;
        const aliases = unique([
          watch.scope.sessionId,
          watch.scope.opencodeSessionId,
          watch.scope.conversationId,
        ]);
        if (!aliases.includes(targetSessionId)) continue;
        exhaustedWatches.delete(key);
        watch.attempts = 0;
        watch.inFlight = false;
        watch.timer = null;
        if (watch.lastStatus) watch.lastStatus = { ...watch.lastStatus, recoveryState: "watching" };
        watches.set(key, watch);
        if (watch.lastStatus) options.onConversationRunStatus?.(watch.scope, watch.lastStatus);
        void pollWatch(key, true);
        resumed += 1;
      }
      return resumed;
    },
    dispose() {
      disposed = true;
      for (const key of [...watches.keys()]) clearWatch(key);
      exhaustedWatches.clear();
      admittedRunKeys.clear();
      settledRunKeys.clear();
    },
    activeWatchCount() {
      return watches.size;
    },
  };
}
