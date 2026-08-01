import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

export type ConversationRunQueueState = "pending" | "starting" | "submitted" | "failed" | "cancelled" | "conflict";
export type ConversationRunQueueReadableState = Extract<ConversationRunQueueState, "pending" | "starting" | "failed">;

export type ConversationRunQueueCursor = {
  createdAt: number;
  queueItemId: string;
};

export type ConversationRunQueuePage = {
  items: Array<{
    item: ConversationRunQueueItem;
    queuePosition: number | null;
  }>;
  nextCursor: ConversationRunQueueCursor | null;
};

export type ConversationRunQueueAdmissionClaim = {
  item: ConversationRunQueueItem;
  reservation: ConversationWorkspaceRunReservation;
};

export const CONVERSATION_RUN_QUEUE_READABLE_STATES = ["pending", "starting", "failed"] as const;
const conversationRunQueueReadableStateSet = new Set<string>(CONVERSATION_RUN_QUEUE_READABLE_STATES);
export const CONVERSATION_RUN_QUEUE_MAX_READ_LIMIT = 100;

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
  idempotencyConflictClientMessageId: string | null;
};

export type ConversationWorkspaceRunReservation = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  state: "starting" | "active" | "terminalization_pending";
  terminalizationReason: string | null;
  terminalizationAttempts: number;
  terminalizationLastError: string | null;
  terminalizationNextAttemptAt: number | null;
  terminalizationDeadlineAt: number | null;
  engineSlotId: string | null;
  engineOwnerId: string | null;
  directoryInstanceEpoch: number | null;
  enginePid: number | null;
  engineStartedAt: number | null;
  engineBaseUrl: string | null;
  skillViewRevision: string | null;
  authorizationRevision: string | null;
  openCodeConfigDigest: string | null;
  providerStartAbortPending?: boolean;
  providerStartAbortDirectory?: string | null;
  providerStartAbortOpenCodeSessionId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ConversationWorkspaceRunEngineOwner = {
  engineSlotId: string;
  engineOwnerId: string;
  directoryInstanceEpoch?: number | null;
  enginePid: number;
  engineStartedAt: number;
  engineBaseUrl: string;
  skillViewRevision?: string | null;
  authorizationRevision?: string | null;
  openCodeConfigDigest?: string | null;
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
  listForConversation(input: {
    workspaceId: string;
    conversationId: string;
    states: ConversationRunQueueReadableState[];
    cursor?: ConversationRunQueueCursor | null;
    limit: number;
  }): ConversationRunQueuePage;
  markStarting(queueItemId: string): ConversationRunQueueItem | null;
  claimStartingWithReservation(queueItemId: string): ConversationRunQueueAdmissionClaim | null;
  markPending(queueItemId: string, activeRunId?: string | null): ConversationRunQueueItem | null;
  markSubmitted(queueItemId: string): ConversationRunQueueItem | null;
  markFailed(queueItemId: string, error: string): ConversationRunQueueItem | null;
  getForConversation(
    workspaceId: string,
    conversationId: string,
    queueItemId: string,
  ): ConversationRunQueueItem | null;
  getForReservedRun(
    workspaceId: string,
    conversationId: string,
    reservedRunId: string,
  ): ConversationRunQueueItem | null;
  listStarting(): ConversationRunQueueItem[];
  pendingConversationKeys(): Array<{ workspaceId: string; conversationId: string }>;
  reserveWorkspaceRun(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    directory?: string | null;
    opencodeSessionId?: string | null;
    state?: ConversationWorkspaceRunReservation["state"];
  }): ConversationWorkspaceRunReservation;
  attachWorkspaceRunEngineOwner(
    workspaceId: string,
    runId: string,
    owner: ConversationWorkspaceRunEngineOwner,
  ): ConversationWorkspaceRunReservation | null;
  activateWorkspaceRun(workspaceId: string, runId: string): ConversationWorkspaceRunReservation | null;
  markWorkspaceRunTerminalizationPending(input: {
    workspaceId: string;
    runId: string;
    reason: string;
    attempts: number;
    lastError: string;
    nextAttemptAt: number;
    deadlineAt: number;
  }): ConversationWorkspaceRunReservation | null;
  markWorkspaceRunProviderStartAbortPending(input: {
    workspaceId: string;
    runId: string;
    directory: string;
    opencodeSessionId: string;
  }): ConversationWorkspaceRunReservation | null;
  releaseWorkspaceRun(workspaceId: string, runId: string): boolean;
  listWorkspaceRunReservations(): ConversationWorkspaceRunReservation[];
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
  request_hash: string | null;
  state: string;
  active_run_id: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  submitted_at: number | null;
  completed_at: number | null;
  error: string | null;
  idempotency_conflict_client_message_id: string | null;
};

type WorkspaceRunReservationRow = {
  workspace_id: string;
  conversation_id: string;
  run_id: string;
  state: string;
  engine_slot_id: string | null;
  engine_owner_id: string | null;
  directory_instance_epoch: number | null;
  engine_pid: number | null;
  engine_started_at: number | null;
  engine_base_url: string | null;
  skill_view_revision: string | null;
  authorization_revision: string | null;
  opencode_config_digest: string | null;
  terminalization_reason: string | null;
  terminalization_attempts: number | null;
  terminalization_last_error: string | null;
  terminalization_next_attempt_at: number | null;
  terminalization_deadline_at: number | null;
  provider_start_abort_pending: number | null;
  provider_start_abort_directory: string | null;
  provider_start_abort_opencode_session_id: string | null;
  created_at: number;
  updated_at: number;
};

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

export class ConversationRunQueueConflictError extends Error {
  readonly code = "queue_idempotency_conflict";

  constructor(message = "clientMessageId was already used for a different queued run request") {
    super(message);
    this.name = "ConversationRunQueueConflictError";
  }
}

export class ConversationRunReservationConflictError extends Error {
  readonly activeRunId: string;

  constructor(activeRunId: string) {
    super("conversation_run_reservation_active");
    this.name = "ConversationRunReservationConflictError";
    this.activeRunId = activeRunId;
  }
}

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
      request_hash TEXT,
      state TEXT NOT NULL,
      active_run_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      submitted_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      idempotency_conflict_client_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS conversation_run_queue_pending_idx
      ON conversation_run_queue (workspace_id, conversation_id, state, created_at, queue_item_id);
    CREATE INDEX IF NOT EXISTS conversation_run_queue_reserved_run_idx
      ON conversation_run_queue (workspace_id, conversation_id, reserved_run_id);
    CREATE TABLE IF NOT EXISTS conversation_workspace_run_reservation (
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      state TEXT NOT NULL,
      engine_slot_id TEXT,
      engine_owner_id TEXT,
      directory_instance_epoch INTEGER,
      engine_pid INTEGER,
      engine_started_at INTEGER,
      engine_base_url TEXT,
      skill_view_revision TEXT,
      authorization_revision TEXT,
      opencode_config_digest TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_workspace_run_reservation_workspace_idx
      ON conversation_workspace_run_reservation (workspace_id, state, updated_at);
  `);
  ensureQueueSchema(db);
  return db;
}

function ensureQueueSchema(db: Database): void {
  db.exec("DROP INDEX IF EXISTS conversation_run_queue_client_message_uidx");
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(conversation_run_queue)").all();
  if (!columns.some((column) => column.name === "request_hash")) {
    db.exec("ALTER TABLE conversation_run_queue ADD COLUMN request_hash TEXT");
  }
  if (!columns.some((column) => column.name === "idempotency_conflict_client_message_id")) {
    db.exec("ALTER TABLE conversation_run_queue ADD COLUMN idempotency_conflict_client_message_id TEXT");
  }
  const reservationColumns = db.query<{ name: string }, []>(
    "PRAGMA table_info(conversation_workspace_run_reservation)",
  ).all();
  const addReservationColumn = (name: string, definition: string) => {
    if (!reservationColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE conversation_workspace_run_reservation ADD COLUMN ${name} ${definition}`);
    }
  };
  addReservationColumn("engine_slot_id", "TEXT");
  addReservationColumn("engine_owner_id", "TEXT");
  addReservationColumn("directory_instance_epoch", "INTEGER");
  addReservationColumn("engine_pid", "INTEGER");
  addReservationColumn("engine_started_at", "INTEGER");
  addReservationColumn("engine_base_url", "TEXT");
  addReservationColumn("skill_view_revision", "TEXT");
  addReservationColumn("authorization_revision", "TEXT");
  addReservationColumn("opencode_config_digest", "TEXT");
  addReservationColumn("terminalization_reason", "TEXT");
  addReservationColumn("terminalization_attempts", "INTEGER");
  addReservationColumn("terminalization_last_error", "TEXT");
  addReservationColumn("terminalization_next_attempt_at", "INTEGER");
  addReservationColumn("terminalization_deadline_at", "INTEGER");
  addReservationColumn("provider_start_abort_pending", "INTEGER NOT NULL DEFAULT 0");
  addReservationColumn("provider_start_abort_directory", "TEXT");
  addReservationColumn("provider_start_abort_opencode_session_id", "TEXT");
  const legacyRows = db.query<QueueRow, []>(
    `SELECT * FROM conversation_run_queue
     WHERE request_hash IS NULL OR request_hash = ''`,
  ).all();
  const update = db.query(`UPDATE conversation_run_queue SET request_hash = ?1 WHERE queue_item_id = ?2`);
  if (legacyRows.length > 0) {
    db.transaction(() => {
      for (const row of legacyRows) {
        update.run(queueRequestHash({
          conversationId: row.conversation_id,
          opencodeSessionId: row.opencode_session_id,
          directory: row.directory,
          kind: row.kind,
          bodyJson: row.body_json,
          origin: row.origin,
        }), row.queue_item_id);
      }
    })();
  }

  const duplicateGroups = db.query<{ workspace_id: string; client_message_id: string }, []>(
    `SELECT workspace_id, client_message_id
     FROM conversation_run_queue
     WHERE client_message_id IS NOT NULL AND client_message_id <> ''
     GROUP BY workspace_id, client_message_id
     HAVING COUNT(*) > 1`,
  ).all();
  const duplicateRows = db.query<QueueRow, [string, string]>(
    `SELECT * FROM conversation_run_queue
     WHERE workspace_id = ?1 AND client_message_id = ?2
     ORDER BY created_at ASC, queue_item_id ASC`,
  );
  const markPendingConflict = db.query(
    `UPDATE conversation_run_queue
     SET state = 'conflict', error = ?1, active_run_id = NULL,
         idempotency_conflict_client_message_id = client_message_id,
         client_message_id = NULL, updated_at = updated_at
     WHERE queue_item_id = ?2`,
  );
  const detachSubmittedConflict = db.query(
    `UPDATE conversation_run_queue
     SET error = ?1,
         idempotency_conflict_client_message_id = client_message_id,
         client_message_id = NULL, updated_at = updated_at
     WHERE queue_item_id = ?2`,
  );
  db.transaction(() => {
    for (const group of duplicateGroups) {
      const rows = duplicateRows.all(group.workspace_id, group.client_message_id);
      const canonical = rows[0];
      if (!canonical) continue;
      for (const duplicate of rows.slice(1)) {
        const detail = `idempotency_conflict:migrated_duplicate_of:${canonical.queue_item_id}`;
        if (duplicate.state === "submitted") {
          detachSubmittedConflict.run(detail, duplicate.queue_item_id);
        } else {
          markPendingConflict.run(detail, duplicate.queue_item_id);
        }
      }
    }
  })();

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_run_queue_client_message_uidx
      ON conversation_run_queue (workspace_id, client_message_id)
      WHERE client_message_id IS NOT NULL AND client_message_id <> '';
  `);
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
    idempotencyConflictClientMessageId: row.idempotency_conflict_client_message_id ?? null,
  };
}

function getSync(db: Database, queueItemId: string): ConversationRunQueueItem | null {
  const row = db.query<QueueRow, [string]>(
    `SELECT * FROM conversation_run_queue WHERE queue_item_id = ?1 LIMIT 1`,
  ).get(queueItemId);
  return row ? rowToItem(row) : null;
}

function reservationRowToItem(row: WorkspaceRunReservationRow): ConversationWorkspaceRunReservation {
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    state: row.state === "terminalization_pending"
      ? "terminalization_pending"
      : row.state === "active" ? "active" : "starting",
    terminalizationReason: row.terminalization_reason?.trim() || null,
    terminalizationAttempts: Number.isSafeInteger(row.terminalization_attempts)
      ? Math.max(0, Number(row.terminalization_attempts))
      : 0,
    terminalizationLastError: row.terminalization_last_error?.trim() || null,
    terminalizationNextAttemptAt: typeof row.terminalization_next_attempt_at === "number"
      ? row.terminalization_next_attempt_at
      : null,
    terminalizationDeadlineAt: typeof row.terminalization_deadline_at === "number"
      ? row.terminalization_deadline_at
      : null,
    providerStartAbortPending: row.provider_start_abort_pending === 1,
    providerStartAbortDirectory: row.provider_start_abort_directory?.trim() || null,
    providerStartAbortOpenCodeSessionId: row.provider_start_abort_opencode_session_id?.trim() || null,
    engineSlotId: row.engine_slot_id?.trim() || null,
    engineOwnerId: row.engine_owner_id?.trim() || null,
    directoryInstanceEpoch:
      typeof row.directory_instance_epoch === "number" && Number.isSafeInteger(row.directory_instance_epoch)
        ? row.directory_instance_epoch
        : null,
    enginePid: typeof row.engine_pid === "number" && Number.isFinite(row.engine_pid) ? row.engine_pid : null,
    engineStartedAt: typeof row.engine_started_at === "number" && Number.isFinite(row.engine_started_at)
      ? row.engine_started_at
      : null,
    engineBaseUrl: row.engine_base_url?.trim() || null,
    skillViewRevision: row.skill_view_revision?.trim() || null,
    authorizationRevision: row.authorization_revision?.trim() || null,
    openCodeConfigDigest: row.opencode_config_digest?.trim() || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function queueRequestHash(input: {
  conversationId: string;
  opencodeSessionId: string;
  directory: string;
  kind: string;
  bodyJson: string;
  origin?: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    conversationId: normalizeText(input.conversationId),
    opencodeSessionId: normalizeText(input.opencodeSessionId),
    directory: normalizeText(input.directory),
    kind: normalizeText(input.kind),
    bodyJson: normalizeText(input.bodyJson),
    origin: normalizeText(input.origin) || null,
  })).digest("hex");
}

function rowRequestHash(row: QueueRow): string {
  return row.request_hash || queueRequestHash({
    conversationId: row.conversation_id,
    opencodeSessionId: row.opencode_session_id,
    directory: row.directory,
    kind: row.kind,
    bodyJson: row.body_json,
    origin: row.origin,
  });
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
        const requestHash = queueRequestHash({
          conversationId,
          opencodeSessionId,
          directory,
          kind,
          bodyJson,
          origin: input.origin,
        });

        const clientMessageId = normalizeText(input.clientMessageId) || null;
        if (clientMessageId) {
          const existing = db.query<QueueRow, [string, string]>(
            `SELECT * FROM conversation_run_queue
             WHERE workspace_id = ?1 AND client_message_id = ?2
             LIMIT 1`,
          ).get(workspaceId, clientMessageId);
          if (existing) {
            if (rowRequestHash(existing) !== requestHash) {
              throw new ConversationRunQueueConflictError();
            }
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
            request_hash,
            state,
            active_run_id,
            attempts,
            created_at,
            updated_at,
            started_at,
            submitted_at,
            completed_at,
            error
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, 0, ?13, ?13, NULL, NULL, NULL, NULL)`,
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
          requestHash,
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

    listForConversation(input) {
      return withDb((db) => {
        const workspaceId = normalizeText(input.workspaceId);
        const conversationId = normalizeText(input.conversationId);
        if (!workspaceId || !conversationId) {
          throw new Error("workspaceId and conversationId are required");
        }
        const states = [...new Set(input.states.map((state) => normalizeText(state)))];
        if (states.length === 0 || states.some((state) => !conversationRunQueueReadableStateSet.has(state))) {
          throw new Error("states must contain only pending, starting, or failed");
        }
        if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > CONVERSATION_RUN_QUEUE_MAX_READ_LIMIT) {
          throw new Error(`limit must be an integer from 1 to ${CONVERSATION_RUN_QUEUE_MAX_READ_LIMIT}`);
        }
        const cursor = input.cursor ?? null;
        if (
          cursor &&
          (!Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0 || !normalizeText(cursor.queueItemId))
        ) {
          throw new Error("cursor is invalid");
        }

        const parameters: Array<string | number> = [workspaceId, conversationId, ...states];
        const cursorClause = cursor
          ? " AND (created_at > ? OR (created_at = ? AND queue_item_id > ?))"
          : "";
        if (cursor) parameters.push(cursor.createdAt, cursor.createdAt, cursor.queueItemId);
        parameters.push(input.limit + 1);
        const statePlaceholders = states.map(() => "?").join(", ");
        const rows = db.query<QueueRow, Array<string | number>>(
          `SELECT * FROM conversation_run_queue
           WHERE workspace_id = ?
             AND conversation_id = ?
             AND state IN (${statePlaceholders})${cursorClause}
           ORDER BY created_at ASC, queue_item_id ASC
           LIMIT ?`,
        ).all(...parameters);
        const hasMore = rows.length > input.limit;
        const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
        const items = pageRows.map((row) => {
          const item = rowToItem(row);
          return {
            item,
            queuePosition: item.state === "pending" || item.state === "starting"
              ? queuePositionSync(db, item)
              : null,
          };
        });
        const last = items.at(-1)?.item;
        return {
          items,
          nextCursor: hasMore && last
            ? { createdAt: last.createdAt, queueItemId: last.queueItemId }
            : null,
        };
      });
    },

    markStarting(queueItemId) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_run_queue
           SET state = 'starting',
               attempts = attempts + 1,
               started_at = ?2,
               updated_at = ?2,
               error = NULL
           WHERE queue_item_id = ?1 AND state = 'pending'`,
        ).run(queueItemId, timestamp);
        if (result.changes !== 1) return null;
        return getSync(db, queueItemId);
      });
    },

    markPending(queueItemId, activeRunId) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_run_queue
           SET state = 'pending',
               active_run_id = ?2,
               started_at = NULL,
               updated_at = ?3
           WHERE queue_item_id = ?1 AND state = 'starting'`,
        ).run(queueItemId, normalizeText(activeRunId) || null, timestamp);
        if (result.changes !== 1) return null;
        return getSync(db, queueItemId);
      });
    },

    markSubmitted(queueItemId) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_run_queue
           SET state = 'submitted',
               submitted_at = ?2,
               completed_at = ?2,
               updated_at = ?2
           WHERE queue_item_id = ?1 AND state = 'starting'`,
        ).run(queueItemId, timestamp);
        if (result.changes !== 1) return null;
        return getSync(db, queueItemId);
      });
    },

    markFailed(queueItemId, error) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_run_queue
           SET state = 'failed',
               error = ?2,
               completed_at = ?3,
               updated_at = ?3
           WHERE queue_item_id = ?1 AND state = 'starting'`,
        ).run(queueItemId, normalizeText(error) || "queued run failed", timestamp);
        if (result.changes !== 1) return null;
        return getSync(db, queueItemId);
      });
    },

    getForConversation(workspaceId, conversationId, queueItemId) {
      return withDb((db) => {
        const row = db.query<QueueRow, [string, string, string]>(
          `SELECT * FROM conversation_run_queue
           WHERE workspace_id = ?1
             AND conversation_id = ?2
             AND queue_item_id = ?3
           LIMIT 1`,
        ).get(
          normalizeText(workspaceId),
          normalizeText(conversationId),
          normalizeText(queueItemId),
        );
        return row ? rowToItem(row) : null;
      });
    },

    getForReservedRun(workspaceId, conversationId, reservedRunId) {
      return withDb((db) => {
        const row = db.query<QueueRow, [string, string, string]>(
          `SELECT * FROM conversation_run_queue
           WHERE workspace_id = ?1
             AND conversation_id = ?2
             AND reserved_run_id = ?3
           LIMIT 1`,
        ).get(
          normalizeText(workspaceId),
          normalizeText(conversationId),
          normalizeText(reservedRunId),
        );
        return row ? rowToItem(row) : null;
      });
    },

    listStarting() {
      return withDb((db) => {
        return db.query<QueueRow, []>(
          `SELECT * FROM conversation_run_queue
           WHERE state = 'starting'
           ORDER BY created_at ASC, queue_item_id ASC`,
        ).all().map(rowToItem);
      });
    },

    claimStartingWithReservation(queueItemId) {
      return withDb((db) => db.transaction(() => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_run_queue
           SET state = 'starting',
               attempts = attempts + 1,
               started_at = ?2,
               updated_at = ?2,
               error = NULL
           WHERE queue_item_id = ?1 AND state = 'pending'`,
        ).run(queueItemId, timestamp);
        if (result.changes !== 1) return null;
        const row = db.query<QueueRow, [string]>(
          `SELECT * FROM conversation_run_queue WHERE queue_item_id = ?1 LIMIT 1`,
        ).get(queueItemId);
        if (!row) return null;
        const conflict = db.query<{ run_id: string }, [string, string, string]>(
          `SELECT run_id FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1
             AND conversation_id = ?2
             AND run_id <> ?3
             AND state IN ('starting', 'active', 'terminalization_pending')
           ORDER BY created_at ASC, run_id ASC
           LIMIT 1`,
        ).get(row.workspace_id, row.conversation_id, row.reserved_run_id);
        if (conflict?.run_id) throw new ConversationRunReservationConflictError(conflict.run_id);
        db.query(
          `INSERT INTO conversation_workspace_run_reservation (
            workspace_id, conversation_id, run_id, state,
            provider_start_abort_directory, provider_start_abort_opencode_session_id,
            created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'starting', ?4, ?5, ?6, ?6)
          ON CONFLICT(workspace_id, run_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            state = excluded.state,
            provider_start_abort_directory = excluded.provider_start_abort_directory,
            provider_start_abort_opencode_session_id = excluded.provider_start_abort_opencode_session_id,
            updated_at = excluded.updated_at`,
        ).run(
          row.workspace_id,
          row.conversation_id,
          row.reserved_run_id,
          row.directory,
          row.opencode_session_id,
          timestamp,
        );
        const reservation = db.query<WorkspaceRunReservationRow, [string, string]>(
          `SELECT * FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1 AND run_id = ?2 LIMIT 1`,
        ).get(row.workspace_id, row.reserved_run_id);
        if (!reservation) throw new Error("failed to reserve claimed conversation run");
        return { item: rowToItem(row), reservation: reservationRowToItem(reservation) };
      })());
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

    reserveWorkspaceRun(input) {
      return withDb((db) => db.transaction(() => {
        const workspaceId = normalizeText(input.workspaceId);
        const conversationId = normalizeText(input.conversationId);
        const runId = normalizeText(input.runId);
        if (!workspaceId || !conversationId || !runId) {
          throw new Error("workspaceId, conversationId, and runId are required");
        }
        const timestamp = now();
        const state = input.state === "active" ? "active" : "starting";
        const directory = normalizeText(input.directory) || null;
        const opencodeSessionId = normalizeText(input.opencodeSessionId) || null;
        const conflicting = db.query<{ run_id: string }, [string, string, string]>(
          `SELECT run_id FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1
             AND conversation_id = ?2
             AND run_id <> ?3
             AND state IN ('starting', 'active', 'terminalization_pending')
           ORDER BY created_at ASC, run_id ASC
           LIMIT 1`,
        ).get(workspaceId, conversationId, runId);
        if (conflicting?.run_id) {
          throw new ConversationRunReservationConflictError(conflicting.run_id);
        }
        db.query(
          `INSERT INTO conversation_workspace_run_reservation (
            workspace_id, conversation_id, run_id, state,
            provider_start_abort_directory, provider_start_abort_opencode_session_id,
            created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
          ON CONFLICT(workspace_id, run_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            state = excluded.state,
            provider_start_abort_directory = excluded.provider_start_abort_directory,
            provider_start_abort_opencode_session_id = excluded.provider_start_abort_opencode_session_id,
            updated_at = excluded.updated_at`,
        ).run(workspaceId, conversationId, runId, state, directory, opencodeSessionId, timestamp);
        const row = db.query<WorkspaceRunReservationRow, [string, string]>(
          `SELECT * FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1 AND run_id = ?2 LIMIT 1`,
        ).get(workspaceId, runId);
        if (!row) throw new Error("failed to reserve workspace conversation run");
        return reservationRowToItem(row);
      })());
    },

    attachWorkspaceRunEngineOwner(workspaceId, runId, owner) {
      return withDb((db) => {
        const normalizedWorkspaceId = normalizeText(workspaceId);
        const normalizedRunId = normalizeText(runId);
        const normalizedSlotId = normalizeText(owner.engineSlotId);
        const normalizedOwnerId = normalizeText(owner.engineOwnerId);
        const normalizedBaseUrl = normalizeText(owner.engineBaseUrl);
        const normalizedSkillViewRevision = normalizeText(owner.skillViewRevision);
        const normalizedAuthorizationRevision = normalizeText(owner.authorizationRevision);
        const normalizedOpenCodeConfigDigest = normalizeText(owner.openCodeConfigDigest);
        if (!normalizedWorkspaceId || !normalizedRunId || !normalizedSlotId || !normalizedOwnerId || !normalizedBaseUrl) return null;
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_workspace_run_reservation
           SET engine_slot_id = ?3,
               engine_owner_id = ?4,
               directory_instance_epoch = ?5,
               engine_pid = ?6,
               engine_started_at = ?7,
               engine_base_url = ?8,
               skill_view_revision = ?9,
               authorization_revision = ?10,
               opencode_config_digest = ?11,
               updated_at = ?12
           WHERE workspace_id = ?1
             AND run_id = ?2
             AND (
               engine_owner_id IS NULL
             OR (
                 engine_slot_id = ?3
                 AND engine_owner_id = ?4
                 AND COALESCE(directory_instance_epoch, -1) = COALESCE(?5, -1)
                 AND engine_pid = ?6
                 AND engine_started_at = ?7
                 AND engine_base_url = ?8
                 AND COALESCE(skill_view_revision, '') = ?9
                 AND COALESCE(authorization_revision, '') = ?10
                 AND COALESCE(opencode_config_digest, '') = ?11
               )
             )`,
        ).run(
          normalizedWorkspaceId,
          normalizedRunId,
          normalizedSlotId,
          normalizedOwnerId,
          owner.directoryInstanceEpoch ?? null,
          owner.enginePid,
          owner.engineStartedAt,
          normalizedBaseUrl,
          normalizedSkillViewRevision,
          normalizedAuthorizationRevision,
          normalizedOpenCodeConfigDigest,
          timestamp,
        );
        if (result.changes !== 1) return null;
        const row = db.query<WorkspaceRunReservationRow, [string, string]>(
          `SELECT * FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1 AND run_id = ?2 LIMIT 1`,
        ).get(normalizedWorkspaceId, normalizedRunId);
        return row ? reservationRowToItem(row) : null;
      });
    },

    activateWorkspaceRun(workspaceId, runId) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_workspace_run_reservation
           SET state = 'active', updated_at = ?3
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(normalizeText(workspaceId), normalizeText(runId), timestamp);
        if (result.changes !== 1) return null;
        const row = db.query<WorkspaceRunReservationRow, [string, string]>(
          `SELECT * FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1 AND run_id = ?2 LIMIT 1`,
        ).get(normalizeText(workspaceId), normalizeText(runId));
        return row ? reservationRowToItem(row) : null;
      });
    },

    markWorkspaceRunTerminalizationPending(input) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_workspace_run_reservation
           SET state = 'terminalization_pending',
               terminalization_reason = ?3,
               terminalization_attempts = ?4,
               terminalization_last_error = ?5,
               terminalization_next_attempt_at = ?6,
               terminalization_deadline_at = ?7,
               updated_at = ?8
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(
          normalizeText(input.workspaceId),
          normalizeText(input.runId),
          normalizeText(input.reason),
          Math.max(0, Math.floor(input.attempts)),
          normalizeText(input.lastError),
          Math.max(0, Math.floor(input.nextAttemptAt)),
          Math.max(0, Math.floor(input.deadlineAt)),
          timestamp,
        );
        if (result.changes !== 1) return null;
        const row = db.query<WorkspaceRunReservationRow, [string, string]>(
          `SELECT * FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1 AND run_id = ?2 LIMIT 1`,
        ).get(normalizeText(input.workspaceId), normalizeText(input.runId));
        return row ? reservationRowToItem(row) : null;
      });
    },

    markWorkspaceRunProviderStartAbortPending(input) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_workspace_run_reservation
           SET provider_start_abort_pending = 1,
               provider_start_abort_directory = ?3,
               provider_start_abort_opencode_session_id = ?4,
               updated_at = ?5
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(
          normalizeText(input.workspaceId),
          normalizeText(input.runId),
          normalizeText(input.directory),
          normalizeText(input.opencodeSessionId),
          timestamp,
        );
        if (result.changes !== 1) return null;
        const row = db.query<WorkspaceRunReservationRow, [string, string]>(
          `SELECT * FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1 AND run_id = ?2 LIMIT 1`,
        ).get(normalizeText(input.workspaceId), normalizeText(input.runId));
        return row ? reservationRowToItem(row) : null;
      });
    },

    releaseWorkspaceRun(workspaceId, runId) {
      return withDb((db) => db.query(
        `DELETE FROM conversation_workspace_run_reservation
         WHERE workspace_id = ?1 AND run_id = ?2`,
      ).run(normalizeText(workspaceId), normalizeText(runId)).changes > 0);
    },

    listWorkspaceRunReservations() {
      return withDb((db) => db.query<WorkspaceRunReservationRow, []>(
        `SELECT * FROM conversation_workspace_run_reservation
         ORDER BY workspace_id ASC, created_at ASC, run_id ASC`,
      ).all().map(reservationRowToItem));
    },
  };
}
