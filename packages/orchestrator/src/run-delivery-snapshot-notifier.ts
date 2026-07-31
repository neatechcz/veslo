export type RunDeliveryRouterObservation = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  engineOwnerId: string;
  enginePid: number;
  engineStartedAt: number;
  engineBaseUrl: string;
  directoryInstanceEpoch?: number | null;
  eventCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
};

export type RunDeliverySnapshotNotifier = (input: RunDeliveryRouterObservation) => Promise<boolean>;

export function createRunDeliverySnapshotNotifier(options: {
  baseUrl: string;
  token: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): RunDeliverySnapshotNotifier {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Math.floor(options.timeoutMs ?? 0)
    : 1_000;

  return async (input) => {
    if (
      !baseUrl ||
      !token ||
      !input.workspaceId.trim() ||
      !input.conversationId.trim() ||
      !input.runId.trim() ||
      !input.opencodeSessionId.trim() ||
      !input.engineOwnerId.trim() ||
      !Number.isSafeInteger(input.enginePid) || input.enginePid <= 0 ||
      !Number.isSafeInteger(input.engineStartedAt) || input.engineStartedAt <= 0 ||
      !input.engineBaseUrl.trim() ||
      !Number.isSafeInteger(input.eventCount) || input.eventCount <= 0
    ) return false;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${baseUrl}/internal/orchestrator/run-delivery-snapshot/router-observed`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Veslo-Orchestrator-Token": token,
          },
          body: JSON.stringify({ schema: "veslo-run-delivery-snapshot/v1", ...input }),
        },
      );
      return response.ok;
    } catch {
      // Snapshot telemetry is bounded, no-retry diagnostics. It must never
      // delay or amplify the OpenCode event stream.
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  };
}
