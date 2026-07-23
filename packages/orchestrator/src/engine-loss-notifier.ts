export type EngineLossNotification = {
  eventId: string;
  workspaceId: string;
  engineSlotId: string;
  engineOwnerId: string;
  enginePid: number;
  engineStartedAt: number;
  engineBaseUrl: string;
  event: string;
  runIds: string[];
  reason: string;
};

export type EngineLossNotifier = (input: EngineLossNotification) => Promise<{
  delivered: boolean;
  attempts: number;
}>;

type EngineLossNotifierOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxAttempts?: number;
  sleepImpl?: (delayMs: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function createEngineLossNotifier(options: EngineLossNotifierOptions): EngineLossNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token.trim();
  const timeoutMs = normalizePositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxAttempts = normalizePositiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const sleepImpl = options.sleepImpl ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  return async (input) => {
    if (
      !baseUrl ||
      !token ||
      !input.eventId.trim() ||
      !input.workspaceId.trim() ||
      !input.engineOwnerId.trim() ||
      !Number.isSafeInteger(input.enginePid) ||
      input.enginePid <= 0 ||
      !Number.isSafeInteger(input.engineStartedAt) ||
      input.engineStartedAt <= 0 ||
      !input.engineBaseUrl.trim()
    ) {
      return { delivered: false, attempts: 0 };
    }

    const url = `${baseUrl}/internal/orchestrator/engine-loss`;
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Veslo-Orchestrator-Token": token,
          },
          body: JSON.stringify({
            schema: "veslo-engine-loss/v1",
            ...input,
            runIds: [...new Set(input.runIds.map((runId) => runId.trim()).filter(Boolean))],
          }),
        });
        if (response.ok) return { delivered: true, attempts };
      } catch {
        // Retry transient callback failures. Local orchestration has already
        // terminalized the runs; this callback is a best-effort convergence hint.
      } finally {
        clearTimeout(timeoutId);
      }
      if (attempt < maxAttempts) await sleepImpl(50 * 2 ** (attempt - 1));
    }
    return { delivered: false, attempts };
  };
}
