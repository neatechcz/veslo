import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveVesloDataDir } from "./audit.js";

type ConversationSubmitAttemptStatus =
  | "started"
  | "materialized"
  | "completed"
  | "blocked"
  | "failed";

export type ConversationSubmitAttempt = {
  workspaceId: string;
  clientMessageId: string;
  requestHash: string;
  status: ConversationSubmitAttemptStatus;
  conversationId: string | null;
  opencodeSessionId: string | null;
  runId: string | null;
  queueItemId: string | null;
  resultJson: string | null;
  createdAt: number;
  updatedAt: number;
};

type ConversationSubmitAttemptClaimResult = {
  attempt: ConversationSubmitAttempt;
  inserted: boolean;
  conflict: boolean;
};

export type ConversationSubmitAttemptStore = {
  claim(input: {
    workspaceId: string;
    clientMessageId: string;
    requestHash: string;
  }): ConversationSubmitAttemptClaimResult;
  update(input: {
    workspaceId: string;
    clientMessageId: string;
    status: ConversationSubmitAttemptStatus;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    runId?: string | null;
    queueItemId?: string | null;
    resultJson?: string | null;
  }): ConversationSubmitAttempt;
  get(workspaceId: string, clientMessageId: string): ConversationSubmitAttempt | null;
};

type AttemptRow = {
  workspace_id: string;
  client_message_id: string;
  request_hash: string;
  status: string;
  conversation_id: string | null;
  opencode_session_id: string | null;
  run_id: string | null;
  queue_item_id: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
};

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const normalizeNullableText = (value: string | null | undefined) => normalizeText(value) || null;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveConversationSubmitAttemptDbPath(options?: {
  dbPath?: string;
  dataDir?: string;
}): string {
  const explicitDb = normalizeText(options?.dbPath) || normalizeText(process.env.VESLO_CONVERSATION_SUBMIT_ATTEMPTS_DB_PATH);
  if (explicitDb) return resolve(expandHome(explicitDb));

  const explicitDir =
    normalizeText(process.env.VESLO_CONVERSATION_SUBMIT_ATTEMPTS_DIR) ||
    normalizeText(options?.dataDir) ||
    resolveVesloDataDir();
  return join(resolve(expandHome(explicitDir)), "conversations", "submit-attempts.sqlite");
}

function createDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS conversation_submit_attempt (
      workspace_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      conversation_id TEXT,
      opencode_session_id TEXT,
      run_id TEXT,
      queue_item_id TEXT,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, client_message_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_submit_attempt_updated_idx
      ON conversation_submit_attempt (updated_at);
  `);
  return db;
}

function rowToAttempt(row: AttemptRow): ConversationSubmitAttempt {
  return {
    workspaceId: row.workspace_id,
    clientMessageId: row.client_message_id,
    requestHash: row.request_hash,
    status: row.status as ConversationSubmitAttemptStatus,
    conversationId: row.conversation_id,
    opencodeSessionId: row.opencode_session_id,
    runId: row.run_id,
    queueItemId: row.queue_item_id,
    resultJson: row.result_json,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function getSync(db: Database, workspaceId: string, clientMessageId: string): ConversationSubmitAttempt | null {
  const row = db.query<AttemptRow, [string, string]>(
    `SELECT * FROM conversation_submit_attempt
     WHERE workspace_id = ?1 AND client_message_id = ?2
     LIMIT 1`,
  ).get(workspaceId, clientMessageId);
  return row ? rowToAttempt(row) : null;
}

export function createConversationSubmitAttemptStore(options?: {
  dbPath?: string;
  dataDir?: string;
  now?: () => number;
}): ConversationSubmitAttemptStore {
  const dbPath = resolveConversationSubmitAttemptDbPath(options);
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
    claim(input) {
      return withDb((db) => {
        const workspaceId = normalizeText(input.workspaceId);
        const clientMessageId = normalizeText(input.clientMessageId);
        const requestHash = normalizeText(input.requestHash);
        if (!workspaceId || !clientMessageId || !requestHash) {
          throw new Error("workspaceId, clientMessageId, and requestHash are required");
        }

        const existing = getSync(db, workspaceId, clientMessageId);
        if (existing) {
          return {
            attempt: existing,
            inserted: false,
            conflict: existing.requestHash !== requestHash,
          };
        }

        const timestamp = now();
        db.query(
          `INSERT INTO conversation_submit_attempt (
            workspace_id,
            client_message_id,
            request_hash,
            status,
            conversation_id,
            opencode_session_id,
            run_id,
            queue_item_id,
            result_json,
            created_at,
            updated_at
          ) VALUES (?1, ?2, ?3, 'started', NULL, NULL, NULL, NULL, NULL, ?4, ?4)`,
        ).run(workspaceId, clientMessageId, requestHash, timestamp);

        const attempt = getSync(db, workspaceId, clientMessageId);
        if (!attempt) throw new Error("failed to persist conversation submit attempt");
        return { attempt, inserted: true, conflict: false };
      });
    },

    update(input) {
      return withDb((db) => {
        const workspaceId = normalizeText(input.workspaceId);
        const clientMessageId = normalizeText(input.clientMessageId);
        const status = normalizeText(input.status) as ConversationSubmitAttemptStatus;
        if (!workspaceId || !clientMessageId || !status) {
          throw new Error("workspaceId, clientMessageId, and status are required");
        }
        const existing = getSync(db, workspaceId, clientMessageId);
        if (!existing) {
          throw new Error("conversation submit attempt was not claimed");
        }
        const timestamp = now();
        db.query(
          `UPDATE conversation_submit_attempt
           SET status = ?3,
               conversation_id = COALESCE(?4, conversation_id),
               opencode_session_id = COALESCE(?5, opencode_session_id),
               run_id = COALESCE(?6, run_id),
               queue_item_id = COALESCE(?7, queue_item_id),
               result_json = COALESCE(?8, result_json),
               updated_at = ?9
           WHERE workspace_id = ?1 AND client_message_id = ?2`,
        ).run(
          workspaceId,
          clientMessageId,
          status,
          normalizeNullableText(input.conversationId),
          normalizeNullableText(input.opencodeSessionId),
          normalizeNullableText(input.runId),
          normalizeNullableText(input.queueItemId),
          normalizeNullableText(input.resultJson),
          timestamp,
        );
        const updated = getSync(db, workspaceId, clientMessageId);
        if (!updated) throw new Error("failed to update conversation submit attempt");
        return updated;
      });
    },

    get(workspaceId, clientMessageId) {
      return withDb((db) => getSync(db, normalizeText(workspaceId), normalizeText(clientMessageId)));
    },
  };
}
