export type VesloRequestBrokerEndpointCounters = {
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
  cloneCount: number;
  cloneMs: number;
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

const reported = {
  coalesced: 0,
  cloneCount: 0,
  cloneMicroseconds: 0,
  endpoints: new Map<string, number>(),
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

/** Method and path, with the origin and all query values dropped. */
function endpointDisplayKey(key: string): string {
  const separator = key.indexOf(" ");
  if (separator < 0) return key;
  const method = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  try {
    const url = new URL(rest);
    return `${method} ${url.pathname}${url.search}`;
  } catch {
    const schemeless = rest.replace(/^[a-z]+:\/\/[^/]+/i, "");
    return `${method} ${schemeless || rest}`;
  }
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

/**
 * Coalescing turns N concurrent identical GETs into one request, which is the
 * point of this broker. Cloning the result for every caller then reintroduces
 * the cost it saved: the work becomes O(callers x payload), synchronously,
 * inside the microtask drain that resolves the shared flight.
 *
 * A captured profile showed 500 callers coalescing onto a single GET and each
 * deep-cloning the response in one 13.3 second microtask drain, a third of it
 * spent in garbage collection. The clone is what converts a large fan-out into
 * a frozen UI, so it is counted and reported rather than left invisible.
 */
let cloneCount = 0;
let cloneMicroseconds = 0;

function cloneBrokeredJsonResult<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const cloned =
    typeof structuredClone === "function"
      ? structuredClone(value)
      : (JSON.parse(JSON.stringify(value)) as T);
  const elapsed =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) -
    startedAt;
  cloneCount += 1;
  cloneMicroseconds += Math.round(elapsed * 1000);
  return cloned;
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
    cloneCount,
    cloneMs: Math.round(cloneMicroseconds / 1000),
    endpoints: [...endpointCounters.values()].map((entry) => ({ ...entry })),
  };
}

/**
 * Counters consumed since the previous call, so a stall report can name the
 * endpoint that fanned out instead of only proving that time was lost.
 */
export function takeVesloRequestBrokerDelta(): {
  coalesced: number;
  cloneCount: number;
  cloneMs: number;
  topEndpoints: Array<{ key: string; coalesced: number; started: number }>;
} | null {
  const coalesced = totals.coalesced - reported.coalesced;
  const clones = cloneCount - reported.cloneCount;
  if (coalesced <= 0 && clones <= 0) return null;
  const topEndpoints = [...endpointCounters.values()]
    .map((entry) => ({
      // Report method + path only. The full key starts with an origin, and the
      // shared trace sanitizer redacts anything URL-shaped, which would leave
      // the one field this delta exists to provide as "[redacted]".
      key: endpointDisplayKey(entry.key),
      coalesced: entry.coalesced - (reported.endpoints.get(entry.key) ?? 0),
      started: entry.started,
    }))
    .filter((entry) => entry.coalesced > 0)
    .sort((left, right) => right.coalesced - left.coalesced)
    .slice(0, 3);
  const cloneMs = Math.round(
    (cloneMicroseconds - reported.cloneMicroseconds) / 1000,
  );
  reported.coalesced = totals.coalesced;
  reported.cloneCount = cloneCount;
  reported.cloneMicroseconds = cloneMicroseconds;
  for (const entry of endpointCounters.values()) {
    reported.endpoints.set(entry.key, entry.coalesced);
  }
  return { coalesced, cloneCount: clones, cloneMs, topEndpoints };
}

export function resetVesloRequestBrokerForTests() {
  inFlightJsonGets.clear();
  endpointCounters.clear();
  totals.started = 0;
  totals.completed = 0;
  totals.failed = 0;
  totals.coalesced = 0;
  cloneCount = 0;
  cloneMicroseconds = 0;
  reported.coalesced = 0;
  reported.cloneCount = 0;
  reported.cloneMicroseconds = 0;
  reported.endpoints.clear();
}

export function isLocalVesloTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Only one usage of each socket address|error sending request for url|failed to fetch|network error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|connection refused/i
    .test(message);
}
