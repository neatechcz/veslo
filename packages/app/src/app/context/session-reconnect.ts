export type ReconnectNotice = "reconnecting" | "reconnected";

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
