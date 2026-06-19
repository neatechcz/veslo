import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

export type ConversationRunQueueState = "pending" | "starting" | "submitted" | "failed" | "cancelled";

export type ConversationRunQueueItem = {
  queueItemId: string;
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  directory: string;
  reservedRunId: string;
  clientMessageId: string | null;
  origin: string | null;
  kind: string;
  bodyJson: string;
  state: ConversationRunQueueState;
  activeRunId: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  submittedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

export type ConversationRunQueueStore = {
  enqueue(input: {
    workspaceId: string;
    conversationId: string;
    opencodeSessionId: string;
    directory: string;
    reservedRunId: string;
    clientMessageId?: string | null;
    origin?: string | null;
    kind: string;
    bodyJson: string;
    activeRunId?: string | null;
  }): { item: ConversationRunQueueItem; inserted: boolean; queuePosition: number };
  nextPending(workspaceId: string, conversationId: string): ConversationRunQueueItem | null;
  markStarting(queueItemId: string): ConversationRunQueueItem | null;
  markPending(queueItemId: string, activeRunId?: string | null): ConversationRunQueueItem | null;
  markSubmitted(queueItemId: string): ConversationRunQueueItem | null;
  markFailed(queueItemId: string, error: string): ConversationRunQueueItem | null;
  pendingConversationKeys(): Array<{ workspaceId: string; conversationId: string }>;
};

type QueueRow = {
  queue_item_id: string;
  workspace_id: string;
  conversation_id: string;
  opencode_session_id: string;
  directory: string;
  reserved_run_id: string;
  client_message_id: string | null;
  origin: string | null;
  kind: string;
  body_json: string;
  state: string;
  active_run_id: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  submitted_at: number | null;
  completed_at: number | null;
  error: string | null;
};

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const expandHome = (input: string): string =>
  input === "~" || input.startsWith("~/") || input.startsWith("~\\")
    ? join(homedir(), input.slice(2))
    : input;

export function resolveConversationRunQueueDbPath(options?: { dbPath?: string; dataDir?: string }): string {
  const explicitDb = normalizeText(options?.dbPath) || normalizeText(process.env.VESLO_CONVERSATION_RUN_QUEUE_DB_PATH);
  if (explicitDb) return resolve(expandHome(explicitDb));
  const explicitDir =
    normalizeText(options?.dataDir) ||
    normalizeText(process.env.VESLO_DATA_DIR) ||
    join(homedir(), ".veslo", "veslo-server");
  return join(resolve(expandHome(explicitDir)), "conversations", "run-queue.sqlite");
}

function createDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS conversation_run_queue (
      queue_item_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      opencode_session_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      reserved_run_id TEXT NOT NULL,
      client_message_id TEXT,
      origin TEXT,
      kind TEXT NOT NULL,
      body_json TEXT NOT NULL,
      state TEXT NOT NULL,
      active_run_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      submitted_at INTEGER,
      completed_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS conversation_run_queue_pending_idx
      ON conversation_run_queue (workspace_id, conversation_id, state, created_at, queue_item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_run_queue_client_message_uidx
      ON conversation_run_queue (workspace_id, conversation_id, client_message_id)
      WHERE client_message_id IS NOT NULL AND client_message_id <> '';
  `);
  return db;
}

function rowToItem(row: QueueRow): ConversationRunQueueItem {
  return {
    queueItemId: row.queue_item_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    opencodeSessionId: row.opencode_session_id,
    directory: row.directory,
    reservedRunId: row.reserved_run_id,
    clientMessageId: row.client_message_id,
    origin: row.origin,
    kind: row.kind,
    bodyJson: row.body_json,
    state: row.state as ConversationRunQueueState,
    activeRunId: row.active_run_id,
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    submittedAt: row.submitted_at === null ? null : Number(row.submitted_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    error: row.error,
  };
}

function getSync(db: Database, queueItemId: string): ConversationRunQueueItem | null {
  const row = db.query<QueueRow, [string]>(
    `SELECT * FROM conversation_run_queue WHERE queue_item_id = ?1 LIMIT 1`,
  ).get(queueItemId);
  return row ? rowToItem(row) : null;
}

function queuePositionSync(db: Database, item: ConversationRunQueueItem): number {
  if (item.state !== "pending" && item.state !== "starting") return 0;
  const row = db.query<{ count: number }, [string, string, number, string]>(
    `SELECT COUNT(*) AS count FROM conversation_run_queue
     WHERE workspace_id = ?1
       AND conversation_id = ?2
       AND state IN ('pending', 'starting')
       AND (created_at < ?3 OR (created_at = ?3 AND queue_item_id <= ?4))`,
  ).get(item.workspaceId, item.conversationId, item.createdAt, item.queueItemId);
  return Math.max(1, Number(row?.count ?? 1));
}

export function createConversationRunQueueStore(options?: {
  dbPath?: string;
  dataDir?: string;
  now?: () => number;
}): ConversationRunQueueStore {
  const dbPath = resolveConversationRunQueueDbPath(options);
  const now = options?.now ?? (() => Date.now());
  const withDb = <T>(fn: (db: Database) => T): T => {
    const db = createDatabase(dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  return {
    enqueue(input) {
      return withDb((db) => {
        const workspaceId = normalizeText(input.workspaceId);
        const conversationId = normalizeText(input.conversationId);
        const opencodeSessionId = normalizeText(input.opencodeSessionId);
        const directory = normalizeText(input.directory);
        const reservedRunId = normalizeText(input.reservedRunId);
        const kind = normalizeText(input.kind);
        const bodyJson = normalizeText(input.bodyJson);
        if (!workspaceId || !conversationId || !opencodeSessionId || !directory || !reservedRunId || !kind || !bodyJson) {
          throw new Error("workspaceId, conversationId, opencodeSessionId, directory, reservedRunId, kind, and bodyJson are required");
        }

        const clientMessageId = normalizeText(input.clientMessageId) || null;
        if (clientMessageId) {
          const existing = db.query<QueueRow, [string, string, string]>(
            `SELECT * FROM conversation_run_queue
             WHERE workspace_id = ?1 AND conversation_id = ?2 AND client_message_id = ?3
             LIMIT 1`,
          ).get(workspaceId, conversationId, clientMessageId);
          if (existing) {
            const item = rowToItem(existing);
            return { item, inserted: false, queuePosition: queuePositionSync(db, item) };
          }
        }

        const timestamp = now();
        const queueItemId = `queue_${randomUUID()}`;
        db.query(
          `INSERT INTO conversation_run_queue (
            queue_item_id,
            workspace_id,
            conversation_id,
            opencode_session_id,
            directory,
            reserved_run_id,
            client_message_id,
            origin,
            kind,
            body_json,
            state,
            active_run_id,
            attempts,
            created_at,
            updated_at,
            started_at,
            submitted_at,
            completed_at,
            error
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, 0, ?12, ?12, NULL, NULL, NULL, NULL)`,
        ).run(
          queueItemId,
          workspaceId,
          conversationId,
          opencodeSessionId,
          directory,
          reservedRunId,
          clientMessageId,
          normalizeText(input.origin) || null,
          kind,
          bodyJson,
          normalizeText(input.activeRunId) || null,
          timestamp,
        );
        const item = getSync(db, queueItemId);
        if (!item) throw new Error("failed to enqueue conversation run");
        return { item, inserted: true, queuePosition: queuePositionSync(db, item) };
      });
    },

    nextPending(workspaceId, conversationId) {
      return withDb((db) => {
        const row = db.query<QueueRow, [string, string]>(
          `SELECT * FROM conversation_run_queue
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND state = 'pending'
           ORDER BY created_at ASC, queue_item_id ASC
           LIMIT 1`,
        ).get(workspaceId, conversationId);
        return row ? rowToItem(row) : null;
      });
    },

    markStarting(queueItemId) {
      return withDb((db) => {
        const timestamp = now();
        db.query(
          `UPDATE conversation_run_queue
           SET state = 'starting',
               attempts = attempts + 1,
               started_at = ?2,
               updated_at = ?2,
               error = NULL
           WHERE queue_item_id = ?1 AND state = 'pending'`,
        ).run(queueItemId, timestamp);
        return getSync(db, queueItemId);
      });
    },

    markPending(queueItemId, activeRunId) {
      return withDb((db) => {
        const timestamp = now();
        db.query(
          `UPDATE conversation_run_queue
           SET state = 'pending',
               active_run_id = ?2,
               started_at = NULL,
               updated_at = ?3
           WHERE queue_item_id = ?1 AND state = 'starting'`,
        ).run(queueItemId, normalizeText(activeRunId) || null, timestamp);
        return getSync(db, queueItemId);
      });
    },

    markSubmitted(queueItemId) {
      return withDb((db) => {
        const timestamp = now();
        db.query(
          `UPDATE conversation_run_queue
           SET state = 'submitted',
               submitted_at = ?2,
               completed_at = ?2,
               updated_at = ?2
           WHERE queue_item_id = ?1`,
        ).run(queueItemId, timestamp);
        return getSync(db, queueItemId);
      });
    },

    markFailed(queueItemId, error) {
      return withDb((db) => {
        const timestamp = now();
        db.query(
          `UPDATE conversation_run_queue
           SET state = 'failed',
               error = ?2,
               completed_at = ?3,
               updated_at = ?3
           WHERE queue_item_id = ?1`,
        ).run(queueItemId, normalizeText(error) || "queued run failed", timestamp);
        return getSync(db, queueItemId);
      });
    },

    pendingConversationKeys() {
      return withDb((db) =>
        db.query<{ workspace_id: string; conversation_id: string }, []>(
          `SELECT DISTINCT workspace_id, conversation_id FROM conversation_run_queue
           WHERE state = 'pending'
           ORDER BY workspace_id ASC, conversation_id ASC`,
        ).all().map((row) => ({
          workspaceId: row.workspace_id,
          conversationId: row.conversation_id,
        })),
      );
    },
  };
}
