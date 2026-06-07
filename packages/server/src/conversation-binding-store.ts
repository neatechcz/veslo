import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveVesloDataDir } from "./audit.js";

export type ConversationBinding = {
  workspaceId: string;
  conversationId: string;
  engine: "opencode";
  engineSessionId: string;
  directory: string;
  branchId: string | null;
  parentConversationId: string | null;
  parentEngineSessionId: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type ConversationBindingInput = {
  workspaceId: string;
  directory: string;
  engineSessionId: string;
  title?: string | null;
  parentEngineSessionId?: string | null;
  branchId?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
};

export type ConversationBindingStore = {
  bindOpenCodeSession(input: ConversationBindingInput): Promise<ConversationBinding>;
  bindOpenCodeSessions(input: {
    workspaceId: string;
    directory: string;
    sessions: Array<Omit<ConversationBindingInput, "workspaceId" | "directory">>;
  }): Promise<Map<string, ConversationBinding>>;
  resolveOpenCodeSession(input: {
    workspaceId: string;
    directory?: string | null;
    sessionOrConversationId: string;
  }): Promise<ConversationBinding | null>;
};

type ConversationBindingRow = {
  workspace_id: string;
  conversation_id: string;
  engine: "opencode";
  engine_session_id: string;
  directory: string;
  branch_id: string | null;
  parent_conversation_id: string | null;
  parent_engine_session_id: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
  first_seen_at: number;
  last_seen_at: number;
};

const ENGINE = "opencode" as const;

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const normalizeNullableText = (value: string | null | undefined) => {
  const normalized = normalizeText(value);
  return normalized || null;
};

const normalizeTimestamp = (value: number | null | undefined, fallback: number) =>
  Number.isFinite(value ?? NaN) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveConversationBindingDbPath(options?: {
  dbPath?: string;
  dataDir?: string;
}): string {
  const explicitDb = normalizeText(options?.dbPath) || normalizeText(process.env.VESLO_CONVERSATION_BINDINGS_DB_PATH);
  if (explicitDb) return resolve(expandHome(explicitDb));

  const explicitDir =
    normalizeText(process.env.VESLO_CONVERSATION_BINDINGS_DIR) ||
    normalizeText(options?.dataDir) ||
    resolveVesloDataDir();
  return join(resolve(expandHome(explicitDir)), "conversations", "bindings.sqlite");
}

export function deterministicConversationId(input: {
  workspaceId: string;
  directory: string;
  engineSessionId: string;
}): string {
  const digest = createHash("sha256")
    .update(["opencode", normalizeText(input.workspaceId), normalizeText(input.directory), normalizeText(input.engineSessionId)].join("\0"))
    .digest("hex");
  return `conv-${digest.slice(0, 20)}`;
}

function rowToBinding(row: ConversationBindingRow): ConversationBinding {
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    engine: row.engine,
    engineSessionId: row.engine_session_id,
    directory: row.directory,
    branchId: row.branch_id,
    parentConversationId: row.parent_conversation_id,
    parentEngineSessionId: row.parent_engine_session_id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

function createDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS conversation_binding (
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      engine_session_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      branch_id TEXT,
      parent_conversation_id TEXT,
      parent_engine_session_id TEXT,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, conversation_id),
      UNIQUE (workspace_id, directory, engine, engine_session_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_binding_engine_idx
      ON conversation_binding (workspace_id, directory, engine, engine_session_id);
    CREATE INDEX IF NOT EXISTS conversation_binding_updated_idx
      ON conversation_binding (workspace_id, directory, updated_at DESC);
  `);
  return db;
}

export function createConversationBindingStore(options?: {
  dbPath?: string;
  dataDir?: string;
  now?: () => number;
}): ConversationBindingStore {
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

  const bindOpenCodeSessionSync = (db: Database, input: ConversationBindingInput): ConversationBinding => {
    const workspaceId = normalizeText(input.workspaceId);
    const directory = normalizeText(input.directory);
    const engineSessionId = normalizeText(input.engineSessionId);
    if (!workspaceId || !directory || !engineSessionId) {
      throw new Error("workspaceId, directory and engineSessionId are required");
    }

    const seenAt = now();
    const conversationId = deterministicConversationId({ workspaceId, directory, engineSessionId });
    const parentEngineSessionId = normalizeNullableText(input.parentEngineSessionId);
    const parentConversationId = parentEngineSessionId
      ? deterministicConversationId({ workspaceId, directory, engineSessionId: parentEngineSessionId })
      : null;
    const createdAt = normalizeTimestamp(input.createdAt, seenAt);
    const updatedAt = normalizeTimestamp(input.updatedAt, createdAt);
    const title = normalizeNullableText(input.title);
    const branchId = normalizeNullableText(input.branchId);

    db.query(
      `INSERT INTO conversation_binding (
        workspace_id,
        conversation_id,
        engine,
        engine_session_id,
        directory,
        branch_id,
        parent_conversation_id,
        parent_engine_session_id,
        title,
        created_at,
        updated_at,
        first_seen_at,
        last_seen_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(workspace_id, directory, engine, engine_session_id) DO UPDATE SET
        branch_id = COALESCE(excluded.branch_id, conversation_binding.branch_id),
        parent_conversation_id = COALESCE(excluded.parent_conversation_id, conversation_binding.parent_conversation_id),
        parent_engine_session_id = COALESCE(excluded.parent_engine_session_id, conversation_binding.parent_engine_session_id),
        title = COALESCE(excluded.title, conversation_binding.title),
        created_at = MIN(conversation_binding.created_at, excluded.created_at),
        updated_at = MAX(conversation_binding.updated_at, excluded.updated_at),
        last_seen_at = excluded.last_seen_at`,
    ).run(
      workspaceId,
      conversationId,
      ENGINE,
      engineSessionId,
      directory,
      branchId,
      parentConversationId,
      parentEngineSessionId,
      title,
      createdAt,
      updatedAt,
      seenAt,
      seenAt,
    );

    const row = db.query<ConversationBindingRow, [string, string, string, string]>(
      `SELECT * FROM conversation_binding
       WHERE workspace_id = ?1 AND directory = ?2 AND engine = ?3 AND engine_session_id = ?4
       LIMIT 1`,
    ).get(workspaceId, directory, ENGINE, engineSessionId);
    if (!row) {
      throw new Error("Failed to persist conversation binding");
    }
    return rowToBinding(row);
  };

  return {
    async bindOpenCodeSession(input) {
      return withDb((db) => bindOpenCodeSessionSync(db, input));
    },

    async bindOpenCodeSessions(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const directory = normalizeText(input.directory);
      if (!workspaceId || !directory) return new Map();

      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const bindings = new Map<string, ConversationBinding>();
          for (const session of input.sessions) {
            const binding = bindOpenCodeSessionSync(db, {
              workspaceId,
              directory,
              ...session,
            });
            bindings.set(binding.engineSessionId, binding);
          }
          db.exec("COMMIT");
          return bindings;
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

    async resolveOpenCodeSession(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const directory = normalizeText(input.directory);
      const sessionOrConversationId = normalizeText(input.sessionOrConversationId);
      if (!workspaceId || !sessionOrConversationId) return null;

      return withDb((db) => {
        if (!directory) {
          const row = db.query<ConversationBindingRow, [string, string, string, string]>(
            `SELECT * FROM conversation_binding
             WHERE workspace_id = ?1
               AND engine = ?2
               AND (engine_session_id = ?3 OR conversation_id = ?4)
             ORDER BY updated_at DESC
             LIMIT 1`,
          ).get(workspaceId, ENGINE, sessionOrConversationId, sessionOrConversationId);
          return row ? rowToBinding(row) : null;
        }

        const row = db.query<ConversationBindingRow, [string, string, string, string, string]>(
          `SELECT * FROM conversation_binding
           WHERE workspace_id = ?1
             AND directory = ?2
             AND engine = ?3
             AND (engine_session_id = ?4 OR conversation_id = ?5)
           LIMIT 1`,
        ).get(workspaceId, directory, ENGINE, sessionOrConversationId, sessionOrConversationId);
        return row ? rowToBinding(row) : null;
      });
    },
  };
}
