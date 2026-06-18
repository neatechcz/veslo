type StartupRequestAuditRoot = typeof globalThis & {
  __vesloStartupRequestAudit?: StartupRequestAudit;
  __vesloStartupRequestAuditStop?: (reason?: string) => void;
};

type StartupRequestAuditInternalEntry = {
  key: string;
  method: string;
  url: string;
  count: number;
  firstAtMs: number;
  lastAtMs: number;
  sources: Set<string>;
};

export type StartupRequestAuditEntry = Omit<StartupRequestAuditInternalEntry, "sources"> & {
  sources: string[];
};

export type StartupRequestAuditSummary = {
  reason: string;
  windowMs: number;
  elapsedMs: number;
  totalCount: number;
  distinctCount: number;
  truncated: number;
  requests: StartupRequestAuditEntry[];
};

export type StartupRequestAuditLog = (
  event: "startup-monitor-start" | "startup-summary",
  payload: Record<string, unknown>,
) => void;

export type StartupRequestAuditOptions = {
  enabled?: boolean;
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
  setTimeout?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  log?: StartupRequestAuditLog;
  root?: StartupRequestAuditRoot;
};

export type StartupRequestAuditFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const STARTUP_REQUEST_AUDIT_WINDOW_MS = 30_000;
const DEFAULT_MAX_SUMMARY_ENTRIES = 200;

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeMethod(method: unknown): string {
  return typeof method === "string" && method.trim()
    ? method.trim().toUpperCase()
    : "GET";
}

function requestInputMethod(input: RequestInfo | URL): string | null {
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method;
  }
  return null;
}

export function resolveStartupRequestAuditMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  return normalizeMethod(init?.method ?? requestInputMethod(input));
}

function requestInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function isManualAuditRecord(
  input: RequestInfo | URL | { method?: string | null; url: string },
): input is { method?: string | null; url: string } {
  if (!input || typeof input !== "object") return false;
  if (input instanceof URL) return false;
  if (typeof Request !== "undefined" && input instanceof Request) return false;
  return typeof (input as { url?: unknown }).url === "string";
}

function normalizePathSegment(segment: string): string {
  if (!segment) return segment;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
    return ":uuid";
  }
  if (/^[0-9a-f]{16,}$/i.test(segment)) return ":hex";
  const prefixedId = segment.match(/^(ses|msg|part|run|ws|workspace|thread|evt)_[A-Za-z0-9-]{12,}$/i);
  if (prefixedId?.[1]) return `${prefixedId[1]}_:id`;
  return segment;
}

function normalizePathname(pathname: string): string {
  return pathname.split("/").map(normalizePathSegment).join("/") || "/";
}

function queryNameSuffix(url: URL): string {
  const names = new Set<string>();
  url.searchParams.forEach((_value, key) => {
    if (key) names.add(key);
  });
  if (names.size === 0) return "";
  return `?${[...names].sort().join("&")}`;
}

function fallbackNormalizeRequestTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "<empty>";
  const queryIndex = trimmed.indexOf("?");
  return queryIndex >= 0 ? `${trimmed.slice(0, queryIndex)}?` : trimmed;
}

function shouldSkipStartupRequestAuditUrl(url: string): boolean {
  if (!url.startsWith("http://ipc.localhost/")) return false;
  try {
    const pathname = new URL(url).pathname;
    if (pathname === "/log_ui_event") return true;
    return pathname.startsWith("/plugin%3Ahttp%7Cfetch");
  } catch {
    return false;
  }
}

export function normalizeStartupRequestAuditUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "<empty>";
  if (/^data:/i.test(trimmed)) {
    const mime = trimmed.slice("data:".length).split(/[;,]/, 1)[0] || "unknown";
    return `data:${mime}`;
  }
  if (/^blob:/i.test(trimmed)) return "blob:";

  try {
    const base =
      typeof window !== "undefined" && typeof window.location?.href === "string"
        ? window.location.href
        : "http://veslo.local/";
    const url = new URL(trimmed, base);
    return `${url.origin}${normalizePathname(url.pathname)}${queryNameSuffix(url)}`;
  } catch {
    return fallbackNormalizeRequestTarget(trimmed);
  }
}

export function createStartupRequestAudit(options: {
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}) {
  const windowMs = options.windowMs ?? STARTUP_REQUEST_AUDIT_WINDOW_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_SUMMARY_ENTRIES;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const entries = new Map<string, StartupRequestAuditInternalEntry>();
  let stopped = false;

  const record = (
    input: RequestInfo | URL | { method?: string | null; url: string },
    init?: RequestInit,
    source = "fetch",
  ): boolean => {
    if (stopped) return false;
    const elapsedMs = now() - startedAt;
    if (elapsedMs < 0 || elapsedMs > windowMs) return false;

    const manualRecord = isManualAuditRecord(input);
    const method = manualRecord
      ? normalizeMethod(input.method)
      : resolveStartupRequestAuditMethod(input, init);
    const url = manualRecord
      ? normalizeStartupRequestAuditUrl(input.url)
      : normalizeStartupRequestAuditUrl(requestInputUrl(input));
    if (shouldSkipStartupRequestAuditUrl(url)) return false;
    const key = `${method} ${url}`;
    const existing = entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAtMs = roundMs(elapsedMs);
      existing.sources.add(source);
      return true;
    }

    entries.set(key, {
      key,
      method,
      url,
      count: 1,
      firstAtMs: roundMs(elapsedMs),
      lastAtMs: roundMs(elapsedMs),
      sources: new Set([source]),
    });
    return true;
  };

  const summarize = (reason: string): StartupRequestAuditSummary => {
    const elapsedMs = Math.max(0, now() - startedAt);
    const sortedEntries = [...entries.values()].sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    );
    const requests = sortedEntries.slice(0, maxEntries).map((entry) => ({
      key: entry.key,
      method: entry.method,
      url: entry.url,
      count: entry.count,
      firstAtMs: entry.firstAtMs,
      lastAtMs: entry.lastAtMs,
      sources: [...entry.sources].sort(),
    }));

    let totalCount = 0;
    for (const entry of entries.values()) {
      totalCount += entry.count;
    }

    return {
      reason,
      windowMs,
      elapsedMs: roundMs(elapsedMs),
      totalCount,
      distinctCount: entries.size,
      truncated: Math.max(0, entries.size - requests.length),
      requests,
    };
  };

  const stop = (reason = "manual"): StartupRequestAuditSummary => {
    stopped = true;
    return summarize(reason);
  };

  return {
    record,
    summarize,
    stop,
    get stopped() {
      return stopped;
    },
  };
}

export type StartupRequestAudit = ReturnType<typeof createStartupRequestAudit>;

function activeAudit(): StartupRequestAudit | undefined {
  return (globalThis as StartupRequestAuditRoot).__vesloStartupRequestAudit;
}

export function recordStartupRequestAudit(
  input: RequestInfo | URL | { method?: string | null; url: string },
  init?: RequestInit,
  source?: string,
): boolean {
  return activeAudit()?.record(input, init, source) ?? false;
}

export function wrapStartupRequestAuditFetch<T extends StartupRequestAuditFetch>(
  fetchImpl: T,
  source = "fetch",
): T {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    recordStartupRequestAudit(input, init, source);
    return fetchImpl(input, init);
  }) as T;
}

export function installStartupRequestAudit(
  options: StartupRequestAuditOptions = {},
): (reason?: string) => void {
  if (options.enabled === false) return () => {};
  const root = options.root ?? (globalThis as StartupRequestAuditRoot);
  root.__vesloStartupRequestAuditStop?.("reinstall");

  const windowMs = options.windowMs ?? STARTUP_REQUEST_AUDIT_WINDOW_MS;
  const timerSet = options.setTimeout ?? setTimeout;
  const timerClear = options.clearTimeout ?? clearTimeout;
  const audit = createStartupRequestAudit({
    windowMs,
    maxEntries: options.maxEntries,
    now: options.now,
  });

  const originalFetch = root.fetch;
  const originalOpen =
    typeof root.XMLHttpRequest !== "undefined" &&
    typeof root.XMLHttpRequest.prototype?.open === "function"
      ? root.XMLHttpRequest.prototype.open
      : null;
  let patchedFetch: typeof fetch | null = null;
  let patchedOpen: typeof XMLHttpRequest.prototype.open | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  if (typeof originalFetch === "function") {
    patchedFetch = function patchedStartupAuditFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      audit.record(input, init, "global.fetch");
      return originalFetch.call(this, input, init);
    } as typeof fetch;
    root.fetch = patchedFetch;
  }

  if (originalOpen && root.XMLHttpRequest) {
    patchedOpen = function patchedStartupAuditXhrOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      audit.record({ method, url: typeof url === "string" ? url : url.toString() }, undefined, "xhr");
      return (originalOpen as (...args: unknown[]) => unknown).call(
        this,
        method,
        url,
        async ?? true,
        username,
        password,
      );
    } as typeof XMLHttpRequest.prototype.open;
    root.XMLHttpRequest.prototype.open = patchedOpen;
  }

  const restore = (reason = "manual") => {
    if (finished) return;
    finished = true;
    if (timer) {
      timerClear(timer);
      timer = null;
    }
    if (patchedFetch && root.fetch === patchedFetch) {
      root.fetch = originalFetch;
    }
    if (patchedOpen && root.XMLHttpRequest?.prototype.open === patchedOpen) {
      root.XMLHttpRequest.prototype.open = originalOpen!;
    }
    if (root.__vesloStartupRequestAudit === audit) {
      delete root.__vesloStartupRequestAudit;
      delete root.__vesloStartupRequestAuditStop;
    }
    options.log?.("startup-summary", audit.stop(reason) as unknown as Record<string, unknown>);
  };

  root.__vesloStartupRequestAudit = audit;
  root.__vesloStartupRequestAuditStop = restore;
  options.log?.("startup-monitor-start", { windowMs });
  timer = timerSet(() => restore("timer"), windowMs);

  return restore;
}
