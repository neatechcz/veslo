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

export const beginOutageEpisode = (sessionStatusById: Record<string, string>): OutageEpisode => {
  const runningSessionIds = Object.entries(sessionStatusById)
    .filter(([, status]) => isRunningStatus(status))
    .map(([sessionID]) => sessionID);

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
