import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RunStatus = "submitted" | "running" | "blocked" | "completed" | "failed" | "aborted";
export type RunKind = "prompt" | "command" | "shell" | "summarize";
export type RunActivityKind = "local_tool" | "assistant_output" | "model_retry" | "idle" | "unknown";
export type RunWaitReason =
  | "running_tool"
  | "model_retry_no_output"
  | "assistant_message_open"
  | "session_idle"
  | "engine_unreachable"
  | "none";

export const ACTIVE_RUN_STATUSES = ["submitted", "running", "blocked"] as const satisfies readonly RunStatus[];

export type RunEngineOwner = {
  engineOwnerId: string | null;
  enginePid: number | null;
  engineStartedAt: number | null;
  engineBaseUrl: string | null;
};

export type RunRecord = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  engineSessionId: string;
  clientMessageId: string | null;
  origin: string | null;
  directory: string;
  kind: RunKind;
  status: RunStatus;
  abortRequested: boolean;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  activityKind: RunActivityKind | null;
  waitReason: RunWaitReason | null;
  lastUsefulProgressAt: number | null;
  retrySince: number | null;
  lastProgressSignature: string | null;
} & RunEngineOwner;

export type RunStore = {
  insert(record: RunRecord): void;
  update(
    workspaceId: string,
    runId: string,
    patch: Partial<Omit<RunRecord, "workspaceId" | "runId">>,
  ): RunRecord | null;
  get(workspaceId: string, runId: string): RunRecord | null;
  latestForConversation(workspaceId: string, conversationId: string): RunRecord | null;
  activeForConversation(workspaceId: string, conversationId: string): RunRecord | null;
  activeForEngineOwner(engineOwnerId: string): RunRecord[];
  activeCreatedBefore(createdBefore: number, limit?: number): RunRecord[];
  migrateWorkspaceId(sourceWorkspaceId: string, targetWorkspaceId: string): RunStoreWorkspaceMigrationResult;
  /**
   * True when the workspace has any run in an active status created at or
   * after `createdSince` (epoch ms). The lower bound keeps a stale record -
   * a run whose engine died before reaching a terminal status - from
   * counting as active work forever.
   */
  hasActiveForWorkspace(workspaceId: string, createdSince: number): boolean;
};

export type RunStoreWorkspaceMigrationResult = {
  migrated: boolean;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  updated: number;
  reason: "migrated" | "invalid_input" | "same_workspace" | "source_missing" | "target_has_records";
};

type RunRow = {
  workspace_id: string;
  conversation_id: string;
  run_id: string;
  engine_session_id: string;
  client_message_id: string | null;
  origin: string | null;
  directory: string;
  kind: string;
  status: string;
  abort_requested: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  engine_owner_id: string | null;
  engine_pid: number | null;
  engine_started_at: number | null;
  engine_base_url: string | null;
  activity_kind: string | null;
  wait_reason: string | null;
  last_useful_progress_at: number | null;
  retry_since: number | null;
  last_progress_signature: string | null;
};

const ACTIVE_RUN_STATUS_SQL_LIST = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ");
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

export const isActiveRunStatus = (status: RunStatus): boolean =>
  (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
export const isTerminalRunStatus = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

function normalizeWorkspaceId(value: string): string {
  return value.trim();
}

function rowToRecord(row: RunRow): RunRecord {
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    engineSessionId: row.engine_session_id,
    clientMessageId: row.client_message_id ?? null,
    origin: row.origin ?? null,
    directory: row.directory,
    kind: row.kind as RunKind,
    status: row.status as RunStatus,
    abortRequested: row.abort_requested === 1,
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    error: row.error,
    engineOwnerId: row.engine_owner_id ?? null,
    enginePid: row.engine_pid === null || row.engine_pid === undefined ? null : Number(row.engine_pid),
    engineStartedAt: row.engine_started_at === null || row.engine_started_at === undefined
      ? null
      : Number(row.engine_started_at),
    engineBaseUrl: row.engine_base_url ?? null,
    activityKind: row.activity_kind as RunActivityKind | null,
    waitReason: row.wait_reason as RunWaitReason | null,
    lastUsefulProgressAt: row.last_useful_progress_at === null || row.last_useful_progress_at === undefined
      ? null
      : Number(row.last_useful_progress_at),
    retrySince: row.retry_since === null || row.retry_since === undefined
      ? null
      : Number(row.retry_since),
    lastProgressSignature: row.last_progress_signature ?? null,
  };
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS conversation_run (
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      engine_session_id TEXT NOT NULL,
      client_message_id TEXT,
      origin TEXT,
      directory TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      abort_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      engine_owner_id TEXT,
      engine_pid INTEGER,
      engine_started_at INTEGER,
      engine_base_url TEXT,
      activity_kind TEXT,
      wait_reason TEXT,
      last_useful_progress_at INTEGER,
      retry_since INTEGER,
      last_progress_signature TEXT,
      PRIMARY KEY (workspace_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_run_conversation_idx
      ON conversation_run (workspace_id, conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS conversation_run_status_idx
      ON conversation_run (workspace_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_run_active_conversation_uidx
      ON conversation_run (workspace_id, conversation_id)
      WHERE status IN (${ACTIVE_RUN_STATUS_SQL_LIST});
  `);
  ensureColumn(db, "conversation_run", "client_message_id", "client_message_id TEXT");
  ensureColumn(db, "conversation_run", "origin", "origin TEXT");
  ensureColumn(db, "conversation_run", "engine_owner_id", "engine_owner_id TEXT");
  ensureColumn(db, "conversation_run", "engine_pid", "engine_pid INTEGER");
  ensureColumn(db, "conversation_run", "engine_started_at", "engine_started_at INTEGER");
  ensureColumn(db, "conversation_run", "engine_base_url", "engine_base_url TEXT");
  ensureColumn(db, "conversation_run", "activity_kind", "activity_kind TEXT");
  ensureColumn(db, "conversation_run", "wait_reason", "wait_reason TEXT");
  ensureColumn(db, "conversation_run", "last_useful_progress_at", "last_useful_progress_at INTEGER");
  ensureColumn(db, "conversation_run", "retry_since", "retry_since INTEGER");
  ensureColumn(db, "conversation_run", "last_progress_signature", "last_progress_signature TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS conversation_run_engine_owner_idx
      ON conversation_run (engine_owner_id, status, engine_started_at);
  `);
  return db;
}

export function createRunStore(options: { dbPath: string }): RunStore {
  const withDb = <T>(fn: (db: Database) => T): T => {
    const db = openDb(options.dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const getSync = (db: Database, workspaceId: string, runId: string): RunRecord | null => {
    const row = db.query<RunRow, [string, string]>(
      `SELECT * FROM conversation_run
       WHERE workspace_id = ?1 AND run_id = ?2
       LIMIT 1`,
    ).get(workspaceId, runId);
    return row ? rowToRecord(row) : null;
  };

  return {
    insert(record) {
      withDb((db) => {
        db.query(
          `INSERT INTO conversation_run (
            workspace_id,
            conversation_id,
            run_id,
            engine_session_id,
            client_message_id,
            origin,
            directory,
            kind,
            status,
            abort_requested,
            created_at,
            started_at,
            completed_at,
            error,
            engine_owner_id,
            engine_pid,
            engine_started_at,
            engine_base_url,
            activity_kind,
            wait_reason,
            last_useful_progress_at,
            retry_since,
            last_progress_signature
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
          `,
        ).run(
          record.workspaceId,
          record.conversationId,
          record.runId,
          record.engineSessionId,
          record.clientMessageId,
          record.origin,
          record.directory,
          record.kind,
          record.status,
          record.abortRequested ? 1 : 0,
          record.createdAt,
          record.startedAt,
          record.completedAt,
          record.error,
          record.engineOwnerId,
          record.enginePid,
          record.engineStartedAt,
          record.engineBaseUrl,
          record.activityKind,
          record.waitReason,
          record.lastUsefulProgressAt,
          record.retrySince,
          record.lastProgressSignature,
        );
      });
    },

    update(workspaceId, runId, patch) {
      return withDb((db) => {
        const current = getSync(db, workspaceId, runId);
        if (!current) return null;
        const next: RunRecord = { ...current, ...patch };
        db.query(
          `UPDATE conversation_run SET
            conversation_id = ?3,
            engine_session_id = ?4,
            client_message_id = ?5,
            origin = ?6,
            directory = ?7,
            kind = ?8,
            status = ?9,
            abort_requested = ?10,
            created_at = ?11,
            started_at = ?12,
            completed_at = ?13,
            error = ?14,
            engine_owner_id = ?15,
            engine_pid = ?16,
            engine_started_at = ?17,
            engine_base_url = ?18,
            activity_kind = ?19,
            wait_reason = ?20,
            last_useful_progress_at = ?21,
            retry_since = ?22,
            last_progress_signature = ?23
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(
          workspaceId,
          runId,
          next.conversationId,
          next.engineSessionId,
          next.clientMessageId,
          next.origin,
          next.directory,
          next.kind,
          next.status,
          next.abortRequested ? 1 : 0,
          next.createdAt,
          next.startedAt,
          next.completedAt,
          next.error,
          next.engineOwnerId,
          next.enginePid,
          next.engineStartedAt,
          next.engineBaseUrl,
          next.activityKind,
          next.waitReason,
          next.lastUsefulProgressAt,
          next.retrySince,
          next.lastProgressSignature,
        );
        return next;
      });
    },

    get(workspaceId, runId) {
      return withDb((db) => getSync(db, workspaceId, runId));
    },

    latestForConversation(workspaceId, conversationId) {
      return withDb((db) => {
        const row = db.query<RunRow, [string, string]>(
          `SELECT * FROM conversation_run
           WHERE workspace_id = ?1 AND conversation_id = ?2
           ORDER BY created_at DESC
           LIMIT 1`,
        ).get(workspaceId, conversationId);
        return row ? rowToRecord(row) : null;
      });
    },

    activeForConversation(workspaceId, conversationId) {
      return withDb((db) => {
        const row = db.query<RunRow, [string, string]>(
          `SELECT * FROM conversation_run
           WHERE workspace_id = ?1
             AND conversation_id = ?2
             AND status IN (${ACTIVE_RUN_STATUS_SQL_LIST})
           ORDER BY created_at DESC
           LIMIT 1`,
        ).get(workspaceId, conversationId);
        return row ? rowToRecord(row) : null;
      });
    },

    activeForEngineOwner(engineOwnerId) {
      return withDb((db) => {
        const row = db.query<RunRow, [string]>(
          `SELECT * FROM conversation_run
           WHERE engine_owner_id = ?1
             AND status IN (${ACTIVE_RUN_STATUS_SQL_LIST})
           ORDER BY created_at ASC`,
        ).all(engineOwnerId);
        return row.map(rowToRecord);
      });
    },

    activeCreatedBefore(createdBefore, limit = 200) {
      const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 10_000) : 200;
      return withDb((db) => {
        const row = db.query<RunRow, [number, number]>(
          `SELECT * FROM conversation_run
           WHERE status IN (${ACTIVE_RUN_STATUS_SQL_LIST})
             AND created_at < ?1
           ORDER BY created_at ASC
           LIMIT ?2`,
        ).all(createdBefore, safeLimit);
        return row.map(rowToRecord);
      });
    },

    migrateWorkspaceId(sourceWorkspaceId, targetWorkspaceId) {
      const source = normalizeWorkspaceId(sourceWorkspaceId);
      const target = normalizeWorkspaceId(targetWorkspaceId);
      const base = {
        sourceWorkspaceId: source,
        targetWorkspaceId: target,
        updated: 0,
      };
      if (!source || !target) {
        return { ...base, migrated: false, reason: "invalid_input" };
      }
      if (source === target) {
        return { ...base, migrated: false, reason: "same_workspace" };
      }

      return withDb((db) => {
        const sourceCount = db.query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM conversation_run WHERE workspace_id = ?1`,
        ).get(source)?.count ?? 0;
        if (sourceCount <= 0) {
          return { ...base, migrated: false, reason: "source_missing" };
        }
        const targetCount = db.query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM conversation_run WHERE workspace_id = ?1`,
        ).get(target)?.count ?? 0;
        if (targetCount > 0) {
          return { ...base, migrated: false, reason: "target_has_records" };
        }

        const result = db.query(
          `UPDATE conversation_run
           SET workspace_id = ?1,
               engine_owner_id = CASE
                 WHEN engine_owner_id = ?2 THEN ?1
                 ELSE engine_owner_id
               END
           WHERE workspace_id = ?2`,
        ).run(target, source);
        return {
          ...base,
          migrated: true,
          updated: Number(result.changes ?? sourceCount),
          reason: "migrated",
        };
      });
    },

    hasActiveForWorkspace(workspaceId, createdSince) {
      return withDb((db) => {
        const row = db.query<{ present: number }, [string, number]>(
          `SELECT 1 AS present FROM conversation_run
           WHERE workspace_id = ?1
             AND status IN (${ACTIVE_RUN_STATUS_SQL_LIST})
             AND created_at >= ?2
           LIMIT 1`,
        ).get(workspaceId, createdSince);
        return Boolean(row);
      });
    },
  };
}
