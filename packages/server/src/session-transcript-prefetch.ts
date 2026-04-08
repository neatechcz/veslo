export type SessionTranscriptSnapshot = {
  workspaceId: string;
  sessionId: string;
  limit: number;
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
  fetchedAt: number;
  staleAt: number;
};

export type SessionTranscriptLoadInput = {
  workspaceId: string;
  sessionId: string;
  limit: number;
};

export type SessionTranscriptLoadResult = {
  workspaceId?: string;
  sessionId?: string;
  messages: unknown[];
  partsByMessageId?: Record<string, unknown[]>;
  fetchedAt?: number;
  staleAt?: number;
};

export type SessionTranscriptPrefetchInterest = {
  workspaceId: string;
  visibleSessionIds: string[];
  selectedSessionId?: string | null;
  limit?: number;
};

export type SessionTranscriptPrefetchResult = {
  workspaceId: string;
  queuedSessionIds: string[];
  items: SessionTranscriptSnapshot[];
};

type SessionTranscriptPrefetchOptions = {
  loadTranscript: (input: SessionTranscriptLoadInput) => Promise<SessionTranscriptLoadResult>;
  maxEntriesPerWorkspace?: number;
  defaultLimit?: number;
  staleTtlMs?: number;
  autoPrefetchOnInterest?: boolean;
  maxPrefetchPerUpdate?: number;
};

type CacheEntry = {
  snapshot: SessionTranscriptSnapshot;
  lastAccessedAt: number;
};

type InFlightLoad = {
  limit: number;
  promise: Promise<SessionTranscriptSnapshot>;
};

const DEFAULT_LIMIT = 140;
const DEFAULT_STALE_TTL_MS = 20_000;
const DEFAULT_MAX_ENTRIES_PER_WORKSPACE = 24;
const DEFAULT_MAX_PREFETCH_PER_UPDATE = 3;

const normalizeId = (value: string | null | undefined) => value?.trim() ?? "";

const nowMs = () => Date.now();

const inFlightKey = (workspaceId: string, sessionId: string) => `${workspaceId}:${sessionId}`;

const toPositiveInt = (value: number | undefined, fallback: number) => {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.floor(value as number);
};

const sanitizePartsByMessageId = (input: Record<string, unknown[]> | undefined) => {
  if (!input || typeof input !== "object") return {};
  const next: Record<string, unknown[]> = {};
  for (const [messageId, parts] of Object.entries(input)) {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId) continue;
    next[normalizedId] = Array.isArray(parts) ? parts : [];
  }
  return next;
};

export function createSessionTranscriptPrefetchStore(options: SessionTranscriptPrefetchOptions) {
  const maxEntriesPerWorkspace = toPositiveInt(options.maxEntriesPerWorkspace, DEFAULT_MAX_ENTRIES_PER_WORKSPACE);
  const defaultLimit = toPositiveInt(options.defaultLimit, DEFAULT_LIMIT);
  const staleTtlMs = toPositiveInt(options.staleTtlMs, DEFAULT_STALE_TTL_MS);
  const maxPrefetchPerUpdate = toPositiveInt(options.maxPrefetchPerUpdate, DEFAULT_MAX_PREFETCH_PER_UPDATE);
  const autoPrefetchOnInterest = options.autoPrefetchOnInterest ?? true;

  const queueByWorkspace = new Map<string, string[]>();
  const desiredLimitByWorkspace = new Map<string, Map<string, number>>();
  const cacheByWorkspace = new Map<string, Map<string, CacheEntry>>();
  const inFlightBySession = new Map<string, InFlightLoad>();
  const pumpByWorkspace = new Map<string, Promise<void>>();

  const workspaceCache = (workspaceId: string) => {
    let cache = cacheByWorkspace.get(workspaceId);
    if (!cache) {
      cache = new Map();
      cacheByWorkspace.set(workspaceId, cache);
    }
    return cache;
  };

  const workspaceDesiredLimits = (workspaceId: string) => {
    let limits = desiredLimitByWorkspace.get(workspaceId);
    if (!limits) {
      limits = new Map();
      desiredLimitByWorkspace.set(workspaceId, limits);
    }
    return limits;
  };

  const snapshotIsWarm = (snapshot: SessionTranscriptSnapshot) => snapshot.staleAt > nowMs();

  const touchCacheEntry = (workspaceId: string, sessionId: string) => {
    const cache = workspaceCache(workspaceId);
    const entry = cache.get(sessionId);
    if (!entry) return;
    entry.lastAccessedAt = nowMs();
    cache.set(sessionId, entry);
  };

  const evictWorkspaceCacheIfNeeded = (workspaceId: string) => {
    const cache = workspaceCache(workspaceId);
    while (cache.size > maxEntriesPerWorkspace) {
      let oldestKey: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [sessionId, entry] of cache.entries()) {
        if (entry.lastAccessedAt < oldestAccess) {
          oldestAccess = entry.lastAccessedAt;
          oldestKey = sessionId;
        }
      }
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
  };

  const setCachedSnapshot = (snapshot: SessionTranscriptSnapshot) => {
    const cache = workspaceCache(snapshot.workspaceId);
    cache.set(snapshot.sessionId, { snapshot, lastAccessedAt: nowMs() });
    evictWorkspaceCacheIfNeeded(snapshot.workspaceId);
  };

  const getWarmSnapshot = (input: { workspaceId: string; sessionId: string; limit?: number }) => {
    const workspaceId = normalizeId(input.workspaceId);
    const sessionId = normalizeId(input.sessionId);
    const requiredLimit = toPositiveInt(input.limit, 1);
    if (!workspaceId || !sessionId) return null;
    const cache = workspaceCache(workspaceId);
    const entry = cache.get(sessionId);
    if (!entry) return null;
    if (!snapshotIsWarm(entry.snapshot)) return null;
    if (entry.snapshot.limit < requiredLimit) return null;
    touchCacheEntry(workspaceId, sessionId);
    return entry.snapshot;
  };

  const setDesiredLimit = (workspaceId: string, sessionId: string, limit: number) => {
    workspaceDesiredLimits(workspaceId).set(sessionId, toPositiveInt(limit, defaultLimit));
  };

  const resolveDesiredLimit = (workspaceId: string, sessionId: string, fallback?: number) => {
    const fromWorkspace = workspaceDesiredLimits(workspaceId).get(sessionId);
    return toPositiveInt(fromWorkspace ?? fallback, defaultLimit);
  };

  const normalizeInterestQueue = (input: SessionTranscriptPrefetchInterest) => {
    const selected = normalizeId(input.selectedSessionId);
    const unique = new Set<string>();
    if (selected) unique.add(selected);
    for (const value of input.visibleSessionIds) {
      const normalized = normalizeId(value);
      if (!normalized) continue;
      unique.add(normalized);
    }
    return Array.from(unique);
  };

  const removeFromQueue = (workspaceId: string, sessionId: string) => {
    const queue = queueByWorkspace.get(workspaceId);
    if (!queue || queue.length === 0) return;
    queueByWorkspace.set(
      workspaceId,
      queue.filter((item) => item !== sessionId),
    );
  };

  const ensureLoaded = async (input: SessionTranscriptLoadInput) => {
    const workspaceId = normalizeId(input.workspaceId);
    const sessionId = normalizeId(input.sessionId);
    const limit = resolveDesiredLimit(workspaceId, sessionId, input.limit);
    if (!workspaceId || !sessionId) {
      throw new Error("workspaceId and sessionId are required");
    }

    const warm = getWarmSnapshot({ workspaceId, sessionId, limit });
    if (warm) return warm;

    const dedupeKey = inFlightKey(workspaceId, sessionId);
    const existing = inFlightBySession.get(dedupeKey);
    if (existing && existing.limit >= limit) return existing.promise;

    const run = (async () => {
      const raw = await options.loadTranscript({ workspaceId, sessionId, limit });
      const fetchedAt = Number.isFinite(raw.fetchedAt) ? Math.floor(raw.fetchedAt as number) : nowMs();
      const staleAt = Number.isFinite(raw.staleAt) && (raw.staleAt as number) > fetchedAt
        ? Math.floor(raw.staleAt as number)
        : fetchedAt + staleTtlMs;
      const snapshot: SessionTranscriptSnapshot = {
        workspaceId: normalizeId(raw.workspaceId) || workspaceId,
        sessionId: normalizeId(raw.sessionId) || sessionId,
        limit,
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        partsByMessageId: sanitizePartsByMessageId(raw.partsByMessageId),
        fetchedAt,
        staleAt,
      };
      setCachedSnapshot(snapshot);
      removeFromQueue(workspaceId, sessionId);
      return snapshot;
    })();

    inFlightBySession.set(dedupeKey, { limit, promise: run });
    try {
      return await run;
    } finally {
      if (inFlightBySession.get(dedupeKey)?.promise === run) {
        inFlightBySession.delete(dedupeKey);
      }
    }
  };

  const pumpWorkspace = (workspaceIdRaw: string) => {
    const workspaceId = normalizeId(workspaceIdRaw);
    if (!workspaceId) return Promise.resolve();
    const existing = pumpByWorkspace.get(workspaceId);
    if (existing) return existing;

    const run = (async () => {
      let remaining = maxPrefetchPerUpdate;
      while (remaining > 0) {
        const queue = queueByWorkspace.get(workspaceId) ?? [];
        if (queue.length === 0) break;
        const sessionId = normalizeId(queue[0]);
        if (!sessionId) {
          queue.shift();
          queueByWorkspace.set(workspaceId, queue);
          continue;
        }

        const limit = resolveDesiredLimit(workspaceId, sessionId);
        const warm = getWarmSnapshot({ workspaceId, sessionId, limit });
        if (warm) {
          queue.shift();
          queueByWorkspace.set(workspaceId, queue);
          continue;
        }

        try {
          await ensureLoaded({ workspaceId, sessionId, limit });
        } catch {
          break;
        }
        remaining -= 1;
      }
    })();

    pumpByWorkspace.set(workspaceId, run);
    return run.finally(() => {
      if (pumpByWorkspace.get(workspaceId) === run) {
        pumpByWorkspace.delete(workspaceId);
      }
    });
  };

  return {
    async updateInterest(input: SessionTranscriptPrefetchInterest): Promise<SessionTranscriptPrefetchResult> {
      const workspaceId = normalizeId(input.workspaceId);
      if (!workspaceId) throw new Error("workspaceId is required");

      const queue = normalizeInterestQueue(input);
      queueByWorkspace.set(workspaceId, queue);

      const limit = toPositiveInt(input.limit, defaultLimit);
      for (const sessionId of queue) {
        setDesiredLimit(workspaceId, sessionId, limit);
      }

      const items = queue
        .map((sessionId) => getWarmSnapshot({ workspaceId, sessionId, limit }))
        .filter((snapshot): snapshot is SessionTranscriptSnapshot => Boolean(snapshot));
      const queuedSessionIds = queue.filter((sessionId) => !items.some((snapshot) => snapshot.sessionId === sessionId));

      if (autoPrefetchOnInterest) {
        void pumpWorkspace(workspaceId);
      }

      return { workspaceId, queuedSessionIds, items };
    },

    getWarmSnapshot,

    listWarmSnapshots(input: { workspaceId: string; sessionIds?: string[] }) {
      const workspaceId = normalizeId(input.workspaceId);
      if (!workspaceId) return [];
      const cache = workspaceCache(workspaceId);
      const sessionIds = input.sessionIds
        ? input.sessionIds.map((value) => normalizeId(value)).filter(Boolean)
        : Array.from(cache.keys());
      const seen = new Set<string>();
      const snapshots: SessionTranscriptSnapshot[] = [];
      for (const sessionId of sessionIds) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        const limit = resolveDesiredLimit(workspaceId, sessionId);
        const warm = getWarmSnapshot({ workspaceId, sessionId, limit });
        if (warm) snapshots.push(warm);
      }
      return snapshots;
    },

    getOrLoad(input: SessionTranscriptLoadInput) {
      setDesiredLimit(input.workspaceId, input.sessionId, input.limit);
      return ensureLoaded(input);
    },

    prefetchWorkspace(workspaceId: string) {
      return pumpWorkspace(workspaceId);
    },

    debugQueue(workspaceIdRaw: string) {
      const workspaceId = normalizeId(workspaceIdRaw);
      if (!workspaceId) return [];
      return [...(queueByWorkspace.get(workspaceId) ?? [])];
    },

    debugCacheSessionIds(workspaceIdRaw: string) {
      const workspaceId = normalizeId(workspaceIdRaw);
      if (!workspaceId) return [];
      return [...workspaceCache(workspaceId).keys()];
    },
  };
}
