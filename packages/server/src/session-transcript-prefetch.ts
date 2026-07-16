import type { ConversationReadDiagnostic } from "./conversation-read-store.js";
import { normalizeConversationDirectoryKey } from "./conversation-binding-store.js";

export type SessionTranscriptSnapshot = {
  workspaceId: string;
  sessionId: string;
  directory?: string;
  conversationId?: string;
  opencodeSessionId?: string;
  limit: number;
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
  fetchedAt: number;
  staleAt: number;
  source?: "sqlite" | "unavailable";
  diagnostic?: ConversationReadDiagnostic;
};

/**
 * The cache stores this bounded source snapshot. Public callers receive a
 * display-limited `SessionTranscriptSnapshot` view derived from it.
 */
export type SessionTranscriptSourceSnapshot = SessionTranscriptSnapshot;

export type SessionTranscriptCacheOutcome = "cold" | "join" | "warm";

export type SessionTranscriptSourceLoadResult = {
  snapshot: SessionTranscriptSourceSnapshot;
  outcome: SessionTranscriptCacheOutcome;
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
  conversationId?: string;
  opencodeSessionId?: string;
  messages: unknown[];
  partsByMessageId?: Record<string, unknown[]>;
  fetchedAt?: number;
  staleAt?: number;
  source?: "sqlite" | "unavailable";
  diagnostic?: ConversationReadDiagnostic;
};

export type SessionTranscriptPrefetchInterest = {
  workspaceId: string;
  clickedSessionId?: string | null;
  selectedSessionId?: string | null;
  clickedSession?: SessionTranscriptPrefetchSessionRef | null;
  selectedSession?: SessionTranscriptPrefetchSessionRef | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
  loadedTopLevelSessions?: SessionTranscriptPrefetchSessionRef[];
  expandedSubagentSessions?: SessionTranscriptPrefetchSessionRef[];
  directory?: string | null;
  sessionDirectoriesById?: Record<string, string | null | undefined>;
  limit?: number;
};

export type SessionTranscriptPrefetchSessionRef = {
  sessionId: string;
  directory?: string | null;
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
  sourceLimit?: number;
  staleTtlMs?: number;
  autoPrefetchOnInterest?: boolean;
};

type CacheEntry = {
  snapshot: SessionTranscriptSnapshot;
  lastAccessedAt: number;
  byteSize: number;
};

type InFlightLoad = {
  promise: Promise<SessionTranscriptSourceSnapshot>;
};

type QueueItem = {
  sessionId: string;
  directory: string;
};

const DEFAULT_LIMIT = 140;
const DEFAULT_SOURCE_LIMIT = 200;
const DEFAULT_STALE_TTL_MS = 20_000;
const DEFAULT_MAX_ENTRIES_PER_WORKSPACE = 24;
const DEFAULT_MAX_BYTES_PER_WORKSPACE = 16 * 1024 * 1024;

const normalizeId = (value: string | null | undefined) => value?.trim() ?? "";

const nowMs = () => Date.now();

const normalizeDirectory = (value: string | null | undefined) =>
  normalizeConversationDirectoryKey(value);

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

const messageIdForSnapshot = (message: unknown) => {
  if (!message || typeof message !== "object") return "";
  const record = message as {
    id?: unknown;
    info?: { id?: unknown } | null;
  };
  const infoId = normalizeId(record.info?.id as string | null | undefined);
  if (infoId) return infoId;
  return normalizeId(record.id as string | null | undefined);
};

export function createSessionTranscriptDisplayView(
  source: SessionTranscriptSourceSnapshot,
  requestedLimit: number,
): SessionTranscriptSnapshot {
  const limit = toPositiveInt(requestedLimit, DEFAULT_LIMIT);
  const messages = source.messages.length > limit
    ? source.messages.slice(source.messages.length - limit)
    : [...source.messages];
  const messageIds = new Set(messages.map(messageIdForSnapshot).filter(Boolean));
  const partsByMessageId: Record<string, unknown[]> = {};
  for (const [messageId, parts] of Object.entries(source.partsByMessageId)) {
    if (!messageIds.has(messageId)) continue;
    partsByMessageId[messageId] = parts;
  }
  return {
    ...source,
    limit,
    messages,
    partsByMessageId,
  };
}

export function createSessionTranscriptPrefetchStore(options: SessionTranscriptPrefetchOptions) {
  const maxEntriesPerWorkspace = toPositiveInt(options.maxEntriesPerWorkspace, DEFAULT_MAX_ENTRIES_PER_WORKSPACE);
  const maxBytesPerWorkspace = toPositiveInt(options.maxBytesPerWorkspace, DEFAULT_MAX_BYTES_PER_WORKSPACE);
  const defaultLimit = toPositiveInt(options.defaultLimit, DEFAULT_LIMIT);
  const sourceLimit = toPositiveInt(options.sourceLimit, DEFAULT_SOURCE_LIMIT);
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

  const setCachedSnapshot = (snapshot: SessionTranscriptSourceSnapshot, directory?: string | null) => {
    const cache = workspaceCache(snapshot.workspaceId);
    cache.set(cacheKey(snapshot.sessionId, directory ?? snapshot.directory), {
      snapshot,
      lastAccessedAt: nowMs(),
      byteSize: estimateSnapshotBytes(snapshot),
    });
    evictWorkspaceCacheIfNeeded(snapshot.workspaceId);
  };

  const getWarmSourceSnapshot = (input: {
    workspaceId: string;
    sessionId: string;
    directory?: string | null;
  }) => {
    const workspaceId = normalizeId(input.workspaceId);
    const sessionId = normalizeId(input.sessionId);
    const directory = normalizeDirectory(input.directory);
    if (!workspaceId || !sessionId) return null;
    const cache = workspaceCache(workspaceId);
    const entry = cache.get(cacheKey(sessionId, directory));
    if (!entry) return null;
    if (!snapshotIsWarm(entry.snapshot)) return null;
    touchCacheEntry(workspaceId, sessionId, directory);
    return entry.snapshot;
  };

  const getWarmSnapshot = (input: {
    workspaceId: string;
    sessionId: string;
    limit?: number;
    directory?: string | null;
  }) => {
    const source = getWarmSourceSnapshot(input);
    if (!source) return null;
    return createSessionTranscriptDisplayView(source, toPositiveInt(input.limit, defaultLimit));
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
    const refDirectoriesBySession = new Map<string, Set<string>>();
    const effectiveRefDirectory = (sessionId: string, directory: string | null | undefined) =>
      normalizeDirectory(directory) || directories.get(sessionId) || defaultDirectory;
    const rememberRefDirectory = (ref: SessionTranscriptPrefetchSessionRef | null | undefined) => {
      if (!ref || typeof ref !== "object") return;
      const sessionId = normalizeId(ref.sessionId);
      if (!sessionId) return;
      const directory = effectiveRefDirectory(sessionId, ref.directory);
      if (!directory) return;
      const refs = refDirectoriesBySession.get(sessionId) ?? new Set<string>();
      refs.add(directory);
      refDirectoriesBySession.set(sessionId, refs);
    };
    rememberRefDirectory(input.clickedSession);
    rememberRefDirectory(input.selectedSession);
    for (const value of input.expandedSubagentSessions ?? []) rememberRefDirectory(value);
    for (const value of input.loadedTopLevelSessions ?? []) rememberRefDirectory(value);
    const legacyDirectoryFor = (sessionId: string): string | null => {
      const refDirectories = refDirectoriesBySession.get(sessionId);
      if (refDirectories?.size === 1) {
        return refDirectories.values().next().value ?? "";
      }
      if (refDirectories && refDirectories.size > 1) return null;
      return directories.get(sessionId) ?? defaultDirectory;
    };
    const pushItem = (sessionId: string, directory: string) => {
      const item = { sessionId, directory };
      const key = queueItemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      ordered.push(item);
    };
    const push = (value: string | null | undefined) => {
      const sessionId = normalizeId(value);
      if (!sessionId) return;
      const directory = legacyDirectoryFor(sessionId);
      if (directory === null) return;
      pushItem(sessionId, directory);
    };
    const pushRef = (ref: SessionTranscriptPrefetchSessionRef | null | undefined) => {
      if (!ref || typeof ref !== "object") return;
      const sessionId = normalizeId(ref.sessionId);
      if (!sessionId) return;
      pushItem(sessionId, effectiveRefDirectory(sessionId, ref.directory));
    };

    pushRef(input.clickedSession);
    push(input.clickedSessionId);
    pushRef(input.selectedSession);
    push(input.selectedSessionId);
    for (const value of input.expandedSubagentSessions ?? []) pushRef(value);
    for (const value of input.expandedSubagentSessionIds) push(value);
    for (const value of input.loadedTopLevelSessions ?? []) pushRef(value);
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

  const getOrLoadSource = async (input: SessionTranscriptLoadInput): Promise<SessionTranscriptSourceLoadResult> => {
    const workspaceId = normalizeId(input.workspaceId);
    const sessionId = normalizeId(input.sessionId);
    const directory = normalizeDirectory(input.directory);
    if (!workspaceId || !sessionId) {
      throw new Error("workspaceId and sessionId are required");
    }

    const warm = getWarmSourceSnapshot({ workspaceId, sessionId, directory });
    if (warm) return { snapshot: warm, outcome: "warm" };

    const dedupeKey = inFlightKey(workspaceId, sessionId, directory);
    const existing = inFlightBySession.get(dedupeKey);
    if (existing) {
      return { snapshot: await existing.promise, outcome: "join" };
    }

    const loadStartedAt = nowMs();
    const run = (async () => {
      const raw = await options.loadTranscript({
        workspaceId,
        sessionId,
        limit: sourceLimit,
        directory: directory || undefined,
      });
      const fetchedAt = Number.isFinite(raw.fetchedAt) ? Math.floor(raw.fetchedAt as number) : nowMs();
      const staleAt = Number.isFinite(raw.staleAt) && (raw.staleAt as number) > fetchedAt
        ? Math.floor(raw.staleAt as number)
        : fetchedAt + staleTtlMs;
      const canonicalSessionId = normalizeId(raw.opencodeSessionId) || normalizeId(raw.sessionId) || sessionId;
      const snapshot: SessionTranscriptSourceSnapshot = {
        workspaceId,
        sessionId: canonicalSessionId,
        ...(directory ? { directory } : {}),
        ...(typeof raw.conversationId === "string" && raw.conversationId.trim()
          ? { conversationId: raw.conversationId.trim() }
          : {}),
        ...(typeof raw.opencodeSessionId === "string" && raw.opencodeSessionId.trim()
          ? { opencodeSessionId: raw.opencodeSessionId.trim() }
          : {}),
        limit: sourceLimit,
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        partsByMessageId: sanitizePartsByMessageId(raw.partsByMessageId),
        fetchedAt,
        staleAt,
        source: raw.source,
        ...(raw.diagnostic ? { diagnostic: raw.diagnostic } : {}),
      };
      const invalidatedAt = invalidatedAtBySession.get(dedupeKey) ?? 0;
      if (snapshot.source !== "unavailable" && invalidatedAt <= loadStartedAt) {
        setCachedSnapshot(snapshot, directory);
      }
      removeFromQueue(workspaceId, sessionId, directory);
      return snapshot;
    })();

    inFlightBySession.set(dedupeKey, { promise: run });
    try {
      return { snapshot: await run, outcome: "cold" };
    } finally {
      if (inFlightBySession.get(dedupeKey)?.promise === run) {
        inFlightBySession.delete(dedupeKey);
      }
    }
  };

  const getOrLoad = async (input: SessionTranscriptLoadInput) => {
    const workspaceId = normalizeId(input.workspaceId);
    const sessionId = normalizeId(input.sessionId);
    const directory = normalizeDirectory(input.directory);
    const displayLimit = toPositiveInt(input.limit, defaultLimit);
    setDesiredLimit(workspaceId, sessionId, displayLimit, directory);
    const { snapshot } = await getOrLoadSource({
      workspaceId,
      sessionId,
      limit: displayLimit,
      directory,
    });
    return createSessionTranscriptDisplayView(snapshot, displayLimit);
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
          await getOrLoadSource({ workspaceId, sessionId, limit, directory: directory || undefined });
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

    getWarmSourceSnapshot,

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

    getOrLoad,

    getOrLoadSource,

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
