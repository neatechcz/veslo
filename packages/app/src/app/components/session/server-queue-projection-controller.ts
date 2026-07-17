import type { VesloConversationQueueItem } from "../../lib/veslo-server.js";
import {
  serverQueuedRunScopeKey,
  type ServerQueuedRunProjectionScope,
} from "./server-queue-projection-model.js";

export const SERVER_QUEUE_PROJECTION_POLL_BACKOFF_MS = [750, 1_500, 3_000, 5_000] as const;

export type ServerQueueProjectionRefreshResult =
  | { kind: "updated"; itemCount: number; hasPollingRows: boolean }
  | { kind: "stale" }
  | { kind: "unavailable" }
  | { kind: "error" };

export type ServerQueueProjectionControllerOptions = {
  getScope: () => ServerQueuedRunProjectionScope | null;
  fetchScope: (scope: ServerQueuedRunProjectionScope) => Promise<VesloConversationQueueItem[] | null>;
  replaceScope: (scope: ServerQueuedRunProjectionScope, items: VesloConversationQueueItem[]) => void;
  hasKnownPollingRows?: (scope: ServerQueuedRunProjectionScope) => boolean;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

const scopesMatch = (
  left: ServerQueuedRunProjectionScope | null | undefined,
  right: ServerQueuedRunProjectionScope | null | undefined,
) =>
  Boolean(
    left &&
      right &&
      left.uiConversationKey === right.uiConversationKey &&
      serverQueuedRunScopeKey(left.workspaceId, left.conversationId) ===
        serverQueuedRunScopeKey(right.workspaceId, right.conversationId),
  );

const hasPollingRows = (items: VesloConversationQueueItem[]) =>
  items.some((item) => item.status === "pending" || item.status === "starting");

export function createServerQueueProjectionController(options: ServerQueueProjectionControllerOptions) {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollingScope: ServerQueuedRunProjectionScope | null = null;
  let pollingAttempt = 0;
  const disposal = new Set<true>();

  const stopPolling = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pollingScope = null;
    pollingAttempt = 0;
  };

  const stopPollingFor = (scope: ServerQueuedRunProjectionScope | null | undefined) => {
    if (scope && pollingScope && !scopesMatch(scope, pollingScope)) return;
    stopPolling();
  };

  const refresh = async (
    requestedScope = options.getScope(),
  ): Promise<ServerQueueProjectionRefreshResult> => {
    if (disposal.has(true) || !requestedScope) return { kind: "unavailable" };

    let items: VesloConversationQueueItem[] | null;
    try {
      items = await options.fetchScope(requestedScope);
    } catch {
      if (!scopesMatch(requestedScope, options.getScope())) return { kind: "stale" };
      return { kind: "error" };
    }

    if (!items) return { kind: "unavailable" };
    if (disposal.has(true) || !scopesMatch(requestedScope, options.getScope())) return { kind: "stale" };

    options.replaceScope(requestedScope, items);
    return { kind: "updated", itemCount: items.length, hasPollingRows: hasPollingRows(items) };
  };

  const schedulePolling = (scope: ServerQueuedRunProjectionScope) => {
    if (disposal.has(true) || !scopesMatch(scope, options.getScope())) {
      stopPollingFor(scope);
      return;
    }
    if (timer !== null && scopesMatch(scope, pollingScope)) return;
    if (!scopesMatch(scope, pollingScope)) {
      stopPolling();
      pollingScope = scope;
    }
    const delayMs = SERVER_QUEUE_PROJECTION_POLL_BACKOFF_MS[
      Math.min(pollingAttempt, SERVER_QUEUE_PROJECTION_POLL_BACKOFF_MS.length - 1)
    ];
    timer = setTimer(() => {
      timer = null;
      void poll(scope);
    }, delayMs);
  };

  const poll = async (scope: ServerQueuedRunProjectionScope) => {
    if (disposal.has(true) || !scopesMatch(scope, options.getScope())) {
      stopPollingFor(scope);
      return;
    }
    const result = await refresh(scope);
    if (result.kind === "updated" && result.hasPollingRows) {
      pollingAttempt += 1;
      schedulePolling(scope);
      return;
    }
    if (result.kind === "error" && options.hasKnownPollingRows?.(scope)) {
      pollingAttempt += 1;
      schedulePolling(scope);
      return;
    }
    stopPollingFor(scope);
  };

  const refreshAndPoll = async (requestedScope = options.getScope()) => {
    const result = await refresh(requestedScope);
    if (result.kind === "updated" && result.hasPollingRows && requestedScope) schedulePolling(requestedScope);
    else if (result.kind === "error" && requestedScope && options.hasKnownPollingRows?.(requestedScope)) {
      pollingAttempt += 1;
      schedulePolling(requestedScope);
    } else if (result.kind !== "stale") stopPollingFor(requestedScope);
    return result;
  };

  return {
    refresh,
    refreshAndPoll,
    stopPolling,
    dispose: () => {
      disposal.add(true);
      stopPolling();
    },
  };
}
