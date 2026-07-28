export type ReconnectNotice = "reconnecting" | "reconnected";

export type ReconnectStateStatus =
  | "live"
  | "reconnecting"
  | "catching-up"
  | "degraded"
  | "runtime-recovering";

export type ReconnectState = {
  status: ReconnectStateStatus;
  workspaceId: string | null;
  sessionId: string | null;
  attempt: number | null;
  delayMs: number | null;
  lastError: string | null;
  messagesMayBeDelayed: boolean;
  updatedAt: number;
};

export function createReconnectState(input: {
  status: ReconnectStateStatus;
  workspaceId?: string | null;
  sessionId?: string | null;
  attempt?: number | null;
  delayMs?: number | null;
  lastError?: string | null;
  messagesMayBeDelayed?: boolean;
  now?: () => number;
}): ReconnectState {
  return {
    status: input.status,
    workspaceId: input.workspaceId?.trim() || null,
    sessionId: input.sessionId?.trim() || null,
    attempt: input.attempt ?? null,
    delayMs: input.delayMs ?? null,
    lastError: input.lastError?.trim() || null,
    messagesMayBeDelayed: input.messagesMayBeDelayed ?? input.status !== "live",
    updatedAt: input.now?.() ?? Date.now(),
  };
}

export const reconnectStateBlocksSend = (_state: ReconnectState | null | undefined): boolean => false;

export function createReconnectRecoveryTracker() {
  const pendingWorkspaceKeys = new Set<string>();
  const workspaceKey = (workspaceId?: string | null) => workspaceId?.trim() || "__active__";

  return {
    observe(state: ReconnectState): boolean {
      const key = workspaceKey(state.workspaceId);
      if (state.status !== "live") {
        pendingWorkspaceKeys.add(key);
        return false;
      }
      return pendingWorkspaceKeys.delete(key);
    },
  };
}

export function shouldRecoverEventStreamRuntime(input: {
  recoveryAvailable: boolean;
  textMatchedRuntimeError: boolean;
  scopedRuntimeReady: boolean;
}): boolean {
  return input.recoveryAvailable && input.textMatchedRuntimeError && !input.scopedRuntimeReady;
}

export type OutageEpisode = {
  active: boolean;
  hadRunningSessions: boolean;
  shownReconnecting: boolean;
  shownReconnected: boolean;
  runningSessionIds: string[];
};

export const clearOutageEpisode = (): OutageEpisode => ({
  active: false,
  hadRunningSessions: false,
  shownReconnecting: false,
  shownReconnected: false,
  runningSessionIds: [],
});

export const isRunningStatus = (status: string | null | undefined): boolean => {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return normalized === "running" || normalized === "retry";
};

export const beginOutageEpisode = (
  sessionStatusById: Record<string, string>,
  workspaceId?: string | null,
): OutageEpisode => {
  const workspace = workspaceId?.trim() ?? "";
  const scopedPrefix = workspace ? `${workspace}\0` : "";
  const runningSessionIds = Object.entries(sessionStatusById)
    .filter(([sessionID, status]) => {
      if (!isRunningStatus(status)) return false;
      if (!scopedPrefix) return !sessionID.includes("\0");
      return sessionID.startsWith(scopedPrefix) && sessionID.length > scopedPrefix.length;
    })
    .map(([sessionID]) => (scopedPrefix ? sessionID.slice(scopedPrefix.length) : sessionID));

  return {
    active: true,
    hadRunningSessions: runningSessionIds.length > 0,
    shownReconnecting: false,
    shownReconnected: false,
    runningSessionIds,
  };
};

export const shouldShowReconnecting = (episode: OutageEpisode): boolean =>
  episode.active && episode.hadRunningSessions && !episode.shownReconnecting;

export const shouldShowReconnected = (episode: OutageEpisode): boolean =>
  episode.active && episode.hadRunningSessions && !episode.shownReconnected;
