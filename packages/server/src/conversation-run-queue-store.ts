import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

export type ConversationRunQueueState = "pending" | "starting" | "submitted" | "failed" | "cancelled" | "conflict";
export type ConversationRunQueueReadableState = Extract<ConversationRunQueueState, "pending" | "starting" | "failed">;
export type ConversationWorkspaceRuntimeOperationKind =
  | "repair_admission_transport"
  | "rebind_control_plane"
  | "reload_workspace_if_idle";
export type ConversationWorkspaceRuntimeOperationState =
  | "granted"
  | "executing"
  | "completed"
  | "blocked"
  | "failed"
  | "outcome_unknown";
export type ConversationWorkspaceRuntimeOperation = {
  workspaceId: string;
  operationId: string;
  kind: ConversationWorkspaceRuntimeOperationKind;
  sourceClass: "automatic" | "user";
  reasonCode: string;
  state: ConversationWorkspaceRuntimeOperationState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  terminalCode: string | null;
};

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
  state: "starting" | "active" | "terminalization_pending" | "terminal_handoff_pending" | "terminal_handoff_unresolved";
  terminalizationReason: string | null;
  terminalizationAttempts: number;
  terminalizationLastError: string | null;
  terminalizationNextAttemptAt: number | null;
  terminalizationDeadlineAt: number | null;
  terminalHandoffReason: string | null;
  terminalHandoffFingerprint: string | null;
  terminalHandoffAttempts: number;
  terminalHandoffRequestedAt: number | null;
  terminalHandoffDecidedAt: number | null;
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
  providerStartAbortAttempts?: number;
  providerStartAbortLastError?: string | null;
  providerStartAbortNextAttemptAt?: number | null;
  providerStartAbortDeadlineAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

/** A durable terminal-owner fence which survives after its old reservation is gone. */
export type ConversationTerminalHandoffBarrier = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  fingerprint: string;
  state: "observed" | "evidence_requested" | "resolved" | "unresolved";
  reason: string;
  attempts: number;
  requestedAt: number | null;
  decidedAt: number | null;
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
  markWorkspaceRunTerminalHandoffPending(input: {
    workspaceId: string;
    runId: string;
    reason: string;
    fingerprint: string;
    attempts: number;
    requestedAt?: number;
  }): ConversationWorkspaceRunReservation | null;
  markWorkspaceRunTerminalHandoffUnresolved(input: {
    workspaceId: string;
    runId: string;
    reason: string;
    fingerprint: string;
    attempts: number;
    decidedAt?: number;
  }): ConversationWorkspaceRunReservation | null;
  /** Explicit user intent may reopen one durable degraded handoff for a fresh, fenced evidence read. */
  reopenWorkspaceRunTerminalHandoff(
    workspaceId: string,
    runId: string,
  ): ConversationWorkspaceRunReservation | null;
  getTerminalHandoffBarrier(
    workspaceId: string,
    conversationId: string,
    runId: string,
  ): ConversationTerminalHandoffBarrier | null;
  getActiveTerminalHandoffBarrier(
    workspaceId: string,
    conversationId: string,
  ): ConversationTerminalHandoffBarrier | null;
  observeTerminalHandoffBarrier(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    fingerprint: string;
    reason: string;
  }): ConversationTerminalHandoffBarrier;
  requestTerminalHandoffBarrierEvidence(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    fingerprint: string;
    reason: string;
  }): ConversationTerminalHandoffBarrier | null;
  resolveTerminalHandoffBarrier(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    reason: string;
  }): ConversationTerminalHandoffBarrier | null;
  markTerminalHandoffBarrierUnresolved(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    reason: string;
  }): ConversationTerminalHandoffBarrier | null;
  reopenTerminalHandoffBarrier(
    workspaceId: string,
    conversationId: string,
    runId: string,
  ): ConversationTerminalHandoffBarrier | null;
  listTerminalHandoffBarriers(): ConversationTerminalHandoffBarrier[];
  markWorkspaceRunProviderStartAbortPending(input: {
    workspaceId: string;
    runId: string;
    directory: string;
    opencodeSessionId: string;
    attempts?: number;
    lastError?: string | null;
    nextAttemptAt?: number | null;
    deadlineAt?: number;
  }): ConversationWorkspaceRunReservation | null;
  releaseWorkspaceRun(workspaceId: string, runId: string): boolean;
  listWorkspaceRunReservations(): ConversationWorkspaceRunReservation[];
  acquireWorkspaceRuntimeOperation(input: {
    workspaceId: string;
    operationId?: string;
    kind: ConversationWorkspaceRuntimeOperationKind;
    sourceClass: ConversationWorkspaceRuntimeOperation["sourceClass"];
    reasonCode: string;
    expiresAt: number;
  }): { operation: ConversationWorkspaceRuntimeOperation; acquired: boolean };
  getWorkspaceRuntimeOperation(workspaceId: string): ConversationWorkspaceRuntimeOperation | null;
  beginWorkspaceRuntimeOperation(workspaceId: string, operationId: string): ConversationWorkspaceRuntimeOperation | null;
  completeWorkspaceRuntimeOperation(input: {
    workspaceId: string;
    operationId: string;
    state: Extract<ConversationWorkspaceRuntimeOperationState, "completed" | "failed" | "outcome_unknown">;
    terminalCode?: string | null;
  }): ConversationWorkspaceRuntimeOperation | null;
  expireWorkspaceRuntimeOperations(now?: number): ConversationWorkspaceRuntimeOperation[];
  listActiveWorkspaceRuntimeOperations(now?: number): ConversationWorkspaceRuntimeOperation[];
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
  terminal_handoff_reason: string | null;
  terminal_handoff_fingerprint: string | null;
  terminal_handoff_attempts: number | null;
  terminal_handoff_requested_at: number | null;
  terminal_handoff_decided_at: number | null;
  provider_start_abort_pending: number | null;
  provider_start_abort_directory: string | null;
  provider_start_abort_opencode_session_id: string | null;
  provider_start_abort_attempts: number | null;
  provider_start_abort_last_error: string | null;
  provider_start_abort_next_attempt_at: number | null;
  provider_start_abort_deadline_at: number | null;
  created_at: number;
  updated_at: number;
};

type WorkspaceRuntimeOperationRow = {
  workspace_id: string;
  operation_id: string;
  kind: string;
  source_class: string;
  reason_code: string;
  state: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  terminal_code: string | null;
};

type TerminalHandoffBarrierRow = {
  workspace_id: string;
  conversation_id: string;
  run_id: string;
  fingerprint: string;
  state: string;
  reason: string;
  attempts: number;
  requested_at: number | null;
  decided_at: number | null;
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
      terminal_handoff_reason TEXT,
      terminal_handoff_fingerprint TEXT,
      terminal_handoff_attempts INTEGER,
      terminal_handoff_requested_at INTEGER,
      terminal_handoff_decided_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_workspace_run_reservation_workspace_idx
      ON conversation_workspace_run_reservation (workspace_id, state, updated_at);
    CREATE TABLE IF NOT EXISTS conversation_workspace_runtime_operation (
      workspace_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      source_class TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      terminal_code TEXT
    );
    CREATE INDEX IF NOT EXISTS conversation_workspace_runtime_operation_active_idx
      ON conversation_workspace_runtime_operation (state, expires_at, updated_at);
    CREATE TABLE IF NOT EXISTS conversation_terminal_handoff_barrier (
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      requested_at INTEGER,
      decided_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, conversation_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_terminal_handoff_barrier_state_idx
      ON conversation_terminal_handoff_barrier (workspace_id, conversation_id, state, updated_at);
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
  addReservationColumn("terminal_handoff_reason", "TEXT");
  addReservationColumn("terminal_handoff_fingerprint", "TEXT");
  addReservationColumn("terminal_handoff_attempts", "INTEGER");
  addReservationColumn("terminal_handoff_requested_at", "INTEGER");
  addReservationColumn("terminal_handoff_decided_at", "INTEGER");
  addReservationColumn("terminalization_reason", "TEXT");
  addReservationColumn("terminalization_attempts", "INTEGER");
  addReservationColumn("terminalization_last_error", "TEXT");
  addReservationColumn("terminalization_next_attempt_at", "INTEGER");
  addReservationColumn("terminalization_deadline_at", "INTEGER");
  addReservationColumn("provider_start_abort_pending", "INTEGER NOT NULL DEFAULT 0");
  addReservationColumn("provider_start_abort_directory", "TEXT");
  addReservationColumn("provider_start_abort_opencode_session_id", "TEXT");
  addReservationColumn("provider_start_abort_attempts", "INTEGER NOT NULL DEFAULT 0");
  addReservationColumn("provider_start_abort_last_error", "TEXT");
  addReservationColumn("provider_start_abort_next_attempt_at", "INTEGER");
  addReservationColumn("provider_start_abort_deadline_at", "INTEGER");
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
    state: row.state === "terminalization_pending" || row.state === "terminal_handoff_pending" ||
        row.state === "terminal_handoff_unresolved"
      ? row.state
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
    terminalHandoffReason: row.terminal_handoff_reason?.trim() || null,
    terminalHandoffFingerprint: row.terminal_handoff_fingerprint?.trim() || null,
    terminalHandoffAttempts: Number.isSafeInteger(row.terminal_handoff_attempts)
      ? Math.max(0, Number(row.terminal_handoff_attempts))
      : 0,
    terminalHandoffRequestedAt: typeof row.terminal_handoff_requested_at === "number"
      ? row.terminal_handoff_requested_at
      : null,
    terminalHandoffDecidedAt: typeof row.terminal_handoff_decided_at === "number"
      ? row.terminal_handoff_decided_at
      : null,
    providerStartAbortPending: row.provider_start_abort_pending === 1,
    providerStartAbortDirectory: row.provider_start_abort_directory?.trim() || null,
    providerStartAbortOpenCodeSessionId: row.provider_start_abort_opencode_session_id?.trim() || null,
    providerStartAbortAttempts: Number.isSafeInteger(row.provider_start_abort_attempts)
      ? Math.max(0, Number(row.provider_start_abort_attempts))
      : 0,
    providerStartAbortLastError: row.provider_start_abort_last_error?.trim() || null,
    providerStartAbortNextAttemptAt: typeof row.provider_start_abort_next_attempt_at === "number"
      ? row.provider_start_abort_next_attempt_at
      : null,
    providerStartAbortDeadlineAt: typeof row.provider_start_abort_deadline_at === "number"
      ? row.provider_start_abort_deadline_at
      : null,
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

function terminalHandoffBarrierRowToItem(
  row: TerminalHandoffBarrierRow,
): ConversationTerminalHandoffBarrier {
  const state = row.state === "evidence_requested" || row.state === "resolved" || row.state === "unresolved"
    ? row.state
    : "observed";
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    fingerprint: row.fingerprint,
    state,
    reason: row.reason,
    attempts: Math.max(0, Number(row.attempts)),
    requestedAt: row.requested_at === null ? null : Number(row.requested_at),
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function runtimeOperationRowToItem(
  row: WorkspaceRuntimeOperationRow,
): ConversationWorkspaceRuntimeOperation {
  const kind = row.kind as ConversationWorkspaceRuntimeOperationKind;
  const state = row.state as ConversationWorkspaceRuntimeOperationState;
  const sourceClass = row.source_class === "user" ? "user" : "automatic";
  return {
    workspaceId: normalizeText(row.workspace_id),
    operationId: normalizeText(row.operation_id),
    kind,
    sourceClass,
    reasonCode: normalizeText(row.reason_code),
    state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: Number(row.expires_at),
    terminalCode: normalizeText(row.terminal_code) || null,
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
           WHERE queue_item_id = ?1
             AND state = 'pending'
             -- The handoff fence is the durable admission owner when an old
             -- reservation was lost during restart. Do not let a status/claim
             -- race start its successor before that exact fence is resolved.
             AND NOT EXISTS (
               SELECT 1 FROM conversation_terminal_handoff_barrier AS barrier
               WHERE barrier.workspace_id = conversation_run_queue.workspace_id
                 AND barrier.conversation_id = conversation_run_queue.conversation_id
                 AND barrier.state IN ('observed', 'evidence_requested', 'unresolved')
             )`,
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
             AND state IN ('starting', 'active', 'terminalization_pending', 'terminal_handoff_pending', 'terminal_handoff_unresolved')
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
        // Once a successor is durably claimed, its predecessor's resolved
        // handoff fence has served its purpose and must not accumulate forever.
        db.query(
          `DELETE FROM conversation_terminal_handoff_barrier
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND state = 'resolved'`,
        ).run(row.workspace_id, row.conversation_id);
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
             AND state IN ('starting', 'active', 'terminalization_pending', 'terminal_handoff_pending', 'terminal_handoff_unresolved')
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

    markWorkspaceRunTerminalHandoffPending(input) {
      return withDb((db) => {
        const timestamp = now();
        const requestedAt = Number.isFinite(input.requestedAt)
          ? Math.max(0, Math.floor(input.requestedAt!))
          : timestamp;
        const result = db.query(
          `UPDATE conversation_workspace_run_reservation
           SET state = 'terminal_handoff_pending',
               terminal_handoff_reason = ?3,
               terminal_handoff_fingerprint = ?4,
               terminal_handoff_attempts = ?5,
               terminal_handoff_requested_at = ?6,
               terminal_handoff_decided_at = NULL,
               updated_at = ?7
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(
          normalizeText(input.workspaceId),
          normalizeText(input.runId),
          normalizeText(input.reason),
          normalizeText(input.fingerprint),
          Math.max(1, Math.floor(input.attempts)),
          requestedAt,
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

    markWorkspaceRunTerminalHandoffUnresolved(input) {
      return withDb((db) => {
        const timestamp = now();
        const decidedAt = Number.isFinite(input.decidedAt)
          ? Math.max(0, Math.floor(input.decidedAt!))
          : timestamp;
        const result = db.query(
          `UPDATE conversation_workspace_run_reservation
           SET state = 'terminal_handoff_unresolved',
               terminal_handoff_reason = ?3,
               terminal_handoff_fingerprint = ?4,
               terminal_handoff_attempts = ?5,
               terminal_handoff_decided_at = ?6,
               updated_at = ?7
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(
          normalizeText(input.workspaceId),
          normalizeText(input.runId),
          normalizeText(input.reason),
          normalizeText(input.fingerprint),
          Math.max(0, Math.floor(input.attempts)),
          decidedAt,
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

    reopenWorkspaceRunTerminalHandoff(workspaceId, runId) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_workspace_run_reservation
           SET state = 'active',
               updated_at = ?3
           WHERE workspace_id = ?1
             AND run_id = ?2
             AND state = 'terminal_handoff_unresolved'`,
        ).run(
          normalizeText(workspaceId),
          normalizeText(runId),
          timestamp,
        );
        if (result.changes !== 1) return null;
        const row = db.query<WorkspaceRunReservationRow, [string, string]>(
          `SELECT * FROM conversation_workspace_run_reservation
           WHERE workspace_id = ?1 AND run_id = ?2 LIMIT 1`,
        ).get(normalizeText(workspaceId), normalizeText(runId));
        return row ? reservationRowToItem(row) : null;
      });
    },

    getTerminalHandoffBarrier(workspaceId, conversationId, runId) {
      return withDb((db) => {
        const row = db.query<TerminalHandoffBarrierRow, [string, string, string]>(
          `SELECT * FROM conversation_terminal_handoff_barrier
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3 LIMIT 1`,
        ).get(normalizeText(workspaceId), normalizeText(conversationId), normalizeText(runId));
        return row ? terminalHandoffBarrierRowToItem(row) : null;
      });
    },

    getActiveTerminalHandoffBarrier(workspaceId, conversationId) {
      return withDb((db) => {
        const row = db.query<TerminalHandoffBarrierRow, [string, string]>(
          `SELECT * FROM conversation_terminal_handoff_barrier
           WHERE workspace_id = ?1 AND conversation_id = ?2
             AND state IN ('observed', 'evidence_requested', 'unresolved')
           ORDER BY updated_at DESC, run_id ASC LIMIT 1`,
        ).get(normalizeText(workspaceId), normalizeText(conversationId));
        return row ? terminalHandoffBarrierRowToItem(row) : null;
      });
    },

    observeTerminalHandoffBarrier(input) {
      return withDb((db) => db.transaction(() => {
        const timestamp = now();
        const workspaceId = normalizeText(input.workspaceId);
        const conversationId = normalizeText(input.conversationId);
        const runId = normalizeText(input.runId);
        db.query(
          `INSERT INTO conversation_terminal_handoff_barrier (
             workspace_id, conversation_id, run_id, fingerprint, state, reason, attempts, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, 'observed', ?5, 0, ?6, ?6)
           ON CONFLICT(workspace_id, conversation_id, run_id) DO NOTHING`,
        ).run(workspaceId, conversationId, runId, normalizeText(input.fingerprint), normalizeText(input.reason), timestamp);
        const row = db.query<TerminalHandoffBarrierRow, [string, string, string]>(
          `SELECT * FROM conversation_terminal_handoff_barrier
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3 LIMIT 1`,
        ).get(workspaceId, conversationId, runId);
        if (!row) throw new Error("failed to observe terminal handoff barrier");
        return terminalHandoffBarrierRowToItem(row);
      })());
    },

    requestTerminalHandoffBarrierEvidence(input) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_terminal_handoff_barrier
           SET fingerprint = ?4, state = 'evidence_requested', reason = ?5,
               attempts = attempts + 1, requested_at = ?6, decided_at = NULL, updated_at = ?6
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3 AND state = 'observed'`,
        ).run(
          normalizeText(input.workspaceId), normalizeText(input.conversationId), normalizeText(input.runId),
          normalizeText(input.fingerprint), normalizeText(input.reason), timestamp,
        );
        if (result.changes !== 1) return null;
        const row = db.query<TerminalHandoffBarrierRow, [string, string, string]>(
          `SELECT * FROM conversation_terminal_handoff_barrier
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3 LIMIT 1`,
        ).get(normalizeText(input.workspaceId), normalizeText(input.conversationId), normalizeText(input.runId));
        return row ? terminalHandoffBarrierRowToItem(row) : null;
      });
    },

    resolveTerminalHandoffBarrier(input) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_terminal_handoff_barrier
           SET state = 'resolved', reason = ?4, decided_at = ?5, updated_at = ?5
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3
             AND state IN ('observed', 'evidence_requested', 'unresolved')`,
        ).run(normalizeText(input.workspaceId), normalizeText(input.conversationId), normalizeText(input.runId), normalizeText(input.reason), timestamp);
        if (result.changes !== 1) return null;
        const row = db.query<TerminalHandoffBarrierRow, [string, string, string]>(
          `SELECT * FROM conversation_terminal_handoff_barrier
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3 LIMIT 1`,
        ).get(normalizeText(input.workspaceId), normalizeText(input.conversationId), normalizeText(input.runId));
        return row ? terminalHandoffBarrierRowToItem(row) : null;
      });
    },

    markTerminalHandoffBarrierUnresolved(input) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_terminal_handoff_barrier
           SET state = 'unresolved', reason = ?4, decided_at = ?5, updated_at = ?5
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3
             AND state IN ('observed', 'evidence_requested')`,
        ).run(normalizeText(input.workspaceId), normalizeText(input.conversationId), normalizeText(input.runId), normalizeText(input.reason), timestamp);
        if (result.changes !== 1) return null;
        const row = db.query<TerminalHandoffBarrierRow, [string, string, string]>(
          `SELECT * FROM conversation_terminal_handoff_barrier
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3 LIMIT 1`,
        ).get(normalizeText(input.workspaceId), normalizeText(input.conversationId), normalizeText(input.runId));
        return row ? terminalHandoffBarrierRowToItem(row) : null;
      });
    },

    reopenTerminalHandoffBarrier(workspaceId, conversationId, runId) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_terminal_handoff_barrier
           SET state = 'observed', updated_at = ?4
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3 AND state = 'unresolved'`,
        ).run(normalizeText(workspaceId), normalizeText(conversationId), normalizeText(runId), timestamp);
        if (result.changes !== 1) return null;
        const row = db.query<TerminalHandoffBarrierRow, [string, string, string]>(
          `SELECT * FROM conversation_terminal_handoff_barrier
           WHERE workspace_id = ?1 AND conversation_id = ?2 AND run_id = ?3 LIMIT 1`,
        ).get(normalizeText(workspaceId), normalizeText(conversationId), normalizeText(runId));
        return row ? terminalHandoffBarrierRowToItem(row) : null;
      });
    },

    listTerminalHandoffBarriers() {
      return withDb((db) => db.query<TerminalHandoffBarrierRow, []>(
        `SELECT * FROM conversation_terminal_handoff_barrier
         ORDER BY workspace_id ASC, conversation_id ASC, created_at ASC, run_id ASC`,
      ).all().map(terminalHandoffBarrierRowToItem));
    },

    markWorkspaceRunProviderStartAbortPending(input) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_workspace_run_reservation
           SET provider_start_abort_pending = 1,
               provider_start_abort_directory = ?3,
               provider_start_abort_opencode_session_id = ?4,
               provider_start_abort_attempts = ?5,
               provider_start_abort_last_error = ?6,
               provider_start_abort_next_attempt_at = ?7,
               provider_start_abort_deadline_at = ?8,
               updated_at = ?9
           WHERE workspace_id = ?1 AND run_id = ?2`,
        ).run(
          normalizeText(input.workspaceId),
          normalizeText(input.runId),
          normalizeText(input.directory),
          normalizeText(input.opencodeSessionId),
          Math.max(0, Math.floor(input.attempts ?? 0)),
          normalizeText(input.lastError) || null,
          typeof input.nextAttemptAt === "number" && Number.isFinite(input.nextAttemptAt)
            ? input.nextAttemptAt
            : null,
          typeof input.deadlineAt === "number" && Number.isFinite(input.deadlineAt)
            ? input.deadlineAt
            : null,
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

    acquireWorkspaceRuntimeOperation(input) {
      return withDb((db) => db.transaction(() => {
        const workspaceId = normalizeText(input.workspaceId);
        const kind = input.kind;
        const sourceClass = input.sourceClass;
        const reasonCode = normalizeText(input.reasonCode);
        const expiresAt = Math.max(0, Math.floor(input.expiresAt));
        if (!workspaceId || !reasonCode || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) {
          throw new Error("workspaceId, reasonCode, and a future expiresAt are required");
        }
        const timestamp = now();
        const existing = db.query<WorkspaceRuntimeOperationRow, [string]>(
          `SELECT * FROM conversation_workspace_runtime_operation
           WHERE workspace_id = ?1 LIMIT 1`,
        ).get(workspaceId);
        if (
          existing &&
          (existing.state === "granted" || existing.state === "executing") &&
          existing.expires_at > timestamp
        ) {
          return { operation: runtimeOperationRowToItem(existing), acquired: false };
        }
        if (existing && (existing.state === "granted" || existing.state === "executing")) {
          db.query(
            `UPDATE conversation_workspace_runtime_operation
             SET state = 'outcome_unknown',
                 terminal_code = 'lease_expired',
                 updated_at = ?2
             WHERE workspace_id = ?1`,
          ).run(workspaceId, timestamp);
        }
        const operationId = normalizeText(input.operationId) || randomUUID();
        db.query(
          `INSERT INTO conversation_workspace_runtime_operation (
             workspace_id, operation_id, kind, source_class, reason_code, state,
             created_at, updated_at, expires_at, terminal_code
           ) VALUES (?1, ?2, ?3, ?4, ?5, 'granted', ?6, ?6, ?7, NULL)
           ON CONFLICT(workspace_id) DO UPDATE SET
             operation_id = excluded.operation_id,
             kind = excluded.kind,
             source_class = excluded.source_class,
             reason_code = excluded.reason_code,
             state = 'granted',
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             expires_at = excluded.expires_at,
             terminal_code = NULL`,
        ).run(workspaceId, operationId, kind, sourceClass, reasonCode, timestamp, expiresAt);
        const row = db.query<WorkspaceRuntimeOperationRow, [string]>(
          `SELECT * FROM conversation_workspace_runtime_operation
           WHERE workspace_id = ?1 LIMIT 1`,
        ).get(workspaceId);
        if (!row) throw new Error("failed to acquire workspace runtime operation");
        return { operation: runtimeOperationRowToItem(row), acquired: true };
      })());
    },

    getWorkspaceRuntimeOperation(workspaceId) {
      return withDb((db) => {
        const row = db.query<WorkspaceRuntimeOperationRow, [string]>(
          `SELECT * FROM conversation_workspace_runtime_operation
           WHERE workspace_id = ?1 LIMIT 1`,
        ).get(normalizeText(workspaceId));
        return row ? runtimeOperationRowToItem(row) : null;
      });
    },

    beginWorkspaceRuntimeOperation(workspaceId, operationId) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_workspace_runtime_operation
           SET state = 'executing', updated_at = ?3
           WHERE workspace_id = ?1 AND operation_id = ?2 AND state = 'granted' AND expires_at > ?3`,
        ).run(normalizeText(workspaceId), normalizeText(operationId), timestamp);
        if (result.changes !== 1) return null;
        const row = db.query<WorkspaceRuntimeOperationRow, [string]>(
          `SELECT * FROM conversation_workspace_runtime_operation
           WHERE workspace_id = ?1 LIMIT 1`,
        ).get(normalizeText(workspaceId));
        return row ? runtimeOperationRowToItem(row) : null;
      });
    },

    completeWorkspaceRuntimeOperation(input) {
      return withDb((db) => {
        const timestamp = now();
        const result = db.query(
          `UPDATE conversation_workspace_runtime_operation
           SET state = ?3, terminal_code = ?4, updated_at = ?5
           WHERE workspace_id = ?1
             AND operation_id = ?2
             AND state IN ('granted', 'executing')`,
        ).run(
          normalizeText(input.workspaceId),
          normalizeText(input.operationId),
          input.state,
          normalizeText(input.terminalCode) || null,
          timestamp,
        );
        if (result.changes !== 1) return null;
        const row = db.query<WorkspaceRuntimeOperationRow, [string]>(
          `SELECT * FROM conversation_workspace_runtime_operation
           WHERE workspace_id = ?1 LIMIT 1`,
        ).get(normalizeText(input.workspaceId));
        return row ? runtimeOperationRowToItem(row) : null;
      });
    },

    expireWorkspaceRuntimeOperations(at = now()) {
      return withDb((db) => db.transaction(() => {
        const timestamp = Math.max(0, Math.floor(at));
        db.query(
          `UPDATE conversation_workspace_runtime_operation
           SET state = 'outcome_unknown', terminal_code = 'lease_expired', updated_at = ?1
           WHERE state IN ('granted', 'executing') AND expires_at <= ?1`,
        ).run(timestamp);
        return db.query<WorkspaceRuntimeOperationRow, [number]>(
          `SELECT * FROM conversation_workspace_runtime_operation
           WHERE state = 'outcome_unknown' AND terminal_code = 'lease_expired' AND updated_at = ?1
           ORDER BY workspace_id ASC`,
        ).all(timestamp).map(runtimeOperationRowToItem);
      })());
    },

    listActiveWorkspaceRuntimeOperations(at = now()) {
      return withDb((db) => db.query<WorkspaceRuntimeOperationRow, [number]>(
        `SELECT * FROM conversation_workspace_runtime_operation
         WHERE state IN ('granted', 'executing') AND expires_at > ?1
         ORDER BY workspace_id ASC`,
      ).all(Math.max(0, Math.floor(at))).map(runtimeOperationRowToItem));
    },
  };
}
