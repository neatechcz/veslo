import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  normalizeConversationDirectoryKey,
  resolveConversationBindingDbPath,
} from "./conversation-binding-store.js";

// Host-side transcript persistence (messages + parts). Lives in the same
// `bindings.sqlite` as conversation summaries (host = the durable source of
// truth on the main OS). The sandbox/WSL opencode.db is only the runtime that
// produces transcripts; we tunnel them into this store while a workspace is
// active and read host-first afterwards. Keyed by workspace, directory, and
// engine session id so imported/legacy OpenCode ids cannot collide across
// directory-scoped bindings.

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
    directory?: string | null;
    engineSessionId: string;
    messages: TranscriptMessageInput[];
    deletedMessageIds?: string[];
    deletedPartsByMessageId?: Record<string, string[]>;
    /** Internal-only: the input contains the complete canonical session scope. */
    complete?: boolean;
  }): Promise<void>;
  reconcileCanonicalTranscript(input: {
    workspaceId: string;
    directory?: string | null;
    engineSessionId: string;
    messages: TranscriptMessageInput[];
  }): Promise<void>;
  getTranscript(input: {
    workspaceId: string;
    directory?: string | null;
    engineSessionId: string;
    limit?: number;
  }): Promise<PersistedTranscript | null>;
};

type MessageRow = { message_id: string; payload_json: string };
type PartRow = { message_id: string; payload_json: string };
type PartPayloadRow = { payload_json: string };
type PartIdRow = { part_id: string };

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readNonEmptyText = (value: unknown): string => {
  if (!isRecord(value) || typeof value.text !== "string") return "";
  return normalizeText(value.text);
};

const isTextPartPayload = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && (value.type === "text" || typeof value.text === "string");

const tableHasColumn = (db: Database, table: string, column: string): boolean =>
  db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .some((row) => row.name === column);

const migrateTranscriptDirectoryScope = (db: Database) => {
  if (!tableHasColumn(db, "conversation_message", "directory")) {
    db.exec(`
      CREATE TABLE conversation_message_scoped (
        workspace_id TEXT NOT NULL,
        directory TEXT NOT NULL DEFAULT '',
        engine_session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, directory, engine_session_id, message_id)
      );
      INSERT OR REPLACE INTO conversation_message_scoped (
        workspace_id, directory, engine_session_id, message_id, role,
        created_at, updated_at, payload_json, first_seen_at, last_seen_at
      )
      SELECT
        workspace_id, '', engine_session_id, message_id, role,
        created_at, updated_at, payload_json, first_seen_at, last_seen_at
      FROM conversation_message;
      DROP TABLE conversation_message;
      ALTER TABLE conversation_message_scoped RENAME TO conversation_message;
    `);
  }

  if (!tableHasColumn(db, "conversation_part", "directory")) {
    db.exec(`
      CREATE TABLE conversation_part_scoped (
        workspace_id TEXT NOT NULL,
        directory TEXT NOT NULL DEFAULT '',
        engine_session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        type TEXT,
        payload_json TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, directory, engine_session_id, message_id, part_id)
      );
      INSERT OR REPLACE INTO conversation_part_scoped (
        workspace_id, directory, engine_session_id, message_id, part_id, type,
        payload_json, first_seen_at, last_seen_at
      )
      SELECT
        workspace_id, '', engine_session_id, message_id, part_id, type,
        payload_json, first_seen_at, last_seen_at
      FROM conversation_part;
      DROP TABLE conversation_part;
      ALTER TABLE conversation_part_scoped RENAME TO conversation_part;
    `);
  }

  if (!tableHasColumn(db, "conversation_transcript_empty", "directory")) {
    db.exec(`
      CREATE TABLE conversation_transcript_empty_scoped (
        workspace_id TEXT NOT NULL,
        directory TEXT NOT NULL DEFAULT '',
        engine_session_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, directory, engine_session_id)
      );
      INSERT OR REPLACE INTO conversation_transcript_empty_scoped (
        workspace_id, directory, engine_session_id, first_seen_at, last_seen_at
      )
      SELECT
        workspace_id, '', engine_session_id, first_seen_at, last_seen_at
      FROM conversation_transcript_empty;
      DROP TABLE conversation_transcript_empty;
      ALTER TABLE conversation_transcript_empty_scoped RENAME TO conversation_transcript_empty;
    `);
  }
};

const mergeTimeRecord = (existing: unknown, incoming: unknown): unknown => {
  if (!isRecord(existing) || !isRecord(incoming)) return incoming ?? existing;
  return {
    ...existing,
    ...incoming,
    start: incoming.start ?? existing.start,
    end: incoming.end ?? existing.end,
  };
};

const mergePartPayload = (existing: unknown, incoming: unknown): unknown => {
  if (!isTextPartPayload(existing) || !isTextPartPayload(incoming)) return incoming;
  const existingText = readNonEmptyText(existing);
  const incomingText = readNonEmptyText(incoming);
  if (!existingText || incomingText) {
    return {
      ...existing,
      ...incoming,
      time: mergeTimeRecord(existing.time, incoming.time),
    };
  }
  return {
    ...incoming,
    text: existing.text,
    time: mergeTimeRecord(existing.time, incoming.time),
  };
};

const mergePartPayloadJson = (existingRaw: string | null | undefined, incomingRaw: string): string => {
  if (!existingRaw) return incomingRaw;
  const existing = safeParse(existingRaw);
  const incoming = safeParse(incomingRaw);
  return JSON.stringify(mergePartPayload(existing, incoming));
};

function createDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS conversation_message (
      workspace_id TEXT NOT NULL,
      directory TEXT NOT NULL DEFAULT '',
      engine_session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, directory, engine_session_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_part (
      workspace_id TEXT NOT NULL,
      directory TEXT NOT NULL DEFAULT '',
      engine_session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      type TEXT,
      payload_json TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, directory, engine_session_id, message_id, part_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_transcript_empty (
      workspace_id TEXT NOT NULL,
      directory TEXT NOT NULL DEFAULT '',
      engine_session_id TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, directory, engine_session_id)
    );
  `);
  migrateTranscriptDirectoryScope(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS conversation_message_session_idx
      ON conversation_message (workspace_id, directory, engine_session_id, message_id);
    CREATE INDEX IF NOT EXISTS conversation_part_message_idx
      ON conversation_part (workspace_id, directory, engine_session_id, message_id, part_id);
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

  const store: ConversationTranscriptStore = {
    async appendTranscript(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const directory = normalizeConversationDirectoryKey(input.directory);
      const engineSessionId = normalizeText(input.engineSessionId);
      const hasDeletedMessages = normalizeTextList(input.deletedMessageIds).length > 0;
      const hasDeletedParts = Object.values(input.deletedPartsByMessageId ?? {})
        .some((partIds) => normalizeTextList(partIds).length > 0);
      if (!workspaceId || !engineSessionId) return;
      const incomingMessageIds = new Set(
        input.messages.map((message) => normalizeText(message.id)).filter(Boolean),
      );

      withDb((db) => {
        const seenAt = now();
        const upsertEmptyMarker = db.query(
          `INSERT INTO conversation_transcript_empty (
             workspace_id, directory, engine_session_id, first_seen_at, last_seen_at
           ) VALUES (?1, ?2, ?3, ?4, ?4)
           ON CONFLICT(workspace_id, directory, engine_session_id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at`,
        );
        const deleteEmptyMarker = db.query(
          `DELETE FROM conversation_transcript_empty
           WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3`,
        );
        const insertMessage = db.query(
          `INSERT INTO conversation_message (
             workspace_id, directory, engine_session_id, message_id, role,
             created_at, updated_at, payload_json, first_seen_at, last_seen_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
           ON CONFLICT(workspace_id, directory, engine_session_id, message_id) DO UPDATE SET
             role = COALESCE(excluded.role, conversation_message.role),
             created_at = MIN(conversation_message.created_at, excluded.created_at),
             updated_at = MAX(conversation_message.updated_at, excluded.updated_at),
             payload_json = excluded.payload_json,
             last_seen_at = excluded.last_seen_at`,
        );
        const insertPart = db.query(
          `INSERT INTO conversation_part (
             workspace_id, directory, engine_session_id, message_id, part_id, type,
             payload_json, first_seen_at, last_seen_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
           ON CONFLICT(workspace_id, directory, engine_session_id, message_id, part_id) DO UPDATE SET
             type = COALESCE(excluded.type, conversation_part.type),
             payload_json = excluded.payload_json,
             last_seen_at = excluded.last_seen_at`,
        );
        const deleteMessage = db.query(
          `DELETE FROM conversation_message
           WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3 AND message_id = ?4`,
        );
        const deletePartsForMessage = db.query(
          `DELETE FROM conversation_part
           WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3 AND message_id = ?4`,
        );
        const deletePart = db.query(
          `DELETE FROM conversation_part
           WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3 AND message_id = ?4 AND part_id = ?5`,
        );
        const listPartsForMessage = db.query<PartIdRow, [string, string, string, string]>(
          `SELECT part_id FROM conversation_part
           WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3 AND message_id = ?4`,
        );
        const listMessageIds = db.query<{ message_id: string }, [string, string, string]>(
          `SELECT message_id FROM conversation_message
           WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3`,
        );
        const readPartPayload = db.query<PartPayloadRow, [string, string, string, string, string]>(
          `SELECT payload_json FROM conversation_part
           WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3 AND message_id = ?4 AND part_id = ?5
           LIMIT 1`,
        );

        db.exec("BEGIN IMMEDIATE");
        try {
          if (input.messages.length === 0 && !hasDeletedMessages && !hasDeletedParts) {
            if (input.complete === true) {
              for (const row of listMessageIds.all(workspaceId, directory, engineSessionId)) {
                deletePartsForMessage.run(workspaceId, directory, engineSessionId, row.message_id);
                deleteMessage.run(workspaceId, directory, engineSessionId, row.message_id);
              }
            }
            upsertEmptyMarker.run(workspaceId, directory, engineSessionId, seenAt);
            db.exec("COMMIT");
            return;
          }

          for (const messageId of normalizeTextList(input.deletedMessageIds)) {
            deletePartsForMessage.run(workspaceId, directory, engineSessionId, messageId);
            deleteMessage.run(workspaceId, directory, engineSessionId, messageId);
          }
          for (const [rawMessageId, rawPartIds] of Object.entries(input.deletedPartsByMessageId ?? {})) {
            const messageId = normalizeText(rawMessageId);
            if (!messageId) continue;
            for (const partId of normalizeTextList(rawPartIds)) {
              deletePart.run(workspaceId, directory, engineSessionId, messageId, partId);
            }
          }

          if (input.messages.length > 0) {
            deleteEmptyMarker.run(workspaceId, directory, engineSessionId);
          }

          for (const message of input.messages) {
            const messageId = normalizeText(message.id);
            if (!messageId) continue;
            const createdAt = normalizeTimestamp(message.createdAt, seenAt);
            const updatedAt = normalizeTimestamp(message.updatedAt, createdAt);
            insertMessage.run(
              workspaceId,
              directory,
              engineSessionId,
              messageId,
              normalizeText(message.role) || null,
              createdAt,
              updatedAt,
              JSON.stringify(message.payload ?? null),
              seenAt,
            );
            const parts = (message.parts ?? [])
              .map((part) => ({
                ...part,
                id: normalizeText(part.id),
              }))
              .filter((part) => part.id);
            const incomingPartIds = new Set(parts.map((part) => part.id));
            for (const row of listPartsForMessage.all(workspaceId, directory, engineSessionId, messageId)) {
              if (!incomingPartIds.has(row.part_id)) {
                deletePart.run(workspaceId, directory, engineSessionId, messageId, row.part_id);
              }
            }
            for (const part of parts) {
              const partId = normalizeText(part.id);
              if (!partId) continue;
              const incomingPayloadJson = JSON.stringify(part.payload ?? null);
              const existingPayloadJson =
                readPartPayload.get(workspaceId, directory, engineSessionId, messageId, partId)?.payload_json ?? null;
              insertPart.run(
                workspaceId,
                directory,
                engineSessionId,
                messageId,
                partId,
                normalizeText(part.type) || null,
                mergePartPayloadJson(existingPayloadJson, incomingPayloadJson),
                seenAt,
              );
            }
          }
          if (input.complete === true) {
            for (const row of listMessageIds.all(workspaceId, directory, engineSessionId)) {
              if (incomingMessageIds.has(row.message_id)) continue;
              deletePartsForMessage.run(workspaceId, directory, engineSessionId, row.message_id);
              deleteMessage.run(workspaceId, directory, engineSessionId, row.message_id);
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

    async reconcileCanonicalTranscript(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const directory = normalizeConversationDirectoryKey(input.directory);
      const engineSessionId = normalizeText(input.engineSessionId);
      if (!workspaceId || !engineSessionId) return;
      await store.appendTranscript({
        ...input,
        complete: true,
      });
    },

    async getTranscript(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const directory = normalizeConversationDirectoryKey(input.directory);
      const engineSessionId = normalizeText(input.engineSessionId);
      if (!workspaceId || !engineSessionId) return null;
      const limit =
        Number.isFinite(input.limit ?? NaN) && (input.limit ?? 0) > 0
          ? Math.min(Math.floor(input.limit as number), 1000)
          : 140;

      return withDb((db) => {
        // Host-first reads should preserve transcript chronology even when old
        // imported engine ids do not sort in creation order.
        const readScopedTranscript = (scopeDirectory: string): PersistedTranscript | null => {
          const messageRows = db
            .query<MessageRow, [string, string, string, number]>(
              `SELECT message_id, payload_json FROM conversation_message
               WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3
               ORDER BY created_at ASC, message_id ASC
               LIMIT ?4`,
            )
            .all(workspaceId, scopeDirectory, engineSessionId, limit);
          if (messageRows.length === 0) {
            const marker = db
              .query<{ found: number }, [string, string, string]>(
                `SELECT 1 AS found FROM conversation_transcript_empty
                 WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3
                 LIMIT 1`,
              )
              .get(workspaceId, scopeDirectory, engineSessionId);
            return marker ? { messages: [], partsByMessageId: {} } : null;
          }

          const messages = messageRows
            .map((row) => safeParse(row.payload_json))
            .filter((value): value is Record<string, unknown> => Boolean(value));

          const messageIds = new Set(messageRows.map((row) => row.message_id));
          const partRows = db
            .query<PartRow, [string, string, string]>(
              `SELECT message_id, payload_json FROM conversation_part
               WHERE workspace_id = ?1 AND directory = ?2 AND engine_session_id = ?3
               ORDER BY message_id ASC, part_id ASC`,
            )
            .all(workspaceId, scopeDirectory, engineSessionId);

          const partsByMessageId: Record<string, unknown[]> = {};
          for (const row of partRows) {
            if (!messageIds.has(row.message_id)) continue;
            const part = safeParse(row.payload_json);
            if (!part) continue;
            (partsByMessageId[row.message_id] ??= []).push(part);
          }

          return { messages, partsByMessageId };
        };

        const direct = readScopedTranscript(directory);
        if (direct) return direct;

        // Rows written before directory-key normalization can still use a
        // Windows casing or slash variant. Resolve one exact legacy row before
        // the deliberate unscoped fallback, without weakening Unix directory
        // isolation.
        if (directory) {
          const legacyDirectory = db
            .query<{ directory: string }, [string, string]>(
              `SELECT directory FROM conversation_message
               WHERE workspace_id = ?1 AND engine_session_id = ?2
               UNION
               SELECT directory FROM conversation_transcript_empty
               WHERE workspace_id = ?1 AND engine_session_id = ?2`,
            )
            .all(workspaceId, engineSessionId)
            .map((row) => row.directory)
            .find((storedDirectory) => normalizeConversationDirectoryKey(storedDirectory) === directory);
          if (legacyDirectory) {
            const legacy = readScopedTranscript(legacyDirectory);
            if (legacy) return legacy;
          }
        }

        return directory ? readScopedTranscript("") : null;
      });
    },
  };
  return store;
}
