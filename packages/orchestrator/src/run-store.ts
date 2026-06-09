import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RunStatus = "submitted" | "running" | "blocked" | "completed" | "failed" | "aborted";
export type RunKind = "prompt" | "command" | "shell" | "summarize";

export const ACTIVE_RUN_STATUSES = ["submitted", "running", "blocked"] as const satisfies readonly RunStatus[];

export type RunRecord = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  engineSessionId: string;
  directory: string;
  kind: RunKind;
  status: RunStatus;
  abortRequested: boolean;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

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
  /**
   * True when the workspace has any run in an active status created at or
   * after `createdSince` (epoch ms). The lower bound keeps a stale record -
   * a run whose engine died before reaching a terminal status - from
   * counting as active work forever.
   */
  hasActiveForWorkspace(workspaceId: string, createdSince: number): boolean;
};

type RunRow = {
  workspace_id: string;
  conversation_id: string;
  run_id: string;
  engine_session_id: string;
  directory: string;
  kind: string;
  status: string;
  abort_requested: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
};

const ACTIVE_RUN_STATUS_SQL_LIST = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ");
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

export const isActiveRunStatus = (status: RunStatus): boolean =>
  (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
export const isTerminalRunStatus = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

function rowToRecord(row: RunRow): RunRecord {
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    engineSessionId: row.engine_session_id,
    directory: row.directory,
    kind: row.kind as RunKind,
    status: row.status as RunStatus,
    abortRequested: row.abort_requested === 1,
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    error: row.error,
  };
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
      directory TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      abort_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
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
            directory,
            kind,
            status,
            abort_requested,
            created_at,
            started_at,
            completed_at,
            error
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          `,
        ).run(
          record.workspaceId,
          record.conversationId,
          record.runId,
          record.engineSessionId,
          record.directory,
          record.kind,
          record.status,
          record.abortRequested ? 1 : 0,
          record.createdAt,
          record.startedAt,
          record.completedAt,
          record.error,
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
            directory = ?5,
            kind = ?6,
            status = ?7,
            abort_requested = ?8,
            created_at = ?9,
            started_at = ?10,
            completed_at = ?11,
            error = ?12
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(
          workspaceId,
          runId,
          next.conversationId,
          next.engineSessionId,
          next.directory,
          next.kind,
          next.status,
          next.abortRequested ? 1 : 0,
          next.createdAt,
          next.startedAt,
          next.completedAt,
          next.error,
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
