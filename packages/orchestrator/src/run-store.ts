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
export type RunEngineOwnerState = "pending" | "attached" | "lost";

export const ACTIVE_RUN_STATUSES = ["submitted", "running", "blocked"] as const satisfies readonly RunStatus[];

export type RunEngineOwner = {
  engineSlotId?: string | null;
  engineOwnerId: string | null;
  engineOwnerState?: RunEngineOwnerState;
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
  opencodeMessageId?: string | null;
  origin: string | null;
  /** Non-secret binding required to recover a managed gateway run after a server worker replacement. */
  expectsAiGatewayStart?: boolean;
  runtimeAuthorizationActorTokenHash?: string | null;
  runtimeAuthorizationOrgId?: string | null;
  /** Present only while reading the authenticated recovery descriptor. */
  gatewayRecoveryExpiresAt?: number | null;
  gatewayRecoveryState?: "active" | "terminal" | null;
  directory: string;
  kind: RunKind;
  status: RunStatus;
  abortRequested: boolean;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  engineSlotId: string | null;
  engineOwnerState: RunEngineOwnerState;
  engineOwnerId: string | null;
  enginePid: number | null;
  engineStartedAt: number | null;
  engineBaseUrl: string | null;
  activityKind: RunActivityKind | null;
  waitReason: RunWaitReason | null;
  lastUsefulProgressAt: number | null;
  retrySince: number | null;
  lastProgressSignature: string | null;
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
  activeForEngineSession(input: {
    workspaceId: string;
    engineSessionId: string;
    engineOwnerId: string;
    enginePid: number;
    engineStartedAt: number;
    engineBaseUrl: string;
  }): RunRecord | null;
  activeForEngineOwner(engineOwnerId: string): RunRecord[];
  activeManagedGatewayRuns?(workspaceId: string): RunRecord[];
  /** Terminal records that still claim an exact engine owner after restart. */
  terminalAttachedWithEngineOwner(limit?: number): RunRecord[];
  activeCreatedBefore(createdBefore: number, limit?: number): RunRecord[];
  migrateWorkspaceId(sourceWorkspaceId: string, targetWorkspaceId: string): RunStoreWorkspaceMigrationResult;
  /**
   * True when the workspace has any run in an active status created at or
   * after `createdSince` (epoch ms). The lower bound keeps a stale record -
   * a run whose engine died before reaching a terminal status - from
   * counting as active work forever.
   */
  hasActiveForWorkspace(workspaceId: string, createdSince: number, options?: { excludeRunId?: string }): boolean;
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
  opencode_message_id: string | null;
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
  engine_slot_id: string | null;
  engine_owner_state: string | null;
  engine_pid: number | null;
  engine_started_at: number | null;
  engine_base_url: string | null;
  activity_kind: string | null;
  wait_reason: string | null;
  last_useful_progress_at: number | null;
  retry_since: number | null;
  last_progress_signature: string | null;
  expects_ai_gateway_start: number | null;
  runtime_authorization_actor_token_hash: string | null;
  runtime_authorization_org_id: string | null;
  gateway_recovery_actor_token_hash?: string | null;
  gateway_recovery_organization_id?: string | null;
  gateway_recovery_expires_at?: number | null;
  gateway_recovery_state?: string | null;
};

const ACTIVE_RUN_STATUS_SQL_LIST = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ");
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);
const GATEWAY_RECOVERY_DESCRIPTOR_TTL_MS = 2 * 60 * 60_000;
const GATEWAY_RECOVERY_DESCRIPTOR_BACKFILL_MIGRATION = "conversation_run_gateway_recovery_backfill_v1";

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
    opencodeMessageId: row.opencode_message_id ?? null,
    origin: row.origin ?? null,
    expectsAiGatewayStart: row.expects_ai_gateway_start === 1,
    runtimeAuthorizationActorTokenHash: row.gateway_recovery_actor_token_hash ?? row.runtime_authorization_actor_token_hash ?? null,
    runtimeAuthorizationOrgId: row.gateway_recovery_organization_id ?? row.runtime_authorization_org_id ?? null,
    gatewayRecoveryExpiresAt: row.gateway_recovery_expires_at === null || row.gateway_recovery_expires_at === undefined
      ? null
      : Number(row.gateway_recovery_expires_at),
    gatewayRecoveryState: row.gateway_recovery_state === "active" || row.gateway_recovery_state === "terminal"
      ? row.gateway_recovery_state
      : null,
    directory: row.directory,
    kind: row.kind as RunKind,
    status: row.status as RunStatus,
    abortRequested: row.abort_requested === 1,
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    error: row.error,
    engineSlotId: row.engine_slot_id ?? null,
    engineOwnerState: row.engine_owner_state === "attached" || row.engine_owner_state === "lost"
      ? row.engine_owner_state
      : row.engine_owner_id
        ? "attached"
        : "pending",
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
      opencode_message_id TEXT,
      origin TEXT,
      expects_ai_gateway_start INTEGER NOT NULL DEFAULT 0,
      runtime_authorization_actor_token_hash TEXT,
      runtime_authorization_org_id TEXT,
      directory TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      abort_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      engine_slot_id TEXT,
      engine_owner_id TEXT,
      engine_owner_state TEXT NOT NULL DEFAULT 'pending',
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
    CREATE TABLE IF NOT EXISTS conversation_run_gateway_recovery (
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      engine_session_id TEXT NOT NULL,
      actor_token_hash TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'terminal')),
      engine_slot_id TEXT,
      engine_owner_id TEXT,
      engine_pid INTEGER,
      engine_started_at INTEGER,
      engine_base_url TEXT,
      PRIMARY KEY (workspace_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_run_gateway_recovery_active_idx
      ON conversation_run_gateway_recovery (workspace_id, state, expires_at DESC);
    CREATE TABLE IF NOT EXISTS conversation_run_schema_migration (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  ensureColumn(db, "conversation_run", "client_message_id", "client_message_id TEXT");
  ensureColumn(db, "conversation_run", "opencode_message_id", "opencode_message_id TEXT");
  ensureColumn(db, "conversation_run", "origin", "origin TEXT");
  ensureColumn(db, "conversation_run", "expects_ai_gateway_start", "expects_ai_gateway_start INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "conversation_run", "runtime_authorization_actor_token_hash", "runtime_authorization_actor_token_hash TEXT");
  ensureColumn(db, "conversation_run", "runtime_authorization_org_id", "runtime_authorization_org_id TEXT");
  ensureColumn(db, "conversation_run", "engine_slot_id", "engine_slot_id TEXT");
  ensureColumn(db, "conversation_run", "engine_owner_id", "engine_owner_id TEXT");
  ensureColumn(db, "conversation_run", "engine_owner_state", "engine_owner_state TEXT NOT NULL DEFAULT 'pending'");
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
    CREATE TRIGGER IF NOT EXISTS conversation_run_gateway_recovery_terminalize
      AFTER UPDATE OF status ON conversation_run
      WHEN NEW.status IN ('completed', 'failed', 'aborted')
      BEGIN
        UPDATE conversation_run_gateway_recovery
        SET state = 'terminal'
        WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id;
      END;
    CREATE TRIGGER IF NOT EXISTS conversation_run_gateway_recovery_owner_update
      AFTER UPDATE OF engine_slot_id, engine_owner_id, engine_pid, engine_started_at, engine_base_url ON conversation_run
      BEGIN
        UPDATE conversation_run_gateway_recovery
        SET engine_slot_id = NEW.engine_slot_id,
            engine_owner_id = NEW.engine_owner_id,
            engine_pid = NEW.engine_pid,
            engine_started_at = NEW.engine_started_at,
            engine_base_url = NEW.engine_base_url
        WHERE workspace_id = NEW.workspace_id
          AND run_id = NEW.run_id
          AND state = 'active';
      END;
  `);
  const backfilled = db.query<{ name: string }, [string]>(
    "SELECT name FROM conversation_run_schema_migration WHERE name = ?1",
  ).get(GATEWAY_RECOVERY_DESCRIPTOR_BACKFILL_MIGRATION);
  if (!backfilled) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const backfilledInsideTransaction = db.query<{ name: string }, [string]>(
        "SELECT name FROM conversation_run_schema_migration WHERE name = ?1",
      ).get(GATEWAY_RECOVERY_DESCRIPTOR_BACKFILL_MIGRATION);
      if (!backfilledInsideTransaction) {
        db.exec(`
          INSERT OR IGNORE INTO conversation_run_gateway_recovery (
            workspace_id, run_id, conversation_id, engine_session_id,
            actor_token_hash, organization_id, issued_at, expires_at, state,
            engine_slot_id, engine_owner_id, engine_pid, engine_started_at, engine_base_url
          )
          SELECT workspace_id, run_id, conversation_id, engine_session_id,
                 runtime_authorization_actor_token_hash,
                 runtime_authorization_org_id,
                 created_at,
                 created_at + ${GATEWAY_RECOVERY_DESCRIPTOR_TTL_MS},
                 CASE WHEN status IN (${ACTIVE_RUN_STATUS_SQL_LIST}) THEN 'active' ELSE 'terminal' END,
                 engine_slot_id, engine_owner_id, engine_pid, engine_started_at, engine_base_url
          FROM conversation_run
          WHERE expects_ai_gateway_start = 1
            AND runtime_authorization_actor_token_hash IS NOT NULL
            AND runtime_authorization_org_id IS NOT NULL;
        `);
        db.query(
          "INSERT INTO conversation_run_schema_migration (name, applied_at) VALUES (?1, ?2)",
        ).run(GATEWAY_RECOVERY_DESCRIPTOR_BACKFILL_MIGRATION, Date.now());
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
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
        db.exec("BEGIN IMMEDIATE");
        try {
        db.query(
          `INSERT INTO conversation_run (
            workspace_id,
            conversation_id,
            run_id,
            engine_session_id,
            client_message_id,
            opencode_message_id,
            origin,
            expects_ai_gateway_start,
            runtime_authorization_actor_token_hash,
            runtime_authorization_org_id,
            directory,
            kind,
            status,
            abort_requested,
            created_at,
            started_at,
            completed_at,
            error,
            engine_slot_id,
            engine_owner_id,
            engine_owner_state,
            engine_pid,
            engine_started_at,
            engine_base_url,
            activity_kind,
            wait_reason,
            last_useful_progress_at,
            retry_since,
            last_progress_signature
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)
          `,
        ).run(
          record.workspaceId,
          record.conversationId,
          record.runId,
          record.engineSessionId,
          record.clientMessageId,
          record.opencodeMessageId ?? null,
          record.origin,
          record.expectsAiGatewayStart === true ? 1 : 0,
          record.runtimeAuthorizationActorTokenHash ?? null,
          record.runtimeAuthorizationOrgId ?? null,
          record.directory,
          record.kind,
          record.status,
          record.abortRequested ? 1 : 0,
          record.createdAt,
          record.startedAt,
          record.completedAt,
          record.error,
          record.engineSlotId,
          record.engineOwnerId,
          record.engineOwnerState,
          record.enginePid,
          record.engineStartedAt,
          record.engineBaseUrl,
          record.activityKind,
          record.waitReason,
          record.lastUsefulProgressAt,
          record.retrySince,
          record.lastProgressSignature,
        );
        if (
          record.expectsAiGatewayStart === true &&
          record.runtimeAuthorizationActorTokenHash?.trim() &&
          record.runtimeAuthorizationOrgId?.trim()
        ) {
          db.query(
            `INSERT INTO conversation_run_gateway_recovery (
              workspace_id, run_id, conversation_id, engine_session_id,
              actor_token_hash, organization_id, issued_at, expires_at, state,
              engine_slot_id, engine_owner_id, engine_pid, engine_started_at, engine_base_url
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11, ?12, ?13)`,
          ).run(
            record.workspaceId,
            record.runId,
            record.conversationId,
            record.engineSessionId,
            record.runtimeAuthorizationActorTokenHash.trim(),
            record.runtimeAuthorizationOrgId.trim(),
            record.createdAt,
            record.createdAt + GATEWAY_RECOVERY_DESCRIPTOR_TTL_MS,
            record.engineSlotId,
            record.engineOwnerId,
            record.enginePid,
            record.engineStartedAt,
            record.engineBaseUrl,
          );
        }
        db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch {}
          throw error;
        }
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
            opencode_message_id = ?6,
            origin = ?7,
            expects_ai_gateway_start = ?8,
            runtime_authorization_actor_token_hash = ?9,
            runtime_authorization_org_id = ?10,
            directory = ?11,
            kind = ?12,
            status = ?13,
            abort_requested = ?14,
            created_at = ?15,
            started_at = ?16,
            completed_at = ?17,
            error = ?18,
            engine_slot_id = ?19,
            engine_owner_id = ?20,
            engine_owner_state = ?21,
            engine_pid = ?22,
            engine_started_at = ?23,
            engine_base_url = ?24,
            activity_kind = ?25,
            wait_reason = ?26,
            last_useful_progress_at = ?27,
            retry_since = ?28,
            last_progress_signature = ?29
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(
          workspaceId,
          runId,
          next.conversationId,
          next.engineSessionId,
          next.clientMessageId,
          next.opencodeMessageId ?? null,
          next.origin,
          next.expectsAiGatewayStart === true ? 1 : 0,
          next.runtimeAuthorizationActorTokenHash ?? null,
          next.runtimeAuthorizationOrgId ?? null,
          next.directory,
          next.kind,
          next.status,
          next.abortRequested ? 1 : 0,
          next.createdAt,
          next.startedAt,
          next.completedAt,
          next.error,
          next.engineSlotId,
          next.engineOwnerId,
          next.engineOwnerState,
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

    activeForEngineSession(input) {
      return withDb((db) => {
        const row = db.query<RunRow, [string, string, string, number, number, string]>(
          `SELECT * FROM conversation_run
           WHERE workspace_id = ?1
             AND engine_session_id = ?2
             AND engine_owner_id = ?3
             AND engine_pid = ?4
             AND engine_started_at = ?5
             AND engine_base_url = ?6
             AND engine_owner_state = 'attached'
             AND status IN (${ACTIVE_RUN_STATUS_SQL_LIST})
           ORDER BY created_at DESC
           LIMIT 1`,
        ).get(
          input.workspaceId,
          input.engineSessionId,
          input.engineOwnerId,
          input.enginePid,
          input.engineStartedAt,
          input.engineBaseUrl,
        );
        return row ? rowToRecord(row) : null;
      });
    },

    activeForEngineOwner(engineOwnerId) {
      return withDb((db) => {
        const row = db.query<RunRow, [string]>(
          `SELECT * FROM conversation_run
           WHERE engine_owner_id = ?1
             AND engine_owner_state = 'attached'
             AND status IN (${ACTIVE_RUN_STATUS_SQL_LIST})
           ORDER BY created_at ASC`,
        ).all(engineOwnerId);
        return row.map(rowToRecord);
      });
    },

    activeManagedGatewayRuns(workspaceId) {
      return withDb((db) => {
        const rows = db.query<RunRow, [string]>(
          `SELECT run.*,
                  recovery.actor_token_hash AS gateway_recovery_actor_token_hash,
                  recovery.organization_id AS gateway_recovery_organization_id,
                  recovery.expires_at AS gateway_recovery_expires_at,
                  recovery.state AS gateway_recovery_state
           FROM conversation_run AS run
           LEFT JOIN conversation_run_gateway_recovery AS recovery
             ON recovery.workspace_id = run.workspace_id AND recovery.run_id = run.run_id
           WHERE run.workspace_id = ?1
             AND run.status IN (${ACTIVE_RUN_STATUS_SQL_LIST})
             AND run.expects_ai_gateway_start = 1
           ORDER BY run.created_at DESC`,
        ).all(workspaceId);
        return rows.map(rowToRecord);
      });
    },

    terminalAttachedWithEngineOwner(limit = 500) {
      const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5_000) : 500;
      return withDb((db) => {
        const rows = db.query<RunRow, [number]>(
          `SELECT * FROM conversation_run
           WHERE engine_owner_state = 'attached'
             AND engine_owner_id IS NOT NULL
             AND engine_pid IS NOT NULL
             AND engine_started_at IS NOT NULL
             AND engine_base_url IS NOT NULL
             AND status IN ('completed', 'failed', 'aborted')
           ORDER BY completed_at ASC, created_at ASC
           LIMIT ?1`,
        ).all(safeLimit);
        return rows.map(rowToRecord);
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

        db.exec("BEGIN IMMEDIATE");
        try {
          const result = db.query(
            `UPDATE conversation_run
             SET workspace_id = ?1,
                 engine_owner_id = CASE
                   WHEN engine_owner_id = ?2 THEN ?1
                   ELSE engine_owner_id
                 END
             WHERE workspace_id = ?2`,
          ).run(target, source);
          db.query(
            `UPDATE conversation_run_gateway_recovery
             SET workspace_id = ?1
             WHERE workspace_id = ?2`,
          ).run(target, source);
          db.exec("COMMIT");
          return {
            ...base,
            migrated: true,
            updated: Number(result.changes ?? sourceCount),
            reason: "migrated",
          };
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch {}
          throw error;
        }
      });
    },

    hasActiveForWorkspace(workspaceId, createdSince, options) {
      const excludedRunId = options?.excludeRunId?.trim() ?? "";
      return withDb((db) => {
        const row = db.query<{ present: number }, [string, number, string]>(
          `SELECT 1 AS present FROM conversation_run
           WHERE workspace_id = ?1
             AND status IN (${ACTIVE_RUN_STATUS_SQL_LIST})
             AND created_at >= ?2
             AND (?3 = '' OR run_id <> ?3)
           LIMIT 1`,
        ).get(workspaceId, createdSince, excludedRunId);
        return Boolean(row);
      });
    },
  };
}
