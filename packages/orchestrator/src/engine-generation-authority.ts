import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { RunEngineOwner } from "./run-store.js";
import type { CurrentRuntimeEvidenceKind } from "./current-runtime-evidence.js";

const execFileAsync = promisify(execFile);

export type EngineGenerationState =
  | "creating"
  | "live"
  | "stopping"
  | "exited_confirmed"
  | "unknown_after_orchestrator_loss";

export type ProcessInstanceIdentity = {
  pid: number;
  birthToken: string;
};

export type ProcessInstanceObservation =
  | { kind: "alive"; identity: ProcessInstanceIdentity }
  | { kind: "absent" }
  | { kind: "unknown"; reason: "unsupported" | "inspection_failed" };

export type ProcessInstanceInspector = {
  inspect(pid: number): Promise<ProcessInstanceObservation>;
};

export type EngineGenerationSeed = {
  workspaceId: string;
  engineSlotId: string | null;
  engineOwnerId: string;
  engineStartedAt: number;
};

export type EngineGenerationActivation = EngineGenerationSeed & {
  enginePid: number;
  engineBaseUrl: string;
};

export type EngineGenerationRecord = EngineGenerationActivation & {
  orchestratorInstanceId: string;
  orchestratorStartedAt: number;
  processBirthToken: string | null;
  state: EngineGenerationState;
  createdAt: number;
  lastHeartbeatAt: number;
  closedAt: number | null;
  closureReason: string | null;
};

export type EngineOwnerEvidence =
  | { kind: "lost_proven"; evidenceId: string }
  | {
      kind: "live_or_ambiguous";
      reason: "current_pool_entry" | "exact_process_alive" | "unsupported_wrapper_snapshot";
    }
  | {
      kind: "unknown";
      reason:
        | "generation_not_found"
        | "generation_incomplete"
        | "generation_not_live"
        | "process_identity_unavailable"
        | "pid_reused";
    };

export type EngineGenerationAuthority = {
  registerCreating(seed: EngineGenerationSeed): EngineGenerationRecord;
  activate(input: EngineGenerationActivation): Promise<EngineGenerationRecord>;
  beginStop(owner: RunEngineOwner, reason: string): EngineGenerationRecord | null;
  confirmExit(owner: RunEngineOwner, reason: string): EngineGenerationRecord | null;
  resolveOwnerEvidence(input: {
    owner: RunEngineOwner;
    currentRuntimeEvidence: CurrentRuntimeEvidenceKind;
  }): Promise<EngineOwnerEvidence>;
  get(engineOwnerId: string): EngineGenerationRecord | null;
};

type GenerationRow = {
  engine_owner_id: string;
  workspace_id: string;
  engine_slot_id: string | null;
  engine_started_at: number;
  engine_pid: number | null;
  engine_base_url: string | null;
  orchestrator_instance_id: string;
  orchestrator_started_at: number;
  process_birth_token: string | null;
  state: string;
  created_at: number;
  last_heartbeat_at: number;
  closed_at: number | null;
  closure_reason: string | null;
};

const trim = (value: string | null | undefined): string => value?.trim() ?? "";
const validPid = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const validStartedAt = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// `struct proc_bsdinfo` from XNU `sys/proc_info.h`: sizeof is 136 on the
// macOS architectures Veslo supports; the two uint64 start-time fields follow
// the 120-byte fixed prefix. Keep these literal ABI values independent from
// the parser test so a copied-but-wrong layout cannot validate itself.
const MACOS_PROC_BSDINFO_SIZE = 136;
const MACOS_PROC_BSDINFO_PID_OFFSET = 12;
const MACOS_PROC_BSDINFO_START_SECONDS_OFFSET = 120;
const MACOS_PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;
const MACOS_PROC_PIDTBSDINFO = 3;

type MacosProcPidInfo = (
  pid: number,
  flavor: number,
  arg: bigint,
  buffer: Uint8Array,
  bufferSize: number,
) => number;

let macosProcPidInfo: MacosProcPidInfo | null | undefined;

/** Parse Linux field 22 without being confused by spaces in a process name. */
export function linuxProcStartTimeTicks(stat: string): string | null {
  const closingName = stat.lastIndexOf(")");
  if (closingName < 0) return null;
  const fieldsFromState = stat.slice(closingName + 1).trim().split(/\s+/);
  const startTime = fieldsFromState[19]?.trim() ?? "";
  return /^\d+$/.test(startTime) ? startTime : null;
}

export function linuxProcReadFailure(
  target: "boot_id" | "stat",
  error: unknown,
): ProcessInstanceObservation {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  // `/proc/<pid>/stat` names the process being inspected. boot_id does not,
  // so an ENOENT there is an environment failure, never death evidence.
  return target === "stat" && code === "ENOENT"
    ? { kind: "absent" }
    : { kind: "unknown", reason: "inspection_failed" };
}

/**
 * `proc_bsdinfo` is fixed-width on supported macOS architectures. Keep this
 * parser isolated so a malformed native response fails closed instead of
 * turning a PID lookup into process-death evidence.
 */
export function macosProcBsdInfoBirthToken(pid: number, buffer: Uint8Array): string | null {
  if (buffer.byteLength < MACOS_PROC_BSDINFO_SIZE) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(MACOS_PROC_BSDINFO_PID_OFFSET, true) !== pid) return null;
  const seconds = view.getBigUint64(MACOS_PROC_BSDINFO_START_SECONDS_OFFSET, true);
  const microseconds = view.getBigUint64(MACOS_PROC_BSDINFO_START_MICROSECONDS_OFFSET, true);
  return `darwin:${seconds}:${microseconds}`;
}

function rowToRecord(row: GenerationRow): EngineGenerationRecord {
  const state: EngineGenerationState = row.state === "creating" || row.state === "live" ||
    row.state === "stopping" || row.state === "exited_confirmed" ||
    row.state === "unknown_after_orchestrator_loss"
    ? row.state
    : "unknown_after_orchestrator_loss";
  return {
    workspaceId: row.workspace_id,
    engineSlotId: row.engine_slot_id,
    engineOwnerId: row.engine_owner_id,
    engineStartedAt: Number(row.engine_started_at),
    enginePid: row.engine_pid === null ? 0 : Number(row.engine_pid),
    engineBaseUrl: row.engine_base_url ?? "",
    orchestratorInstanceId: row.orchestrator_instance_id,
    orchestratorStartedAt: Number(row.orchestrator_started_at),
    processBirthToken: row.process_birth_token,
    state,
    createdAt: Number(row.created_at),
    lastHeartbeatAt: Number(row.last_heartbeat_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
    closureReason: row.closure_reason,
  };
}

function ownerMatchesRecord(record: EngineGenerationRecord, owner: RunEngineOwner): boolean {
  return trim(owner.engineOwnerId) === record.engineOwnerId &&
    owner.enginePid === record.enginePid &&
    owner.engineStartedAt === record.engineStartedAt &&
    trim(owner.engineBaseUrl) === record.engineBaseUrl &&
    (!trim(owner.engineSlotId) || trim(owner.engineSlotId) === trim(record.engineSlotId));
}

function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS engine_generation (
      engine_owner_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      engine_slot_id TEXT,
      engine_started_at INTEGER NOT NULL,
      engine_pid INTEGER,
      engine_base_url TEXT,
      orchestrator_instance_id TEXT NOT NULL,
      orchestrator_started_at INTEGER NOT NULL,
      process_birth_token TEXT,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER NOT NULL,
      closed_at INTEGER,
      closure_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS engine_generation_workspace_state_idx
      ON engine_generation (workspace_id, state, last_heartbeat_at);
  `);
  return db;
}

async function inspectWindowsProcess(pid: number): Promise<ProcessInstanceObservation> {
  try {
    const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ], { windowsHide: true, timeout: 2_000 });
    const birthToken = stdout.trim();
    return /^\d+$/.test(birthToken)
      ? { kind: "alive", identity: { pid, birthToken } }
      : { kind: "unknown", reason: "inspection_failed" };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    return code === "1" || code === "-1"
      ? { kind: "absent" }
      : { kind: "unknown", reason: "inspection_failed" };
  }
}

function loadMacosProcPidInfo(): MacosProcPidInfo | null {
  if (macosProcPidInfo !== undefined) return macosProcPidInfo;
  try {
    macosProcPidInfo = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    }).symbols.proc_pidinfo as MacosProcPidInfo;
  } catch {
    macosProcPidInfo = null;
  }
  return macosProcPidInfo;
}

async function inspectMacosProcess(pid: number): Promise<ProcessInstanceObservation> {
  const procPidInfo = loadMacosProcPidInfo();
  if (!procPidInfo) return { kind: "unknown", reason: "inspection_failed" };
  try {
    const buffer = new Uint8Array(MACOS_PROC_BSDINFO_SIZE);
    const written = procPidInfo(pid, MACOS_PROC_PIDTBSDINFO, 0n, buffer, buffer.byteLength);
    const birthToken = written === buffer.byteLength
      ? macosProcBsdInfoBirthToken(pid, buffer)
      : null;
    if (birthToken) return { kind: "alive", identity: { pid, birthToken } };
    // `kill(pid, 0)` is never used as identity proof. It only distinguishes
    // an absent PID from a failed libproc inspection after libproc returned no
    // usable fixed-width record.
    try {
      process.kill(pid, 0);
      return { kind: "unknown", reason: "inspection_failed" };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      return code === "ESRCH"
        ? { kind: "absent" }
        : { kind: "unknown", reason: "inspection_failed" };
    }
  } catch {
    return { kind: "unknown", reason: "inspection_failed" };
  }
}

async function inspectLinuxProcess(pid: number): Promise<ProcessInstanceObservation> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return linuxProcReadFailure("stat", error);
  }

  // A restricted container can hide boot_id while still exposing a live PID.
  // Only the target process's missing stat entry proves absence; every other
  // /proc read failure must preserve the terminal handoff fence.
  let bootId: string;
  try {
    bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
  } catch (error) {
    return linuxProcReadFailure("boot_id", error);
  }
  const startTime = linuxProcStartTimeTicks(stat);
  const normalizedBootId = bootId.trim();
  if (!normalizedBootId || !startTime) return { kind: "unknown", reason: "inspection_failed" };
  return { kind: "alive", identity: { pid, birthToken: `linux:${normalizedBootId}:${startTime}` } };
}

/**
 * Every production resolver returns a process-birth token, never merely PID
 * liveness. `kill(pid, 0)` cannot distinguish PID reuse and is therefore not
 * authority evidence; macOS uses it only to classify an already-failed libproc
 * read as absent versus unknown.
 */
export function createDefaultProcessInstanceInspector(): ProcessInstanceInspector {
  return {
    inspect: async (pid) => {
      if (process.platform === "win32") return await inspectWindowsProcess(pid);
      if (process.platform === "darwin") return await inspectMacosProcess(pid);
      if (process.platform === "linux") return await inspectLinuxProcess(pid);
      return { kind: "unknown", reason: "unsupported" };
    },
  };
}

export function createEngineGenerationAuthority(input: {
  dbPath: string;
  orchestratorInstanceId: string;
  orchestratorStartedAt: number;
  inspector?: ProcessInstanceInspector;
  now?: () => number;
}): EngineGenerationAuthority {
  const inspector = input.inspector ?? createDefaultProcessInstanceInspector();
  const now = input.now ?? (() => Date.now());

  const withDb = <T>(operation: (db: Database) => T): T => {
    const db = openDatabase(input.dbPath);
    try {
      return operation(db);
    } finally {
      db.close();
    }
  };

  const get = (engineOwnerId: string): EngineGenerationRecord | null => withDb((db) => {
    const row = db.query<GenerationRow, [string]>(
      `SELECT * FROM engine_generation WHERE engine_owner_id = ?1 LIMIT 1`,
    ).get(trim(engineOwnerId));
    return row ? rowToRecord(row) : null;
  });

  const updateState = (
    owner: RunEngineOwner,
    state: EngineGenerationState,
    reason: string | null,
  ): EngineGenerationRecord | null => withDb((db) => {
    const record = getInDb(db, owner.engineOwnerId);
    if (!record || !ownerMatchesRecord(record, owner)) return null;
    if (record.state === "exited_confirmed" && state === "exited_confirmed") return record;
    const timestamp = now();
    db.query(
      `UPDATE engine_generation
       SET state = ?2,
           last_heartbeat_at = ?3,
           closed_at = ?4,
           closure_reason = ?5
       WHERE engine_owner_id = ?1`,
    ).run(
      record.engineOwnerId,
      state,
      timestamp,
      state === "exited_confirmed" ? timestamp : record.closedAt,
      reason,
    );
    return getInDb(db, record.engineOwnerId);
  });

  const recordLegacyAbsentOwner = (owner: RunEngineOwner): EngineGenerationRecord | null => {
    const ownerId = trim(owner.engineOwnerId);
    const engineBaseUrl = trim(owner.engineBaseUrl);
    if (!ownerId || !validPid(owner.enginePid) || !validStartedAt(owner.engineStartedAt) || !engineBaseUrl) {
      return null;
    }
    return withDb((db) => {
      const existing = getInDb(db, ownerId);
      if (existing) return ownerMatchesRecord(existing, owner) ? existing : null;

      const timestamp = now();
      // This row is deliberately created only after the OS confirmed the old
      // PID is absent. An old generation may predate this table, but an absent
      // PID still proves that its original process cannot be serving work.
      // A present PID remains ambiguous because it may have been reused.
      db.query(
        `INSERT INTO engine_generation (
           engine_owner_id, workspace_id, engine_slot_id, engine_started_at,
           engine_pid, engine_base_url, orchestrator_instance_id,
           orchestrator_started_at, process_birth_token, state, created_at,
           last_heartbeat_at, closed_at, closure_reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 'exited_confirmed', ?9, ?9, ?9, 'legacy_process_absent')
         ON CONFLICT(engine_owner_id) DO NOTHING`,
      ).run(
        ownerId,
        trim(owner.engineSlotId) || "legacy-unknown",
        trim(owner.engineSlotId) || null,
        owner.engineStartedAt,
        owner.enginePid,
        engineBaseUrl,
        input.orchestratorInstanceId,
        input.orchestratorStartedAt,
        timestamp,
      );
      const recorded = getInDb(db, ownerId);
      return recorded && ownerMatchesRecord(recorded, owner) ? recorded : null;
    });
  };

  return {
    registerCreating(seed) {
      const ownerId = trim(seed.engineOwnerId);
      if (!ownerId) throw new Error("engine generation owner id is required");
      const timestamp = now();
      return withDb((db) => {
        db.query(
          `INSERT INTO engine_generation (
             engine_owner_id, workspace_id, engine_slot_id, engine_started_at,
             engine_pid, engine_base_url, orchestrator_instance_id,
             orchestrator_started_at, process_birth_token, state, created_at,
             last_heartbeat_at, closed_at, closure_reason
           ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, NULL, 'creating', ?7, ?7, NULL, NULL)
           ON CONFLICT(engine_owner_id) DO NOTHING`,
        ).run(
          ownerId,
          trim(seed.workspaceId),
          trim(seed.engineSlotId) || null,
          seed.engineStartedAt,
          input.orchestratorInstanceId,
          input.orchestratorStartedAt,
          timestamp,
        );
        const record = getInDb(db, ownerId);
        if (!record) throw new Error("failed to persist engine generation");
        return record;
      });
    },

    async activate(activation) {
      const ownerId = trim(activation.engineOwnerId);
      const timestamp = now();
      const identity = validPid(activation.enginePid)
        ? await inspector.inspect(activation.enginePid)
        : { kind: "unknown", reason: "inspection_failed" } as const;
      return withDb((db) => {
        const existing = getInDb(db, ownerId);
        if (!existing || existing.state !== "creating") {
          throw new Error("engine generation activation requires a creating record");
        }
        db.query(
          `UPDATE engine_generation
           SET workspace_id = ?2,
               engine_slot_id = ?3,
               engine_started_at = ?4,
               engine_pid = ?5,
               engine_base_url = ?6,
               process_birth_token = ?7,
               state = 'live',
               last_heartbeat_at = ?8
           WHERE engine_owner_id = ?1`,
        ).run(
          ownerId,
          trim(activation.workspaceId),
          trim(activation.engineSlotId) || null,
          activation.engineStartedAt,
          activation.enginePid,
          trim(activation.engineBaseUrl),
          identity.kind === "alive" ? identity.identity.birthToken : null,
          timestamp,
        );
        const record = getInDb(db, ownerId);
        if (!record) throw new Error("failed to activate engine generation");
        return record;
      });
    },

    beginStop(owner, reason) {
      return updateState(owner, "stopping", trim(reason) || "intentional_stop");
    },

    confirmExit(owner, reason) {
      return updateState(owner, "exited_confirmed", trim(reason) || "child_exit");
    },

    async resolveOwnerEvidence({ owner, currentRuntimeEvidence }) {
      if (currentRuntimeEvidence === "running" || currentRuntimeEvidence === "starting") {
        return { kind: "live_or_ambiguous", reason: "current_pool_entry" };
      }
      // A wrapper snapshot is stopped, but host-wrapper exit never proves the
      // guest engine exited. Report it apart from a live pool entry so support
      // captures can tell "engine still running" from "topology unsupported".
      if (currentRuntimeEvidence === "unsupported_wrapper_snapshot") {
        return { kind: "live_or_ambiguous", reason: "unsupported_wrapper_snapshot" };
      }
      const ownerId = trim(owner.engineOwnerId);
      if (!ownerId) return { kind: "unknown", reason: "generation_incomplete" };
      const record = get(ownerId);
      if (!record) {
        if (!validPid(owner.enginePid)) return { kind: "unknown", reason: "generation_not_found" };
        const observed = await inspector.inspect(owner.enginePid);
        if (observed.kind !== "absent") {
          return observed.kind === "unknown"
            ? { kind: "unknown", reason: "process_identity_unavailable" }
            : { kind: "unknown", reason: "generation_not_found" };
        }
        const retired = recordLegacyAbsentOwner(owner);
        return retired
          ? { kind: "lost_proven", evidenceId: `${retired.engineOwnerId}:${retired.closedAt ?? retired.lastHeartbeatAt}` }
          : { kind: "unknown", reason: "generation_incomplete" };
      }
      if (!ownerMatchesRecord(record, owner) || !validPid(record.enginePid)) {
        return { kind: "unknown", reason: "generation_incomplete" };
      }
      if (record.state === "exited_confirmed") {
        return { kind: "lost_proven", evidenceId: `${record.engineOwnerId}:${record.closedAt ?? record.lastHeartbeatAt}` };
      }
      if (!record.processBirthToken) return { kind: "unknown", reason: "generation_incomplete" };
      // A clean stop can be interrupted between recording `stopping` and the
      // child-exit callback. The exact process identity is still sufficient to
      // prove absence in that state. A merely-created generation is different:
      // it never obtained an identity and must stay fail-closed.
      if (record.state !== "live" && record.state !== "stopping") {
        return { kind: "unknown", reason: "generation_not_live" };
      }

      const observed = await inspector.inspect(record.enginePid);
      if (observed.kind === "alive") {
        return observed.identity.birthToken === record.processBirthToken
          ? { kind: "live_or_ambiguous", reason: "exact_process_alive" }
          : { kind: "unknown", reason: "pid_reused" };
      }
      if (observed.kind === "unknown") return { kind: "unknown", reason: "process_identity_unavailable" };

      const confirmed = updateState(owner, "exited_confirmed", "process_identity_absent");
      if (!confirmed) return { kind: "unknown", reason: "generation_incomplete" };
      return { kind: "lost_proven", evidenceId: `${confirmed.engineOwnerId}:${confirmed.closedAt ?? confirmed.lastHeartbeatAt}` };
    },

    get,
  };
}

function getInDb(db: Database, ownerId: string | null | undefined): EngineGenerationRecord | null {
  const normalized = trim(ownerId);
  if (!normalized) return null;
  const row = db.query<GenerationRow, [string]>(
    `SELECT * FROM engine_generation WHERE engine_owner_id = ?1 LIMIT 1`,
  ).get(normalized);
  return row ? rowToRecord(row) : null;
}
