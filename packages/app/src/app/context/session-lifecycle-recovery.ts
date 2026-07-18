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
  diagnosticTraceId?: string | null;
};

export type AcceptedConversationRunInput = SessionLifecycleRecoveryScope & {
  clientMessageId: string;
};

export type SessionRunRecoveryState =
  | "watching"
  | "exhausted"
  | "connection-unavailable"
  | "transcript-unavailable";

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
  recoveryState?: SessionRunRecoveryState;
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
  recoverAcceptedConversationRunStatus?: (
    scope: SessionLifecycleRecoveryScope,
  ) => Promise<SessionLifecycleRecoveryStatus | null>;
  isAcceptedRunVisible?: (scope: SessionLifecycleRecoveryScope) => boolean;
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
    diagnosticTraceId?: string | null;
  }) => Promise<VesloSessionTranscriptSnapshot | null>;
  recoverAcceptedConversationTranscript?: (
    scope: SessionLifecycleRecoveryScope,
  ) => Promise<VesloSessionTranscriptSnapshot | null>;
  currentSelectionVersion?: () => number;
  reserveTranscriptProjection?: (
    scope: SessionLifecycleRecoveryScope,
    selectionVersion: number,
  ) => void;
  publishTranscriptProjection?: (
    scope: SessionLifecycleRecoveryScope,
    snapshot: VesloSessionTranscriptSnapshot,
    selectionVersion: number,
  ) => boolean | void;
  hydrateConversationTranscript?: (snapshot: VesloSessionTranscriptSnapshot) => void;
  diagnosticContext?: () => {
    appWorkspaceId?: string | null;
    connectionSnapshot?: Record<string, string | null | undefined> | null;
  };
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
const DEFAULT_TERMINAL_TRANSCRIPT_RETRY_MS = 1_000;

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
  const terminalTranscriptRetryMs = DEFAULT_TERMINAL_TRANSCRIPT_RETRY_MS;
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
    generation: number;
    attempts: number;
    inFlight: boolean;
    timer: unknown | null;
    admitted: boolean;
    foregroundRecoveryAttemptedGeneration: number | null;
    lastStatus: SessionLifecycleRecoveryStatus | null;
  };

  type TerminalTranscriptRecovery = {
    scope: SessionLifecycleRecoveryScope;
    status: SessionLifecycleRecoveryStatus;
    generation: number;
    outcome: "pending" | "hydrated" | "unavailable" | "discarded";
    inFlight: boolean;
    automaticRetryUsed: boolean;
    retryTimer: unknown | null;
  };

  const watches = new Map<string, Watch>();
  const exhaustedWatches = new Map<string, Watch>();
  const latestProbeScopes = new Set<string>();
  const currentRunKeyByConversation = new Map<string, string>();
  const admittedRunKeys = new Set<string>();
  const settledRunKeys = new Set<string>();
  const terminalTranscriptRecoveries = new Map<string, TerminalTranscriptRecovery>();
  let disposed = false;

  const conversationKey = (scope: SessionLifecycleRecoveryScope) =>
    `${normalize(scope.workspaceId)}\0${normalize(scope.conversationId)}`;

  const trace = (event: string, payload?: Record<string, unknown>) => {
    options.trace?.(event, payload);
  };

  const traceForScope = (
    event: string,
    scope: SessionLifecycleRecoveryScope,
    generation: number,
    payload?: Record<string, unknown>,
  ) => {
    const context = options.diagnosticContext?.();
    trace(event, {
      ...(payload ?? {}),
      workspaceId: normalize(scope.workspaceId),
      conversationId: normalize(scope.conversationId),
      runId: normalize(scope.runId),
      sessionId: normalize(scope.sessionId),
      clientMessageId: normalize(scope.clientMessageId) || null,
      diagnosticTraceId: normalize(scope.diagnosticTraceId) || null,
      generation,
      appWorkspaceId: normalize(context?.appWorkspaceId) || null,
      connectionSnapshot: context?.connectionSnapshot ?? null,
    });
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

  const clearTerminalHydrationRecovery = (key: string) => {
    const recovery = terminalTranscriptRecoveries.get(key);
    const timer = recovery?.retryTimer;
    if (timer) clearTimer(timer);
    terminalTranscriptRecoveries.delete(key);
  };

  const isAcceptedRunVisible = (scope: SessionLifecycleRecoveryScope) => {
    if (options.isAcceptedRunVisible) return options.isAcceptedRunVisible(scope);
    const selectedSessionId = normalize(options.selectedSessionId());
    return Boolean(selectedSessionId && unique([
      scope.sessionId,
      scope.opencodeSessionId,
      scope.conversationId,
    ]).includes(selectedSessionId));
  };

  const publishConnectionUnavailable = (watch: Watch) => {
    const status: SessionLifecycleRecoveryStatus = {
      ...(watch.lastStatus ?? {
        runId: watch.scope.runId,
        status: "submitted",
        stale: false,
        clientMessageId: watch.scope.clientMessageId ?? null,
      }),
      recoveryState: "connection-unavailable",
    };
    watch.lastStatus = status;
    options.onConversationRunStatus?.(watch.scope, status);
    traceForScope("session-lifecycle-recovery:connection-unavailable", watch.scope, watch.generation, {
      outcome: "connection-unavailable",
    });
  };

  const publishTranscriptUnavailable = (recovery: TerminalTranscriptRecovery) => {
    const status: SessionLifecycleRecoveryStatus = {
      ...recovery.status,
      recoveryState: "transcript-unavailable",
    };
    recovery.outcome = "unavailable";
    options.onConversationRunStatus?.(recovery.scope, status);
    traceForScope("session-lifecycle-recovery:transcript-unavailable", recovery.scope, recovery.generation, {
      outcome: "transcript-unavailable",
    });
  };

  const clearReplacedConversationWatches = (scope: SessionLifecycleRecoveryScope, keepKey: string) => {
    const targetConversationKey = conversationKey(scope);
    for (const [key, watch] of [...watches, ...exhaustedWatches]) {
      if (key === keepKey || conversationKey(watch.scope) !== targetConversationKey) continue;
      if (watches.has(key)) clearWatch(key);
      exhaustedWatches.delete(key);
      admittedRunKeys.delete(key);
    }
    for (const [key, recovery] of terminalTranscriptRecoveries) {
      if (key === keepKey || conversationKey(recovery.scope) !== targetConversationKey) continue;
      clearTerminalHydrationRecovery(key);
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
    generation = 1,
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
    const terminalStatus: SessionLifecycleRecoveryStatus = {
      runId: scope.runId,
      status,
      stale: false,
      clientMessageId: scope.clientMessageId ?? null,
    };
    const scheduleTerminalTranscriptRetry = (outcome: "terminal-transcript-unavailable" | "terminal-transcript-error") => {
      if (!key) return;
      const recovery = terminalTranscriptRecoveries.get(key);
      if (!recovery) return;
      recovery.inFlight = false;
      if (recovery.automaticRetryUsed) {
        traceForScope("session-lifecycle-recovery:terminal-transcript-unavailable", scope, generation, {
          outcome: "terminal-transcript-retry-exhausted",
        });
        publishTranscriptUnavailable(recovery);
        return;
      }
      recovery.automaticRetryUsed = true;
      const timer = setTimer(() => {
        recovery.retryTimer = null;
        if (disposed || currentRunKeyByConversation.get(conversationKey(scope)) !== key) {
          return;
        }
        if (terminalTranscriptRecoveries.get(key) !== recovery || recovery.generation !== generation) {
          return;
        }
        traceForScope("session-lifecycle-recovery:terminal-transcript-retry", scope, generation, {
          outcome: "terminal-transcript-retry",
          previousOutcome: outcome,
        });
        recoverTerminalRun(scope, status, source, admitted, generation);
      }, terminalTranscriptRetryMs);
      recovery.retryTimer = timer;
      traceForScope("session-lifecycle-recovery:terminal-transcript-retry-scheduled", scope, generation, {
        outcome: "terminal-transcript-retry-scheduled",
        delayMs: terminalTranscriptRetryMs,
        previousOutcome: outcome,
      });
    };
    const shouldHydrate = transcriptSessionId && workspaceId && (admitted || source === "latest-probe" || !selectedRun);
    const useForegroundAcceptedTranscriptRecovery = admitted && isAcceptedRunVisible(scope);
    const recoverTranscript = useForegroundAcceptedTranscriptRecovery && options.recoverAcceptedConversationTranscript
      ? () => options.recoverAcceptedConversationTranscript!(scope)
      : options.recoverConversationTranscript
        ? () => options.recoverConversationTranscript!({
            workspaceId,
            sessionId: transcriptSessionId,
            directory: scope.directory,
            expectedRunId: scope.runId,
            ...(scope.diagnosticTraceId?.trim() ? { diagnosticTraceId: scope.diagnosticTraceId.trim() } : {}),
          })
        : null;
    if (shouldHydrate && key && recoverTranscript) {
      const selectionVersion = options.currentSelectionVersion?.() ?? 0;
      if (selectedRun) {
        options.reserveTranscriptProjection?.(scope, selectionVersion);
      }
      const existingRecovery = terminalTranscriptRecoveries.get(key);
      const recovery = existingRecovery?.generation === generation
        ? existingRecovery
        : {
            scope,
            status: terminalStatus,
            generation,
            outcome: "pending" as const,
            inFlight: false,
            automaticRetryUsed: false,
            retryTimer: null,
          };
      recovery.scope = scope;
      recovery.status = terminalStatus;
      terminalTranscriptRecoveries.set(key, recovery);
      if (
        !recovery.inFlight &&
        !recovery.retryTimer &&
        recovery.outcome !== "hydrated" &&
        recovery.outcome !== "discarded"
      ) {
        recovery.inFlight = true;
        void recoverTranscript().then((snapshot) => {
          const currentRecovery = terminalTranscriptRecoveries.get(key);
          if (
            disposed ||
            currentRunKeyByConversation.get(conversationKey(scope)) !== key ||
            currentRecovery !== recovery ||
            recovery.generation !== generation
          ) {
            recovery.inFlight = false;
            return;
          }
          if (!snapshot) {
            latestProbeScopes.delete(conversationKey(scope));
            traceForScope("session-lifecycle-recovery:terminal-transcript-unavailable", scope, generation, {
              transcriptSessionId,
              outcome: "terminal-transcript-unavailable",
            });
            scheduleTerminalTranscriptRetry("terminal-transcript-unavailable");
            return;
          }
          const projectionPublished = options.publishTranscriptProjection?.(scope, snapshot, selectionVersion);
          const selectedRunStillVisible = isAcceptedRunVisible(scope);
          const selectionStillOwnsSnapshot =
            selectedRun &&
            selectedRunStillVisible &&
            (options.currentSelectionVersion?.() ?? selectionVersion) === selectionVersion;
          const shouldHydrateSnapshot =
            (!selectedRun && !selectedRunStillVisible) ||
            (selectionStillOwnsSnapshot && projectionPublished !== false);
          if (shouldHydrateSnapshot) {
            options.hydrateConversationTranscript?.(retargetSnapshotForUiSession(snapshot, scope.sessionId));
          } else {
            recovery.inFlight = false;
            recovery.outcome = "discarded";
            traceForScope("session-lifecycle-recovery:terminal-transcript-discarded", scope, generation, {
              outcome: "terminal-transcript-discarded",
              reason: selectionStillOwnsSnapshot ? "projection-rejected" : "selection-changed",
            });
            return;
          }
          recovery.inFlight = false;
          recovery.outcome = "hydrated";
          traceForScope("session-lifecycle-recovery:terminal-transcript-hydrated", scope, generation, {
            outcome: "terminal-transcript-hydrated",
          });
        }).catch((error) => {
          const currentRecovery = terminalTranscriptRecoveries.get(key);
          if (
            disposed ||
            currentRunKeyByConversation.get(conversationKey(scope)) !== key ||
            currentRecovery !== recovery ||
            recovery.generation !== generation
          ) {
            recovery.inFlight = false;
            return;
          }
          latestProbeScopes.delete(conversationKey(scope));
          traceForScope("session-lifecycle-recovery:terminal-transcript-error", scope, generation, {
            transcriptSessionId,
            outcome: "terminal-transcript-error",
            errorType: error instanceof Error ? error.name : "unknown",
          });
          scheduleTerminalTranscriptRetry("terminal-transcript-error");
        });
      }
    }

    traceForScope("session-lifecycle-recovery:terminal", scope, generation, {
      status,
      source,
      sessionIds,
    });
  };

  const retainQueuedRun = (scope: SessionLifecycleRecoveryScope, generation = 1) => {
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
    traceForScope("session-lifecycle-recovery:queued", scope, generation, {
      sessionIds,
    });
  };

  const recoverAcceptedWatch = async (
    key: string,
    watch: Watch,
    reason: "status-unavailable" | "status-http-error",
  ) => {
    const canRecover = watch.admitted && Boolean(options.recoverAcceptedConversationRunStatus);
    if (!canRecover) return;
    if (!isAcceptedRunVisible(watch.scope)) {
      traceForScope("session-lifecycle-recovery:foreground-recovery-declined", watch.scope, watch.generation, {
        outcome: "foreground-recovery-declined-not-visible",
        reason,
      });
      options.onConversationRunStatus?.(watch.scope, null);
      return;
    }
    if (watch.foregroundRecoveryAttemptedGeneration === watch.generation) {
      if (watch.lastStatus?.recoveryState !== "connection-unavailable") {
        options.onConversationRunStatus?.(watch.scope, null);
      }
      return;
    }

    watch.foregroundRecoveryAttemptedGeneration = watch.generation;
    traceForScope("session-lifecycle-recovery:server-only-ensure-started", watch.scope, watch.generation, {
      outcome: "server-only-ensure-started",
      reason,
    });
    const recoveryGeneration = watch.generation;
    let recoveredStatus: SessionLifecycleRecoveryStatus | null = null;
    try {
      recoveredStatus = await options.recoverAcceptedConversationRunStatus!(watch.scope);
    } catch (error) {
      traceForScope("session-lifecycle-recovery:server-only-ensure-error", watch.scope, watch.generation, {
        outcome: "server-only-ensure-error",
        reason,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
    if (watches.get(key) !== watch || watch.generation !== recoveryGeneration) {
      traceForScope("session-lifecycle-recovery:superseded-foreground-recovery", watch.scope, watch.generation, {
        outcome: "superseded-foreground-recovery",
        reason,
      });
      return;
    }
    if (!isAcceptedRunVisible(watch.scope)) {
      traceForScope("session-lifecycle-recovery:foreground-recovery-declined", watch.scope, watch.generation, {
        outcome: "foreground-recovery-declined-not-visible",
        reason,
      });
      return;
    }
    if (!recoveredStatus) {
      traceForScope("session-lifecycle-recovery:server-only-ensure-failed", watch.scope, watch.generation, {
        outcome: "server-only-ensure-failed",
        reason,
      });
      publishConnectionUnavailable(watch);
      return;
    }

    const recoveredTerminal = recoveredStatus.stale !== true &&
      TERMINAL_LIFECYCLE_STATUSES.has(recoveredStatus.status);
    traceForScope("session-lifecycle-recovery:foreground-recovery-status", watch.scope, watch.generation, {
      outcome: "foreground-recovery-status",
      reason,
      status: recoveredStatus.status,
      stale: recoveredStatus.stale,
    });
    watch.lastStatus = { ...recoveredStatus, recoveryState: "watching" };
    options.onConversationRunStatus?.(watch.scope, watch.lastStatus);
    if (recoveredStatus.status === "queued") retainQueuedRun(watch.scope, watch.generation);
    if (recoveredTerminal) {
      settledRunKeys.add(key);
      options.onConversationRunTerminal?.(watch.scope, recoveredStatus);
      recoverTerminalRun(
        watch.scope,
        recoveredStatus.status,
        "watch",
        watch.admitted,
        watch.generation,
      );
      clearWatch(key, { clearDiagnostic: false });
    }
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
        traceForScope("session-lifecycle-recovery:superseded-poll", watch.scope, watch.generation, {
          attempt: watch.attempts,
          durationMs: Date.now() - pollStartedAt,
        });
        return;
      }
      traceForScope("session-lifecycle-recovery:poll", watch.scope, watch.generation, {
        status: status?.status ?? null,
        stale: status?.stale ?? null,
        waitReason: status?.waitReason ?? null,
        noProgressSeconds: status?.noProgressSeconds ?? null,
        attempt: watch.attempts,
        durationMs: Date.now() - pollStartedAt,
      });
      const terminal = Boolean(status && status.stale !== true && TERMINAL_LIFECYCLE_STATUSES.has(status.status));
      if (!status) {
        traceForScope("session-lifecycle-recovery:status-unavailable", watch.scope, watch.generation, {
          outcome: "status-unavailable",
        });
        if (watch.admitted) {
          await recoverAcceptedWatch(key, watch, "status-unavailable");
        } else {
          options.onConversationRunStatus?.(watch.scope, null);
        }
      } else {
        watch.lastStatus = watch.admitted ? { ...status, recoveryState: "watching" } : status;
        options.onConversationRunStatus?.(watch.scope, watch.lastStatus);
        if (status.status === "queued") retainQueuedRun(watch.scope, watch.generation);
      }
      if (terminal && status) {
        settledRunKeys.add(key);
        options.onConversationRunTerminal?.(watch.scope, status);
        recoverTerminalRun(watch.scope, status.status, "watch", watch.admitted, watch.generation);
        clearWatch(key, { clearDiagnostic: false });
        return;
      }
    } catch (error) {
      traceForScope("session-lifecycle-recovery:error", watch.scope, watch.generation, {
        attempt: watch.attempts,
        outcome: "status-http-error",
        errorType: error instanceof Error ? error.name : "unknown",
      });
      await recoverAcceptedWatch(key, watch, "status-http-error");
    } finally {
      const current = watches.get(key);
      if (current) current.inFlight = false;
    }

    const current = watches.get(key);
    if (!current) return;
    if (current.attempts >= maxAttempts) {
      traceForScope("session-lifecycle-recovery:exhausted", current.scope, current.generation, {
        attempts: current.attempts,
        outcome: "retry-exhausted",
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
        // An accepted run owns the exact submit scope for its whole lifetime.
        // Status aliases (OpenCode session id vs. durable conversation id) can
        // resolve to the same key here, but must never retarget recovery or
        // break its trace correlation.
        continue;
      }
      watches.set(key, {
        scope,
        generation: 1,
        attempts: 0,
        inFlight: false,
        timer: null,
        admitted: admittedRunKeys.has(key),
        foregroundRecoveryAttemptedGeneration: null,
        lastStatus: null,
      });
      clearReplacedConversationWatches(scope, key);
      traceForScope("session-lifecycle-recovery:watch", scope, 1, {
        outcome: "watch-started",
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
        recoverTerminalRun(resolvedScope, status.status, "latest-probe", false, 1);
        return true;
      }
      const key = recoveryKey(resolvedScope);
      if (key && !watches.has(key)) {
        watches.set(key, {
          scope: resolvedScope,
          generation: 1,
          attempts: 0,
          inFlight: false,
          timer: null,
          admitted: false,
          foregroundRecoveryAttemptedGeneration: null,
          lastStatus: status,
        });
        clearReplacedConversationWatches(resolvedScope, key);
        scheduleWatch(key, pollMs);
      }
      return true;
    } catch (error) {
      latestProbeScopes.delete(scopeKey);
      traceForScope("session-lifecycle-recovery:latest-probe-error", scope, 1, {
        outcome: "latest-probe-http-error",
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return true;
    }
  };

  const restartAcceptedWatch = (
    watch: Watch,
    event: "foreground-recovery-retry" | "foreground-recovery-reconnect",
  ) => {
    watch.generation += 1;
    watch.foregroundRecoveryAttemptedGeneration = null;
    watch.attempts = 0;
    if (watch.lastStatus) {
      watch.lastStatus = { ...watch.lastStatus, recoveryState: "watching" };
      options.onConversationRunStatus?.(watch.scope, watch.lastStatus);
    }
    traceForScope(`session-lifecycle-recovery:${event}`, watch.scope, watch.generation, {
      outcome: event,
    });
    void pollWatch(recoveryKey(watch.scope), true);
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
        diagnosticTraceId: normalize(input.diagnosticTraceId) || null,
      };
      const key = recoveryKey(scope);
      if (!key || !scope.sessionId || !scope.clientMessageId) return false;
      clearReplacedConversationWatches(scope, key);
      if (settledRunKeys.has(key)) return true;

      const existingWatch = watches.get(key) ?? exhaustedWatches.get(key);
      if (existingWatch) {
        const wasExhausted = exhaustedWatches.delete(key);
        if (wasExhausted) {
          existingWatch.attempts = 0;
          existingWatch.inFlight = false;
          existingWatch.timer = null;
          watches.set(key, existingWatch);
        }
        const previousStatus = existingWatch.lastStatus;
        const admittedStatus: SessionLifecycleRecoveryStatus = previousStatus
          ? {
              ...previousStatus,
              clientMessageId: scope.clientMessageId,
              recoveryState: "watching",
            }
          : {
              runId: scope.runId,
              status: "submitted",
              stale: false,
              clientMessageId: scope.clientMessageId,
              recoveryState: "watching",
            };
        existingWatch.scope = scope;
        existingWatch.admitted = true;
        existingWatch.foregroundRecoveryAttemptedGeneration = null;
        existingWatch.lastStatus = admittedStatus;
        admittedRunKeys.add(key);
        const workspaceId = normalize(scope.workspaceId);
        for (const sessionId of unique([scope.sessionId, scope.opencodeSessionId, scope.conversationId])) {
          options.setSessionStatusForWorkspace(sessionId, admittedStatus.status, workspaceId);
          options.notifySessionBusy(sessionId, admittedStatus.status, workspaceId);
        }
        options.onConversationRunStatus?.(scope, admittedStatus);
        traceForScope("session-lifecycle-recovery:admitted", scope, existingWatch.generation, {
          outcome: "accepted-run-promoted-existing-watch",
          previousStatus: previousStatus?.status ?? null,
          wasExhausted,
        });
        void pollWatch(key, true);
        return true;
      }

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
        generation: 1,
        attempts: 0,
        inFlight: false,
        timer: null,
        admitted: true,
        foregroundRecoveryAttemptedGeneration: null,
        lastStatus: submittedStatus,
      });
      const workspaceId = normalize(scope.workspaceId);
      for (const sessionId of unique([scope.sessionId, scope.opencodeSessionId, scope.conversationId])) {
        options.setSessionStatusForWorkspace(sessionId, "submitted", workspaceId);
        options.notifySessionBusy(sessionId, "submitted", workspaceId);
      }
      options.onConversationRunStatus?.(scope, submittedStatus);
      traceForScope("session-lifecycle-recovery:admitted", scope, 1, {
        outcome: "accepted-run-admitted",
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
          generation: 1,
          attempts: 0,
          inFlight: false,
          timer: null,
          admitted: admittedRunKeys.has(key),
          foregroundRecoveryAttemptedGeneration: null,
          lastStatus: null,
        });
        clearReplacedConversationWatches(scope, key);
        traceForScope("session-lifecycle-recovery:watch", scope, 1, {
          source: eventType ?? "observation",
          outcome: "watch-started",
        });
      }
      traceForScope("session-lifecycle-recovery:observation", scope, watches.get(key)?.generation ?? 1, {
        eventType: eventType ?? null,
        outcome: "lifecycle-observed",
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
    retryAcceptedRunForSession(sessionId: string, workspaceId?: string | null) {
      const targetSessionId = normalize(sessionId);
      const targetWorkspaceId = normalize(workspaceId);
      if (!targetSessionId) return 0;
      let resumed = 0;
      for (const [, watch] of watches) {
        if (!watch.admitted) continue;
        if (targetWorkspaceId && normalize(watch.scope.workspaceId) !== targetWorkspaceId) continue;
        const aliases = unique([
          watch.scope.sessionId,
          watch.scope.opencodeSessionId,
          watch.scope.conversationId,
        ]);
        if (!aliases.includes(targetSessionId)) continue;
        restartAcceptedWatch(watch, "foreground-recovery-retry");
        resumed += 1;
      }
      return resumed;
    },
    resumeAcceptedRunsForWorkspace(workspaceId?: string | null) {
      const targetWorkspaceId = normalize(workspaceId);
      let resumed = 0;
      for (const watch of watches.values()) {
        if (!watch.admitted) continue;
        if (targetWorkspaceId && normalize(watch.scope.workspaceId) !== targetWorkspaceId) continue;
        restartAcceptedWatch(watch, "foreground-recovery-reconnect");
        resumed += 1;
      }
      return resumed;
    },
    retryTerminalTranscriptRecoveryForSession(sessionId: string, workspaceId?: string | null) {
      const targetSessionId = normalize(sessionId);
      const targetWorkspaceId = normalize(workspaceId);
      if (!targetSessionId) return 0;
      let resumed = 0;
      for (const [key, recovery] of terminalTranscriptRecoveries) {
        if (recovery.outcome !== "unavailable") continue;
        if (targetWorkspaceId && normalize(recovery.scope.workspaceId) !== targetWorkspaceId) continue;
        const aliases = unique([
          recovery.scope.sessionId,
          recovery.scope.opencodeSessionId,
          recovery.scope.conversationId,
        ]);
        if (!aliases.includes(targetSessionId)) continue;
        if (currentRunKeyByConversation.get(conversationKey(recovery.scope)) !== key) continue;
        if (recovery.retryTimer) clearTimer(recovery.retryTimer);
        recovery.retryTimer = null;
        recovery.inFlight = false;
        const nextGeneration = recovery.generation + 1;
        traceForScope("session-lifecycle-recovery:terminal-transcript-retry", recovery.scope, nextGeneration, {
          outcome: "terminal-transcript-explicit-retry",
        });
        recoverTerminalRun(
          recovery.scope,
          recovery.status.status,
          "watch",
          admittedRunKeys.has(key),
          nextGeneration,
        );
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
      for (const key of [...terminalTranscriptRecoveries.keys()]) clearTerminalHydrationRecovery(key);
    },
    activeWatchCount() {
      return watches.size;
    },
  };
}
