import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { resolveConversationBindingDbPath } from "./conversation-binding-store.js";

// Host-side transcript persistence (messages + parts). Lives in the same
// `bindings.sqlite` as conversation summaries (host = the durable source of
// truth on the main OS). The sandbox/WSL opencode.db is only the runtime that
// produces transcripts; we tunnel them into this store while a workspace is
// active and read host-first afterwards. Keyed by (workspace_id,
// engine_session_id, message_id) — the engine session id is globally unique,
// so no directory scoping is needed here (the binding maps session -> dir).

export type TranscriptPartInput = {
  id: string;
  type?: string | null;
  payload: unknown;
};

export type TranscriptMessageInput = {
  id: string;
  role?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  payload: unknown;
  parts: TranscriptPartInput[];
};

export type PersistedTranscript = {
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
};

export type ConversationTranscriptStore = {
  appendTranscript(input: {
    workspaceId: string;
    engineSessionId: string;
    messages: TranscriptMessageInput[];
    deletedMessageIds?: string[];
    deletedPartsByMessageId?: Record<string, string[]>;
  }): Promise<void>;
  getTranscript(input: {
    workspaceId: string;
    engineSessionId: string;
    limit?: number;
  }): Promise<PersistedTranscript | null>;
};

type MessageRow = { message_id: string; payload_json: string };
type PartRow = { message_id: string; payload_json: string };

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const normalizeTimestamp = (value: number | null | undefined, fallback: number) =>
  Number.isFinite(value ?? NaN) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;

const normalizeTextList = (values: string[] | null | undefined): string[] => {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeText(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
};

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

function createDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS conversation_message (
      workspace_id TEXT NOT NULL,
      engine_session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, engine_session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_message_session_idx
      ON conversation_message (workspace_id, engine_session_id, message_id);
    CREATE TABLE IF NOT EXISTS conversation_part (
      workspace_id TEXT NOT NULL,
      engine_session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      type TEXT,
      payload_json TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, engine_session_id, message_id, part_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_part_message_idx
      ON conversation_part (workspace_id, engine_session_id, message_id, part_id);
  `);
  return db;
}

export function createConversationTranscriptStore(options?: {
  dbPath?: string;
  dataDir?: string;
  now?: () => number;
}): ConversationTranscriptStore {
  const dbPath = resolveConversationBindingDbPath(options);
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
    async appendTranscript(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const engineSessionId = normalizeText(input.engineSessionId);
      const hasDeletedMessages = normalizeTextList(input.deletedMessageIds).length > 0;
      const hasDeletedParts = Object.values(input.deletedPartsByMessageId ?? {})
        .some((partIds) => normalizeTextList(partIds).length > 0);
      if (!workspaceId || !engineSessionId || (input.messages.length === 0 && !hasDeletedMessages && !hasDeletedParts)) return;

      withDb((db) => {
        const seenAt = now();
        const insertMessage = db.query(
          `INSERT INTO conversation_message (
             workspace_id, engine_session_id, message_id, role,
             created_at, updated_at, payload_json, first_seen_at, last_seen_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
           ON CONFLICT(workspace_id, engine_session_id, message_id) DO UPDATE SET
             role = COALESCE(excluded.role, conversation_message.role),
             created_at = MIN(conversation_message.created_at, excluded.created_at),
             updated_at = MAX(conversation_message.updated_at, excluded.updated_at),
             payload_json = excluded.payload_json,
             last_seen_at = excluded.last_seen_at`,
        );
        const insertPart = db.query(
          `INSERT INTO conversation_part (
             workspace_id, engine_session_id, message_id, part_id, type,
             payload_json, first_seen_at, last_seen_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
           ON CONFLICT(workspace_id, engine_session_id, message_id, part_id) DO UPDATE SET
             type = COALESCE(excluded.type, conversation_part.type),
             payload_json = excluded.payload_json,
             last_seen_at = excluded.last_seen_at`,
        );
        const deleteMessage = db.query(
          `DELETE FROM conversation_message
           WHERE workspace_id = ?1 AND engine_session_id = ?2 AND message_id = ?3`,
        );
        const deletePartsForMessage = db.query(
          `DELETE FROM conversation_part
           WHERE workspace_id = ?1 AND engine_session_id = ?2 AND message_id = ?3`,
        );
        const deletePart = db.query(
          `DELETE FROM conversation_part
           WHERE workspace_id = ?1 AND engine_session_id = ?2 AND message_id = ?3 AND part_id = ?4`,
        );

        db.exec("BEGIN IMMEDIATE");
        try {
          for (const messageId of normalizeTextList(input.deletedMessageIds)) {
            deletePartsForMessage.run(workspaceId, engineSessionId, messageId);
            deleteMessage.run(workspaceId, engineSessionId, messageId);
          }
          for (const [rawMessageId, rawPartIds] of Object.entries(input.deletedPartsByMessageId ?? {})) {
            const messageId = normalizeText(rawMessageId);
            if (!messageId) continue;
            for (const partId of normalizeTextList(rawPartIds)) {
              deletePart.run(workspaceId, engineSessionId, messageId, partId);
            }
          }

          for (const message of input.messages) {
            const messageId = normalizeText(message.id);
            if (!messageId) continue;
            const createdAt = normalizeTimestamp(message.createdAt, seenAt);
            const updatedAt = normalizeTimestamp(message.updatedAt, createdAt);
            insertMessage.run(
              workspaceId,
              engineSessionId,
              messageId,
              normalizeText(message.role) || null,
              createdAt,
              updatedAt,
              JSON.stringify(message.payload ?? null),
              seenAt,
            );
            // The app sends a snapshot of the current parts for each message.
            // Replace that set so removed/transient parts do not resurrect on
            // the next host-first transcript read.
            deletePartsForMessage.run(workspaceId, engineSessionId, messageId);
            for (const part of message.parts ?? []) {
              const partId = normalizeText(part.id);
              if (!partId) continue;
              insertPart.run(
                workspaceId,
                engineSessionId,
                messageId,
                partId,
                normalizeText(part.type) || null,
                JSON.stringify(part.payload ?? null),
                seenAt,
              );
            }
          }
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // ignore rollback failures
          }
          throw error;
        }
      });
    },

    async getTranscript(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const engineSessionId = normalizeText(input.engineSessionId);
      if (!workspaceId || !engineSessionId) return null;
      const limit =
        Number.isFinite(input.limit ?? NaN) && (input.limit ?? 0) > 0
          ? Math.min(Math.floor(input.limit as number), 1000)
          : 140;

      return withDb((db) => {
        // Mirror conversation-read-store: messages ordered by id ASC, limited.
        const messageRows = db
          .query<MessageRow, [string, string, number]>(
            `SELECT message_id, payload_json FROM conversation_message
             WHERE workspace_id = ?1 AND engine_session_id = ?2
             ORDER BY message_id ASC
             LIMIT ?3`,
          )
          .all(workspaceId, engineSessionId, limit);
        if (messageRows.length === 0) return null;

        const messages = messageRows
          .map((row) => safeParse(row.payload_json))
          .filter((value): value is Record<string, unknown> => Boolean(value));

        const messageIds = new Set(messageRows.map((row) => row.message_id));
        const partRows = db
          .query<PartRow, [string, string]>(
            `SELECT message_id, payload_json FROM conversation_part
             WHERE workspace_id = ?1 AND engine_session_id = ?2
             ORDER BY message_id ASC, part_id ASC`,
          )
          .all(workspaceId, engineSessionId);

        const partsByMessageId: Record<string, unknown[]> = {};
        for (const row of partRows) {
          if (!messageIds.has(row.message_id)) continue;
          const part = safeParse(row.payload_json);
          if (!part) continue;
          (partsByMessageId[row.message_id] ??= []).push(part);
        }

        return { messages, partsByMessageId };
      });
    },
  };
}
