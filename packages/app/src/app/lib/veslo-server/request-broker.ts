type VesloRequestBrokerEndpointCounters = {
  key: string;
  started: number;
  completed: number;
  failed: number;
  coalesced: number;
};

export type VesloRequestBrokerSnapshot = {
  started: number;
  completed: number;
  failed: number;
  coalesced: number;
  inFlight: number;
  endpoints: VesloRequestBrokerEndpointCounters[];
};

type CounterName = "started" | "completed" | "failed" | "coalesced";

type BrokeredJsonRequest<T> = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  shareable?: boolean;
  run: () => Promise<T>;
};

const inFlightJsonGets = new Map<string, Promise<unknown>>();
const endpointCounters = new Map<string, VesloRequestBrokerEndpointCounters>();

const totals = {
  started: 0,
  completed: 0,
  failed: 0,
  coalesced: 0,
};

function normalizeMethod(method: string | undefined): string {
  return method?.trim().toUpperCase() || "GET";
}

function normalizeEndpointKey(method: string, rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const queryNames = new Set<string>();
    url.searchParams.forEach((_value, key) => {
      if (key) queryNames.add(key);
    });
    const query = queryNames.size ? `?${[...queryNames].sort().join("&")}` : "";
    return `${method} ${url.origin}${url.pathname}${query}`;
  } catch {
    const queryIndex = rawUrl.indexOf("?");
    return `${method} ${queryIndex >= 0 ? rawUrl.slice(0, queryIndex + 1) : rawUrl}`;
  }
}

function normalizeHeadersForKey(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([key, value]) => [key.trim().toLowerCase(), value] as const)
    .filter(([key]) => key.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");
}

function inFlightKey(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}) {
  return [
    input.method,
    input.url,
    input.timeoutMs ?? "",
    normalizeHeadersForKey(input.headers),
  ].join("\n---\n");
}

function endpointEntry(key: string): VesloRequestBrokerEndpointCounters {
  const existing = endpointCounters.get(key);
  if (existing) return existing;
  const created = {
    key,
    started: 0,
    completed: 0,
    failed: 0,
    coalesced: 0,
  };
  endpointCounters.set(key, created);
  return created;
}

function record(endpointKey: string, counter: CounterName) {
  totals[counter] += 1;
  endpointEntry(endpointKey)[counter] += 1;
}

function cloneBrokeredJsonResult<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function runVesloJsonRequestWithBroker<T>(
  input: BrokeredJsonRequest<T>,
): Promise<T> {
  const method = normalizeMethod(input.method);
  const endpointKey = normalizeEndpointKey(method, input.url);
  const shareable = input.shareable === true && method === "GET";

  if (shareable) {
    const key = inFlightKey({
      method,
      url: input.url,
      headers: input.headers,
      timeoutMs: input.timeoutMs,
    });
    const existing = inFlightJsonGets.get(key);
    if (existing) {
      record(endpointKey, "coalesced");
      return cloneBrokeredJsonResult((await existing) as T);
    }

    const task = (async () => {
      record(endpointKey, "started");
      try {
        const result = await input.run();
        record(endpointKey, "completed");
        return result;
      } catch (error) {
        record(endpointKey, "failed");
        throw error;
      }
    })();
    inFlightJsonGets.set(key, task);
    try {
      return cloneBrokeredJsonResult((await task) as T);
    } finally {
      if (inFlightJsonGets.get(key) === task) {
        inFlightJsonGets.delete(key);
      }
    }
  }

  record(endpointKey, "started");
  try {
    const result = await input.run();
    record(endpointKey, "completed");
    return result;
  } catch (error) {
    record(endpointKey, "failed");
    throw error;
  }
}

export function getVesloRequestBrokerSnapshot(): VesloRequestBrokerSnapshot {
  return {
    ...totals,
    inFlight: inFlightJsonGets.size,
    endpoints: [...endpointCounters.values()].map((entry) => ({ ...entry })),
  };
}

export function resetVesloRequestBrokerForTests() {
  inFlightJsonGets.clear();
  endpointCounters.clear();
  totals.started = 0;
  totals.completed = 0;
  totals.failed = 0;
  totals.coalesced = 0;
}

export function isLocalVesloTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Only one usage of each socket address|error sending request for url|failed to fetch|network error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|connection refused/i
    .test(message);
}
