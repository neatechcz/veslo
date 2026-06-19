export type SessionTranscriptSnapshot = {
  workspaceId: string;
  sessionId: string;
  directory?: string;
  limit: number;
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
  fetchedAt: number;
  staleAt: number;
  source?: "sqlite" | "unavailable";
};

export type SessionTranscriptLoadInput = {
  workspaceId: string;
  sessionId: string;
  limit: number;
  directory?: string | null;
};

export type SessionTranscriptLoadResult = {
  workspaceId?: string;
  sessionId?: string;
  messages: unknown[];
  partsByMessageId?: Record<string, unknown[]>;
  fetchedAt?: number;
  staleAt?: number;
  source?: "sqlite" | "unavailable";
};

export type SessionTranscriptPrefetchInterest = {
  workspaceId: string;
  clickedSessionId?: string | null;
  selectedSessionId?: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
  directory?: string | null;
  sessionDirectoriesById?: Record<string, string | null | undefined>;
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
  maxBytesPerWorkspace?: number;
  defaultLimit?: number;
  staleTtlMs?: number;
  autoPrefetchOnInterest?: boolean;
};

type CacheEntry = {
  snapshot: SessionTranscriptSnapshot;
  lastAccessedAt: number;
  byteSize: number;
};

type InFlightLoad = {
  limit: number;
  promise: Promise<SessionTranscriptSnapshot>;
};

type QueueItem = {
  sessionId: string;
  directory: string;
};

const DEFAULT_LIMIT = 140;
const DEFAULT_STALE_TTL_MS = 20_000;
const DEFAULT_MAX_ENTRIES_PER_WORKSPACE = 24;
const DEFAULT_MAX_BYTES_PER_WORKSPACE = 16 * 1024 * 1024;

const normalizeId = (value: string | null | undefined) => value?.trim() ?? "";

const nowMs = () => Date.now();

const normalizeDirectory = (value: string | null | undefined) => value?.trim() ?? "";

const inFlightKey = (workspaceId: string, sessionId: string, directory?: string | null) =>
  `${workspaceId}:${normalizeDirectory(directory)}:${sessionId}`;

const cacheKey = (sessionId: string, directory?: string | null) =>
  `${normalizeDirectory(directory)}\0${sessionId}`;

const queueItemKey = (item: QueueItem) => cacheKey(item.sessionId, item.directory);

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
  const maxBytesPerWorkspace = toPositiveInt(options.maxBytesPerWorkspace, DEFAULT_MAX_BYTES_PER_WORKSPACE);
  const defaultLimit = toPositiveInt(options.defaultLimit, DEFAULT_LIMIT);
  const staleTtlMs = toPositiveInt(options.staleTtlMs, DEFAULT_STALE_TTL_MS);
  const autoPrefetchOnInterest = options.autoPrefetchOnInterest ?? true;

  const queueByWorkspace = new Map<string, QueueItem[]>();
  const desiredLimitByWorkspace = new Map<string, Map<string, number>>();
  const cacheByWorkspace = new Map<string, Map<string, CacheEntry>>();
  const inFlightBySession = new Map<string, InFlightLoad>();
  const invalidatedAtBySession = new Map<string, number>();
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

  const touchCacheEntry = (workspaceId: string, sessionId: string, directory?: string | null) => {
    const cache = workspaceCache(workspaceId);
    const entry = cache.get(cacheKey(sessionId, directory));
    if (!entry) return;
    entry.lastAccessedAt = nowMs();
    cache.set(cacheKey(sessionId, directory), entry);
  };

  const estimateSnapshotBytes = (snapshot: SessionTranscriptSnapshot) => {
    try {
      return Buffer.byteLength(JSON.stringify({
        messages: snapshot.messages,
        partsByMessageId: snapshot.partsByMessageId,
      }), "utf8");
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const workspaceCacheBytes = (cache: Map<string, CacheEntry>) => {
    let total = 0;
    for (const entry of cache.values()) {
      total += entry.byteSize;
    }
    return total;
  };

  const deleteOldestWorkspaceEntry = (cache: Map<string, CacheEntry>) => {
    let oldestKey: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [sessionId, entry] of cache.entries()) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = sessionId;
      }
    }
    if (!oldestKey) return false;
    cache.delete(oldestKey);
    return true;
  };

  const evictWorkspaceCacheIfNeeded = (workspaceId: string) => {
    const cache = workspaceCache(workspaceId);
    while (cache.size > maxEntriesPerWorkspace) {
      if (!deleteOldestWorkspaceEntry(cache)) break;
    }
    while (cache.size > 0 && workspaceCacheBytes(cache) > maxBytesPerWorkspace) {
      if (!deleteOldestWorkspaceEntry(cache)) break;
    }
  };

  const setCachedSnapshot = (snapshot: SessionTranscriptSnapshot, directory?: string | null) => {
    const cache = workspaceCache(snapshot.workspaceId);
    cache.set(cacheKey(snapshot.sessionId, directory ?? snapshot.directory), {
      snapshot,
      lastAccessedAt: nowMs(),
      byteSize: estimateSnapshotBytes(snapshot),
    });
    evictWorkspaceCacheIfNeeded(snapshot.workspaceId);
  };

  const getWarmSnapshot = (input: {
    workspaceId: string;
    sessionId: string;
    limit?: number;
    directory?: string | null;
  }) => {
    const workspaceId = normalizeId(input.workspaceId);
    const sessionId = normalizeId(input.sessionId);
    const directory = normalizeDirectory(input.directory);
    const requiredLimit = toPositiveInt(input.limit, 1);
    if (!workspaceId || !sessionId) return null;
    const cache = workspaceCache(workspaceId);
    const entry = cache.get(cacheKey(sessionId, directory));
    if (!entry) return null;
    if (!snapshotIsWarm(entry.snapshot)) return null;
    if (entry.snapshot.limit < requiredLimit) return null;
    touchCacheEntry(workspaceId, sessionId, directory);
    return entry.snapshot;
  };

  const setDesiredLimit = (
    workspaceId: string,
    sessionId: string,
    limit: number,
    directory?: string | null,
  ) => {
    workspaceDesiredLimits(workspaceId).set(cacheKey(sessionId, directory), toPositiveInt(limit, defaultLimit));
  };

  const resolveDesiredLimit = (
    workspaceId: string,
    sessionId: string,
    fallback?: number,
    directory?: string | null,
  ) => {
    const fromWorkspace = workspaceDesiredLimits(workspaceId).get(cacheKey(sessionId, directory));
    return toPositiveInt(fromWorkspace ?? fallback, defaultLimit);
  };

  const normalizeSessionDirectories = (input: SessionTranscriptPrefetchInterest) => {
    const defaultDirectory = normalizeDirectory(input.directory);
    const directories = new Map<string, string>();
    const raw = input.sessionDirectoriesById;
    if (raw && typeof raw === "object") {
      for (const [sessionIdRaw, directoryRaw] of Object.entries(raw)) {
        const sessionId = normalizeId(sessionIdRaw);
        const directory = normalizeDirectory(directoryRaw);
        if (sessionId && directory) directories.set(sessionId, directory);
      }
    }
    return { defaultDirectory, directories };
  };

  const normalizeInterestQueue = (input: SessionTranscriptPrefetchInterest) => {
    const ordered: QueueItem[] = [];
    const seen = new Set<string>();
    const { defaultDirectory, directories } = normalizeSessionDirectories(input);
    const push = (value: string | null | undefined) => {
      const sessionId = normalizeId(value);
      if (!sessionId) return;
      const item = {
        sessionId,
        directory: directories.get(sessionId) ?? defaultDirectory,
      };
      const key = queueItemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      ordered.push(item);
    };

    push(input.clickedSessionId);
    push(input.selectedSessionId);
    for (const value of input.expandedSubagentSessionIds) push(value);
    for (const value of input.loadedTopLevelSessionIds) push(value);

    return ordered;
  };

  const removeFromQueue = (workspaceId: string, sessionId: string, directory?: string | null) => {
    const queue = queueByWorkspace.get(workspaceId);
    if (!queue || queue.length === 0) return;
    const targetKey = cacheKey(sessionId, directory);
    queueByWorkspace.set(
      workspaceId,
      queue.filter((item) => queueItemKey(item) !== targetKey),
    );
  };

  const ensureLoaded = async (input: SessionTranscriptLoadInput) => {
    const workspaceId = normalizeId(input.workspaceId);
    const sessionId = normalizeId(input.sessionId);
    const directory = normalizeDirectory(input.directory);
    const limit = resolveDesiredLimit(workspaceId, sessionId, input.limit, directory);
    if (!workspaceId || !sessionId) {
      throw new Error("workspaceId and sessionId are required");
    }

    const warm = getWarmSnapshot({ workspaceId, sessionId, limit, directory });
    if (warm) return warm;

    const dedupeKey = inFlightKey(workspaceId, sessionId, directory);
    const existing = inFlightBySession.get(dedupeKey);
    if (existing && existing.limit >= limit) return existing.promise;

    const loadStartedAt = nowMs();
    const run = (async () => {
      const raw = await options.loadTranscript({ workspaceId, sessionId, limit, directory: directory || undefined });
      const fetchedAt = Number.isFinite(raw.fetchedAt) ? Math.floor(raw.fetchedAt as number) : nowMs();
      const staleAt = Number.isFinite(raw.staleAt) && (raw.staleAt as number) > fetchedAt
        ? Math.floor(raw.staleAt as number)
        : fetchedAt + staleTtlMs;
      const snapshot: SessionTranscriptSnapshot = {
        workspaceId,
        sessionId,
        ...(directory ? { directory } : {}),
        limit,
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        partsByMessageId: sanitizePartsByMessageId(raw.partsByMessageId),
        fetchedAt,
        staleAt,
        source: raw.source,
      };
      const invalidatedAt = invalidatedAtBySession.get(dedupeKey) ?? 0;
      if (snapshot.source !== "unavailable" && invalidatedAt <= loadStartedAt) {
        setCachedSnapshot(snapshot, directory);
      }
      removeFromQueue(workspaceId, sessionId, directory);
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
      while (true) {
        const queue = queueByWorkspace.get(workspaceId) ?? [];
        if (queue.length === 0) break;
        const next = queue[0];
        const sessionId = normalizeId(next?.sessionId);
        const directory = normalizeDirectory(next?.directory);
        if (!sessionId) {
          queue.shift();
          queueByWorkspace.set(workspaceId, queue);
          continue;
        }

        const limit = resolveDesiredLimit(workspaceId, sessionId, undefined, directory);
        const warm = getWarmSnapshot({ workspaceId, sessionId, limit, directory });
        if (warm) {
          queue.shift();
          queueByWorkspace.set(workspaceId, queue);
          continue;
        }

        try {
          await ensureLoaded({ workspaceId, sessionId, limit, directory: directory || undefined });
        } catch {
          removeFromQueue(workspaceId, sessionId, directory);
          continue;
        }
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
      for (const item of queue) {
        setDesiredLimit(workspaceId, item.sessionId, limit, item.directory);
      }

      const items = queue
        .map((item) => getWarmSnapshot({ workspaceId, sessionId: item.sessionId, limit, directory: item.directory }))
        .filter((snapshot): snapshot is SessionTranscriptSnapshot => Boolean(snapshot));
      const warmKeys = new Set(items.map((snapshot) => cacheKey(snapshot.sessionId, snapshot.directory)));
      const queuedSessionIds = queue
        .filter((item) => !warmKeys.has(queueItemKey(item)))
        .map((item) => item.sessionId);

      if (autoPrefetchOnInterest) {
        void pumpWorkspace(workspaceId);
      }

      return { workspaceId, queuedSessionIds, items };
    },

    getWarmSnapshot,

    invalidate(input: { workspaceId: string; sessionId: string; directory?: string | null }) {
      const workspaceId = normalizeId(input.workspaceId);
      const sessionId = normalizeId(input.sessionId);
      const directory = normalizeDirectory(input.directory);
      if (!workspaceId || !sessionId) return;
      invalidatedAtBySession.set(inFlightKey(workspaceId, sessionId, directory), nowMs());
      inFlightBySession.delete(inFlightKey(workspaceId, sessionId, directory));
      workspaceCache(workspaceId).delete(cacheKey(sessionId, directory));
    },

    listWarmSnapshots(input: { workspaceId: string; sessionIds?: string[]; directory?: string | null }) {
      const workspaceId = normalizeId(input.workspaceId);
      const directory = normalizeDirectory(input.directory);
      if (!workspaceId) return [];
      const cache = workspaceCache(workspaceId);
      const sessionIds = input.sessionIds
        ? input.sessionIds.map((value) => normalizeId(value)).filter(Boolean)
        : Array.from(cache.values())
            .filter((entry) => normalizeDirectory(entry.snapshot.directory) === directory)
            .map((entry) => entry.snapshot.sessionId);
      const seen = new Set<string>();
      const snapshots: SessionTranscriptSnapshot[] = [];
      for (const sessionId of sessionIds) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        const limit = resolveDesiredLimit(workspaceId, sessionId, undefined, directory);
        const warm = getWarmSnapshot({ workspaceId, sessionId, limit, directory });
        if (warm) snapshots.push(warm);
      }
      return snapshots;
    },

    getOrLoad(input: SessionTranscriptLoadInput) {
      setDesiredLimit(input.workspaceId, input.sessionId, input.limit, input.directory);
      return ensureLoaded(input);
    },

    prefetchWorkspace(workspaceId: string) {
      return pumpWorkspace(workspaceId);
    },

    debugQueue(workspaceIdRaw: string) {
      const workspaceId = normalizeId(workspaceIdRaw);
      if (!workspaceId) return [];
      return [...(queueByWorkspace.get(workspaceId) ?? [])].map((item) => item.sessionId);
    },

    debugCacheSessionIds(workspaceIdRaw: string) {
      const workspaceId = normalizeId(workspaceIdRaw);
      if (!workspaceId) return [];
      return [...workspaceCache(workspaceId).values()].map((entry) => entry.snapshot.sessionId);
    },
  };
}
