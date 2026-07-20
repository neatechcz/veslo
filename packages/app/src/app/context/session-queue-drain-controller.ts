import { createEffect, on } from "solid-js";

export type SessionQueueDrainControllerOptions = {
  selectedSessionId: () => string | null | undefined;
  sessionStatus: () => string;
  sessionStatusById: () => Record<string, string>;
  pendingSessionQueueKey: () => string;
  pendingQueueKeyAwaitingSessionIdByBaseKey: () => Record<string, string>;
  sessionQueueKeyForSessionId: (sessionId: string | null | undefined) => string;
  preserveRunStateOnSessionSwitch: (sessionKey: string) => void;
  setSearchQuery: (value: string) => void;
  closeSearch: () => void;
  markSelectedSessionForInitialAnchor: (sessionId: string) => void;
  markTempRuntimeUiRenderSource: (
    source: string,
    reason: string,
    extras?: { detail?: string },
  ) => void;
  handleSelectedSessionChanged: (input: {
    sessionId: string | null | undefined;
    previousSessionId: string | null | undefined;
    pendingBaseKey: string;
    pendingKey: string | null;
    sessionStatusById: Record<string, string>;
  }) => {
    selectedSessionId: string | null;
    materializedPendingSubmit: boolean;
    shouldMarkInitialAnchor: boolean;
  };
  handleActiveSessionStatusChanged: (
    status: string,
    previousStatus: string | undefined,
  ) => void;
  handleSessionStatusMapChanged: (
    statuses: Record<string, string>,
    previousStatuses: Record<string, string> | undefined,
  ) => void;
};

export type SessionQueueDrainController = {
  start: () => void;
};

export function createSessionQueueDrainController(
  options: SessionQueueDrainControllerOptions,
): SessionQueueDrainController {
  return {
    start() {
      createEffect(
        on(
          options.selectedSessionId,
          (sessionId, previousSessionId) => {
            if (sessionId === previousSessionId) {
              return;
            }
            options.markTempRuntimeUiRenderSource(
              "SessionQueueDrainController.selectedSessionIdEffect",
              sessionId ? "selected-session-changed" : "selected-session-cleared",
              { detail: `previous=${previousSessionId ?? "none"}` },
            );
            options.setSearchQuery("");
            options.closeSearch();

            const pendingBaseKey = options.pendingSessionQueueKey();
            const pendingKey = !previousSessionId
              ? options.pendingQueueKeyAwaitingSessionIdByBaseKey()[pendingBaseKey] ?? null
              : null;
            const previousSessionKey = previousSessionId
              ? options.sessionQueueKeyForSessionId(previousSessionId)
              : null;
            if (!pendingKey && previousSessionKey) {
              options.preserveRunStateOnSessionSwitch(previousSessionKey);
            }
            const flowResult = options.handleSelectedSessionChanged({
              sessionId,
              previousSessionId,
              pendingBaseKey,
              pendingKey,
              sessionStatusById: options.sessionStatusById(),
            });
            if (flowResult.shouldMarkInitialAnchor && flowResult.selectedSessionId) {
              options.markSelectedSessionForInitialAnchor(flowResult.selectedSessionId);
            }
          },
        ),
        undefined,
        { name: "session.queue-drain.selected-session" },
      );

      createEffect(
        on(
          options.sessionStatus,
          (status, previousStatus) => {
            options.handleActiveSessionStatusChanged(status, previousStatus);
          },
        ),
        undefined,
        { name: "session.queue-drain.active-status" },
      );

      createEffect(
        on(
          options.sessionStatusById,
          (statuses, previousStatuses) => {
            options.handleSessionStatusMapChanged(statuses, previousStatuses);
          },
        ),
        undefined,
        { name: "session.queue-drain.status-map" },
      );
    },
  };
}
