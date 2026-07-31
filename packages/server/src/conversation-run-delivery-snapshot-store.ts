import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

export const RUN_DELIVERY_SNAPSHOT_MAX_TERMINAL_PER_WORKSPACE = 64;
/** Bound diagnostics for runs that never reach a terminal lifecycle event. */
export const RUN_DELIVERY_SNAPSHOT_MAX_ACTIVE_PER_WORKSPACE = 256;
export const RUN_DELIVERY_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const RUN_DELIVERY_SNAPSHOT_MAX_BYTES = 16 * 1_024;
/** Diagnostics fail fast on a competing SQLite writer instead of delaying send. */
export const RUN_DELIVERY_SNAPSHOT_BUSY_TIMEOUT_MS = 50;

export const DELIVERY_REJECTION_REASON_CODES = [
  "missing_binding_envelope",
  "binding_workspace_mismatch",
  "unknown_session",
  "stale_generation",
  "background_workspace_policy",
  "duplicate_event",
  "invalid_event_shape",
  "other_allowlisted_rejection",
] as const;

export type DeliveryRejectionReasonCode = typeof DELIVERY_REJECTION_REASON_CODES[number];
export type DeliveryTerminalLifecycle = "completed" | "failed" | "aborted" | "unresolved";
export type DeliveryCanonicalRecovery = "not_requested" | "recovered" | "unavailable" | "failed";
export type DeliveryHydration = "not_attempted" | "adopted" | "skipped" | "failed";
export type DeliveryPresentation = "visible_output" | "hidden_progress" | "no_visible_output" | "unknown";

export type RunDeliverySnapshot = {
  schemaVersion: 1;
  workspaceId: string;
  conversationId: string;
  runId: string;
  clientMessageId: string | null;
  traceId: string | null;
  opencodeSessionId: string | null;
  engineOwnerId: string | null;
  /** Safe digest of the complete process generation; it never exposes its URL. */
  engineGenerationId: string | null;
  directoryInstanceEpoch: number | null;
  admission: { acceptedAt: string; dispatchObservedAt?: string };
  router: {
    sessionBoundEventCount: number;
    firstObservedAt?: string;
    lastObservedAt?: string;
  };
  app?: {
    acceptedEventCount: number;
    rejectedEventCount: number;
    rejectedByReason: Partial<Record<DeliveryRejectionReasonCode, number>>;
    storeCommitCount: number;
    firstObservedAt?: string;
    lastObservedAt?: string;
    reportedAt: string;
  };
  terminal?: {
    lifecycle: DeliveryTerminalLifecycle;
    canonicalRecovery: DeliveryCanonicalRecovery;
    hydration: DeliveryHydration;
    presentation: DeliveryPresentation;
    reportedAt: string;
  };
  recording: "recorded" | "incomplete";
  recordedAt: string;
};

export type RunDeliverySnapshotStore = {
  create(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    clientMessageId?: string | null;
    traceId?: string | null;
    opencodeSessionId?: string | null;
    acceptedAt?: string;
  }): RunDeliverySnapshot;
  get(input: { workspaceId: string; conversationId: string; runId: string }): RunDeliverySnapshot | null;
  observeRouter(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    opencodeSessionId: string;
    engineOwnerId: string;
    enginePid: number;
    engineStartedAt: number;
    engineBaseUrl: string;
    directoryInstanceEpoch?: number | null;
    eventCount?: number;
    firstObservedAt?: string;
    lastObservedAt?: string;
    observedAt?: string;
  }): RunDeliverySnapshot | null;
  reportApp(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    acceptedEventCount: number;
    rejectedByReason?: Partial<Record<DeliveryRejectionReasonCode, number>>;
    storeCommitCount: number;
    firstObservedAt?: string;
    lastObservedAt?: string;
    reportedAt?: string;
  }): RunDeliverySnapshot | null;
  reportTerminal(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    lifecycle?: DeliveryTerminalLifecycle;
    canonicalRecovery?: DeliveryCanonicalRecovery;
    hydration?: DeliveryHydration;
    presentation?: DeliveryPresentation;
    reportedAt?: string;
  }): RunDeliverySnapshot | null;
  markIncomplete(input: { workspaceId: string; conversationId: string; runId: string }): RunDeliverySnapshot | null;
};

type SnapshotRow = {
  workspace_id: string;
  conversation_id: string;
  run_id: string;
  snapshot_json: string;
  terminal_at: number | null;
  updated_at: number;
};

const reasonCodeSet = new Set<string>(DELIVERY_REJECTION_REASON_CODES);
const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";
const nullableText = (value: string | null | undefined) => normalizeText(value) || null;
const isoNow = (now: () => number) => new Date(now()).toISOString();
const nonNegativeInt = (value: number | null | undefined) =>
  Number.isFinite(value ?? NaN) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value ?? 0))) : 0;

function engineGenerationId(input: {
  engineOwnerId: string;
  enginePid: number;
  engineStartedAt: number;
  engineBaseUrl: string;
}): string | null {
  const engineOwnerId = normalizeText(input.engineOwnerId);
  const engineBaseUrl = normalizeText(input.engineBaseUrl);
  if (
    !engineOwnerId ||
    !engineBaseUrl ||
    !Number.isSafeInteger(input.enginePid) || input.enginePid <= 0 ||
    !Number.isSafeInteger(input.engineStartedAt) || input.engineStartedAt <= 0
  ) return null;
  return createHash("sha256")
    .update(`${engineOwnerId}\u0000${input.enginePid}\u0000${input.engineStartedAt}\u0000${engineBaseUrl}`)
    .digest("hex");
}

const expandHome = (input: string) =>
  input === "~" || input.startsWith("~/") || input.startsWith("~\\")
    ? join(homedir(), input.slice(2))
    : input;

export function resolveConversationRunDeliverySnapshotDbPath(options?: { dbPath?: string; dataDir?: string }): string {
  const explicitDb = normalizeText(options?.dbPath) || normalizeText(process.env.VESLO_CONVERSATION_RUN_DELIVERY_SNAPSHOT_DB_PATH);
  if (explicitDb) return resolve(expandHome(explicitDb));
  const dataDir = normalizeText(options?.dataDir) || normalizeText(process.env.VESLO_DATA_DIR) || join(homedir(), ".veslo", "veslo-server");
  return join(resolve(expandHome(dataDir)), "conversations", "run-delivery-snapshots.sqlite");
}

function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA busy_timeout = ${RUN_DELIVERY_SNAPSHOT_BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS conversation_run_delivery_snapshot (
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      terminal_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, conversation_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_run_delivery_snapshot_retention_idx
      ON conversation_run_delivery_snapshot (workspace_id, terminal_at, updated_at);
  `);
  return db;
}

function parseSnapshot(row: SnapshotRow): RunDeliverySnapshot | null {
  try {
    const value = JSON.parse(row.snapshot_json) as RunDeliverySnapshot;
    return value?.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

function readSnapshot(db: Database, workspaceId: string, conversationId: string, runId: string): SnapshotRow | null {
  return db.query<SnapshotRow, [string, string, string]>(`
    SELECT workspace_id, conversation_id, run_id, snapshot_json, terminal_at, updated_at
    FROM conversation_run_delivery_snapshot
    WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3
    LIMIT 1
  `).get(workspaceId, conversationId, runId) ?? null;
}

function assertIdentity(input: { workspaceId: string; conversationId: string; runId: string }) {
  const workspaceId = normalizeText(input.workspaceId);
  const conversationId = normalizeText(input.conversationId);
  const runId = normalizeText(input.runId);
  if (!workspaceId || !conversationId || !runId) {
    throw new Error("workspaceId, conversationId, and runId are required");
  }
  return { workspaceId, conversationId, runId };
}

function serialize(snapshot: RunDeliverySnapshot): string {
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > RUN_DELIVERY_SNAPSHOT_MAX_BYTES) {
    throw new Error("run delivery snapshot exceeds the maximum size");
  }
  return serialized;
}

function prune(db: Database, now: number, workspaceId: string): void {
  db.query(`DELETE FROM conversation_run_delivery_snapshot WHERE updated_at < ?1`).run(now - RUN_DELIVERY_SNAPSHOT_TTL_MS);
  const terminalCount = db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM conversation_run_delivery_snapshot
    WHERE workspace_id = ?1 AND terminal_at IS NOT NULL
  `).get(workspaceId)?.count ?? 0;
  const excess = terminalCount - RUN_DELIVERY_SNAPSHOT_MAX_TERMINAL_PER_WORKSPACE;
  if (excess > 0) {
    db.query(`
      DELETE FROM conversation_run_delivery_snapshot
      WHERE rowid IN (
        SELECT rowid FROM conversation_run_delivery_snapshot
        WHERE workspace_id = ?1 AND terminal_at IS NOT NULL
        ORDER BY terminal_at ASC, updated_at ASC
        LIMIT ?2
      )
    `).run(workspaceId, excess);
  }
  const activeCount = db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM conversation_run_delivery_snapshot
    WHERE workspace_id = ?1 AND terminal_at IS NULL
  `).get(workspaceId)?.count ?? 0;
  const activeExcess = activeCount - RUN_DELIVERY_SNAPSHOT_MAX_ACTIVE_PER_WORKSPACE;
  if (activeExcess > 0) {
    db.query(`
      DELETE FROM conversation_run_delivery_snapshot
      WHERE rowid IN (
        SELECT rowid FROM conversation_run_delivery_snapshot
        WHERE workspace_id = ?1 AND terminal_at IS NULL
        ORDER BY updated_at ASC, rowid ASC
        LIMIT ?2
      )
    `).run(workspaceId, activeExcess);
  }
}

function mergeSnapshot(db: Database, input: { workspaceId: string; conversationId: string; runId: string }, now: number, mutate: (snapshot: RunDeliverySnapshot) => void): RunDeliverySnapshot | null {
  let result: RunDeliverySnapshot | null = null;
  db.transaction(() => {
    const row = readSnapshot(db, input.workspaceId, input.conversationId, input.runId);
    if (!row) return;
    const snapshot = parseSnapshot(row);
    if (!snapshot) return;
    mutate(snapshot);
    snapshot.recordedAt = new Date(now).toISOString();
    const terminalAt = snapshot.terminal ? now : null;
    db.query(`
      UPDATE conversation_run_delivery_snapshot
      SET snapshot_json = ?4, terminal_at = COALESCE(?5, terminal_at), updated_at = ?6
      WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3
    `).run(input.workspaceId, input.conversationId, input.runId, serialize(snapshot), terminalAt, now);
    prune(db, now, input.workspaceId);
    result = snapshot;
  }).immediate();
  return result;
}

export function createConversationRunDeliverySnapshotStore(options?: {
  dbPath?: string;
  dataDir?: string;
  now?: () => number;
}): RunDeliverySnapshotStore {
  const dbPath = resolveConversationRunDeliverySnapshotDbPath(options);
  const now = options?.now ?? (() => Date.now());
  const withDb = <T>(work: (db: Database) => T): T => {
    const db = openDatabase(dbPath);
    try {
      return work(db);
    } finally {
      db.close();
    }
  };

  return {
    create(input) {
      const identity = assertIdentity(input);
      return withDb((db) => {
        let result: RunDeliverySnapshot | null = null;
        db.transaction(() => {
          const existing = readSnapshot(db, identity.workspaceId, identity.conversationId, identity.runId);
          if (existing) {
            const snapshot = parseSnapshot(existing);
            if (!snapshot) throw new Error("stored run delivery snapshot is invalid");
            result = snapshot;
            return;
          }
          const acceptedAt = normalizeText(input.acceptedAt) || isoNow(now);
          const snapshot: RunDeliverySnapshot = {
            schemaVersion: 1,
            ...identity,
            clientMessageId: nullableText(input.clientMessageId),
            traceId: nullableText(input.traceId),
            opencodeSessionId: nullableText(input.opencodeSessionId),
            engineOwnerId: null,
            engineGenerationId: null,
            directoryInstanceEpoch: null,
            admission: { acceptedAt },
            router: { sessionBoundEventCount: 0 },
            recording: "recorded",
            recordedAt: acceptedAt,
          };
          const timestamp = now();
          db.query(`
            INSERT INTO conversation_run_delivery_snapshot (
              workspace_id, conversation_id, run_id, snapshot_json, terminal_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, NULL, ?5)
          `).run(identity.workspaceId, identity.conversationId, identity.runId, serialize(snapshot), timestamp);
          prune(db, timestamp, identity.workspaceId);
          result = snapshot;
        }).immediate();
        if (!result) throw new Error("failed to create run delivery snapshot");
        return result;
      });
    },

    get(input) {
      const identity = assertIdentity(input);
      return withDb((db) => {
        const row = readSnapshot(db, identity.workspaceId, identity.conversationId, identity.runId);
        if (!row || row.updated_at < now() - RUN_DELIVERY_SNAPSHOT_TTL_MS) return null;
        return parseSnapshot(row);
      });
    },

    observeRouter(input) {
      const identity = assertIdentity(input);
      const opencodeSessionId = normalizeText(input.opencodeSessionId);
      if (!opencodeSessionId) throw new Error("opencodeSessionId is required");
      const generationId = engineGenerationId(input);
      if (!generationId) throw new Error("a complete engine generation is required");
      return withDb((db) => mergeSnapshot(db, identity, now(), (snapshot) => {
        if (snapshot.opencodeSessionId && snapshot.opencodeSessionId !== opencodeSessionId) {
          snapshot.recording = "incomplete";
          return;
        }
        if (snapshot.engineGenerationId && snapshot.engineGenerationId !== generationId) {
          snapshot.recording = "incomplete";
          return;
        }
        snapshot.opencodeSessionId = opencodeSessionId;
        snapshot.engineOwnerId = normalizeText(input.engineOwnerId);
        snapshot.engineGenerationId = generationId;
        const epoch = input.directoryInstanceEpoch;
        if (typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0) {
          snapshot.directoryInstanceEpoch = epoch;
        }
        const observedAt = normalizeText(input.observedAt) || isoNow(now);
        const firstObservedAt = normalizeText(input.firstObservedAt) || observedAt;
        const lastObservedAt = normalizeText(input.lastObservedAt) || observedAt;
        snapshot.admission.dispatchObservedAt ??= firstObservedAt;
        const eventCount = nonNegativeInt(input.eventCount ?? 1);
        snapshot.router.sessionBoundEventCount = nonNegativeInt(snapshot.router.sessionBoundEventCount + eventCount);
        snapshot.router.firstObservedAt ??= firstObservedAt;
        snapshot.router.lastObservedAt = lastObservedAt;
      }));
    },

    reportApp(input) {
      const identity = assertIdentity(input);
      return withDb((db) => mergeSnapshot(db, identity, now(), (snapshot) => {
        const rejectedByReason: Partial<Record<DeliveryRejectionReasonCode, number>> = {};
        for (const [reason, count] of Object.entries(input.rejectedByReason ?? {})) {
          if (!reasonCodeSet.has(reason)) continue;
          const normalized = nonNegativeInt(count);
          if (normalized > 0) rejectedByReason[reason as DeliveryRejectionReasonCode] = normalized;
        }
        snapshot.app = {
          acceptedEventCount: nonNegativeInt(input.acceptedEventCount),
          rejectedEventCount: Object.values(rejectedByReason).reduce((total, value) => total + value, 0),
          rejectedByReason,
          storeCommitCount: nonNegativeInt(input.storeCommitCount),
          ...(normalizeText(input.firstObservedAt) ? { firstObservedAt: normalizeText(input.firstObservedAt) } : {}),
          ...(normalizeText(input.lastObservedAt) ? { lastObservedAt: normalizeText(input.lastObservedAt) } : {}),
          reportedAt: normalizeText(input.reportedAt) || isoNow(now),
        };
      }));
    },

    reportTerminal(input) {
      const identity = assertIdentity(input);
      return withDb((db) => mergeSnapshot(db, identity, now(), (snapshot) => {
        snapshot.terminal = {
          lifecycle: input.lifecycle ?? snapshot.terminal?.lifecycle ?? "unresolved",
          canonicalRecovery: input.canonicalRecovery ?? snapshot.terminal?.canonicalRecovery ?? "not_requested",
          hydration: input.hydration ?? snapshot.terminal?.hydration ?? "not_attempted",
          presentation: input.presentation ?? snapshot.terminal?.presentation ?? "unknown",
          reportedAt: normalizeText(input.reportedAt) || isoNow(now),
        };
      }));
    },

    markIncomplete(input) {
      const identity = assertIdentity(input);
      return withDb((db) => mergeSnapshot(db, identity, now(), (snapshot) => {
        snapshot.recording = "incomplete";
      }));
    },
  };
}
