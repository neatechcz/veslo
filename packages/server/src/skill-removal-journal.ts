import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveVesloDataDir } from "./audit.js";
import { ApiError } from "./errors.js";
import type { Actor } from "./types.js";
import { exists } from "./utils.js";

export type SkillRemovalScope = "workspace" | "user-global";
export type SkillRemovalStatus = "pending" | "removed" | "restored";

export interface SkillRemovalRecord {
  id: string;
  name: string;
  scope: SkillRemovalScope;
  workspaceId?: string;
  rootDir: string;
  originalDir: string;
  originalPath: string;
  actor: Actor;
  reason?: string;
  hash: string;
  status?: SkillRemovalStatus;
  removedAt?: string;
  restoredAt?: string;
  restoredBy?: Actor;
}

export interface RemoveSkillWithSnapshotInput {
  dataDir?: string;
  actor: Actor;
  reason?: string;
  source: {
    scope: SkillRemovalScope;
    workspaceId?: string;
    rootDir: string;
    skillPath: string;
  };
}

export interface ListSkillRemovalsInput {
  dataDir?: string;
  scope?: SkillRemovalScope;
  workspaceId?: string;
  includeRestored?: boolean;
}

export interface RestoreSkillRemovalInput {
  dataDir?: string;
  removalId: string;
  actor?: Actor;
  workspace?: {
    id: string;
    rootDir: string;
    skillRoots: string[];
  };
  userGlobalSkillRoots?: string[];
  authorizedRoots?: string[];
}

const SKILL_ENTRYPOINT = "SKILL.md";

const resolveDataDir = (dataDir?: string): string => {
  const trimmed = dataDir?.trim();
  return trimmed ? resolve(trimmed) : resolveVesloDataDir();
};

const journalRoot = (dataDir?: string): string => join(resolveDataDir(dataDir), "skill-removals");
const recordsDir = (dataDir?: string): string => join(journalRoot(dataDir), "records");
const snapshotsDir = (dataDir?: string): string => join(journalRoot(dataDir), "snapshots");
const recordPath = (dataDir: string | undefined, removalId: string): string => join(recordsDir(dataDir), `${removalId}.json`);
const snapshotDir = (dataDir: string | undefined, removalId: string): string => join(snapshotsDir(dataDir), removalId);

const ensureJournalDirs = async (dataDir?: string): Promise<void> => {
  await mkdir(recordsDir(dataDir), { recursive: true });
  await mkdir(snapshotsDir(dataDir), { recursive: true });
};

const isPathInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel));
};

const assertValidRemovalId = (removalId: string): string => {
  const trimmed = removalId.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new ApiError(400, "invalid_removal_id", "Removal id is invalid");
  }
  return trimmed;
};

const normalizeSource = (source: RemoveSkillWithSnapshotInput["source"]) => {
  const rootDir = resolve(source.rootDir);
  const originalPath = resolve(source.skillPath);
  if (basename(originalPath) !== SKILL_ENTRYPOINT) {
    throw new ApiError(400, "invalid_skill_path", "Skill path must point to SKILL.md");
  }
  const originalDir = dirname(originalPath);
  if (!isPathInside(rootDir, originalDir)) {
    throw new ApiError(400, "invalid_skill_path", "Skill path must be inside the source root");
  }
  if (source.scope === "workspace" && !source.workspaceId?.trim()) {
    throw new ApiError(400, "invalid_workspace_id", "Workspace removals require a workspace id");
  }
  return {
    scope: source.scope,
    workspaceId: source.workspaceId?.trim() || undefined,
    rootDir,
    originalPath,
    originalDir,
    name: basename(originalDir),
  };
};

const hashDirectory = async (dir: string): Promise<string> => {
  const hash = createHash("sha256");
  const walk = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const rel = relative(dir, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\0`);
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(`file:${rel}\0`);
      hash.update(await readFile(absolute));
      hash.update("\0");
    }
  };
  await walk(dir);
  return hash.digest("hex");
};

const writeRecord = async (dataDir: string | undefined, record: SkillRemovalRecord): Promise<void> => {
  await mkdir(recordsDir(dataDir), { recursive: true });
  await writeFile(recordPath(dataDir, record.id), JSON.stringify(record, null, 2) + "\n", "utf8");
};

const readRecord = async (dataDir: string | undefined, removalId: string): Promise<SkillRemovalRecord> => {
  const id = assertValidRemovalId(removalId);
  try {
    return JSON.parse(await readFile(recordPath(dataDir, id), "utf8")) as SkillRemovalRecord;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new ApiError(404, "skill_removal_not_found", "Skill removal record not found");
    }
    throw error;
  }
};

export async function readSkillRemovalRecord(input: { dataDir?: string; removalId: string }): Promise<SkillRemovalRecord> {
  return readRecord(input.dataDir, input.removalId);
}

const removalStatus = (record: SkillRemovalRecord): SkillRemovalStatus => {
  if (record.restoredAt || record.status === "restored") return "restored";
  if (record.removedAt || record.status === "removed") return "removed";
  return "pending";
};

const pendingRecordIsRecoverable = async (dataDir: string | undefined, record: SkillRemovalRecord): Promise<boolean> => {
  if (removalStatus(record) !== "pending") return false;
  return (await exists(snapshotDir(dataDir, record.id))) && !(await exists(record.originalDir));
};

const normalizeListableRecord = async (
  dataDir: string | undefined,
  record: SkillRemovalRecord,
): Promise<SkillRemovalRecord | null> => {
  if (removalStatus(record) !== "pending") return record;
  if (!(await pendingRecordIsRecoverable(dataDir, record))) return null;
  return { ...record, status: "removed" };
};

const assertRecordPathsValid = (record: SkillRemovalRecord): { originalPath: string; originalDir: string } => {
  const originalPath = resolve(record.originalPath);
  const originalDir = resolve(record.originalDir);
  if (basename(originalPath) !== SKILL_ENTRYPOINT || dirname(originalPath) !== originalDir || basename(originalDir) !== record.name) {
    throw new ApiError(400, "invalid_skill_removal_record", "Skill removal record paths are invalid");
  }
  return { originalPath, originalDir };
};

const assertRestorePathInsideSkillRoots = (
  record: SkillRemovalRecord,
  skillRoots: string[],
  originalPath: string,
): void => {
  const resolvedSkillRoots = skillRoots.map((root) => resolve(root));
  const owningRoot = resolvedSkillRoots.find((root) => isPathInside(root, originalPath));
  if (!owningRoot) {
    throw new ApiError(403, "skill_restore_forbidden", "Skill removal path is outside authorized skill roots");
  }
  const relativeToRoot = relative(owningRoot, originalPath).replace(/\\/g, "/");
  if (relativeToRoot === `veslo-managed/${record.name}/${SKILL_ENTRYPOINT}` || relativeToRoot.startsWith("veslo-managed/")) {
    throw new ApiError(409, "managed_skill_read_only", "Managed materialized skills must be restored through the registry");
  }
};

const assertWorkspaceRestoreAllowed = (record: SkillRemovalRecord, input: RestoreSkillRemovalInput): void => {
  if (!input.workspace) return;
  if (record.scope !== "workspace" || record.workspaceId !== input.workspace.id) {
    throw new ApiError(403, "skill_restore_forbidden", "Skill removal is not authorized for this workspace");
  }

  const workspaceRoot = resolve(input.workspace.rootDir);
  if (input.authorizedRoots?.length) {
    const authorized = input.authorizedRoots.some((root) => isPathInside(resolve(root), workspaceRoot));
    if (!authorized) {
      throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
    }
  }

  const { originalPath } = assertRecordPathsValid(record);
  assertRestorePathInsideSkillRoots(record, input.workspace.skillRoots, originalPath);
};

const assertUserGlobalRestoreAllowed = (record: SkillRemovalRecord, input: RestoreSkillRemovalInput): void => {
  if (record.scope !== "user-global") return;
  const { originalPath } = assertRecordPathsValid(record);
  const skillRoots = input.userGlobalSkillRoots ?? [];
  if (!skillRoots.length) {
    throw new ApiError(403, "skill_restore_forbidden", "User-global restore requires authorized skill roots");
  }
  assertRestorePathInsideSkillRoots(record, skillRoots, originalPath);
};

export async function removeSkillWithSnapshot(input: RemoveSkillWithSnapshotInput): Promise<SkillRemovalRecord> {
  const source = normalizeSource(input.source);
  if (!(await exists(source.originalPath))) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${source.name}`);
  }

  const id = randomUUID();
  const targetSnapshotDir = snapshotDir(input.dataDir, id);
  await ensureJournalDirs(input.dataDir);
  await cp(source.originalDir, targetSnapshotDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const hash = await hashDirectory(targetSnapshotDir);
  const pendingRecord: SkillRemovalRecord = {
    id,
    name: source.name,
    scope: source.scope,
    ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
    rootDir: source.rootDir,
    originalDir: source.originalDir,
    originalPath: source.originalPath,
    actor: input.actor,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    hash,
    status: "pending",
  };
  await writeRecord(input.dataDir, pendingRecord);

  await rm(source.originalDir, { recursive: true, force: true });

  const record: SkillRemovalRecord = {
    ...pendingRecord,
    status: "removed",
    removedAt: new Date().toISOString(),
  };
  await writeRecord(input.dataDir, record);
  return record;
}

export async function listSkillRemovals(input: ListSkillRemovalsInput = {}): Promise<SkillRemovalRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(recordsDir(input.dataDir));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }

  const records: SkillRemovalRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(recordsDir(input.dataDir), entry), "utf8")) as SkillRemovalRecord;
      const listable = await normalizeListableRecord(input.dataDir, record);
      if (listable) records.push(listable);
    } catch {
      // Ignore malformed journal records so one bad file does not hide valid removals.
    }
  }

  return records
    .filter((record) => !input.scope || record.scope === input.scope)
    .filter((record) => !input.workspaceId || record.workspaceId === input.workspaceId)
    .filter((record) => input.includeRestored || removalStatus(record) !== "restored")
    .sort((a, b) => (b.removedAt ?? "").localeCompare(a.removedAt ?? ""));
}

export async function restoreSkillRemoval(input: RestoreSkillRemovalInput): Promise<{ path: string }> {
  const id = assertValidRemovalId(input.removalId);
  const rawRecord = await readRecord(input.dataDir, id);
  const record = removalStatus(rawRecord) === "pending" && await pendingRecordIsRecoverable(input.dataDir, rawRecord)
    ? { ...rawRecord, status: "removed" as const }
    : rawRecord;
  if (removalStatus(record) === "pending") {
    throw new ApiError(409, "skill_removal_not_complete", "Skill removal has not completed");
  }
  if (removalStatus(record) === "restored") {
    throw new ApiError(409, "skill_removal_already_restored", "Skill removal has already been restored");
  }
  assertWorkspaceRestoreAllowed(record, input);
  assertUserGlobalRestoreAllowed(record, input);
  if (await exists(record.originalDir)) {
    throw new ApiError(409, "skill_restore_conflict", `Skill directory already exists: ${record.originalDir}`);
  }
  const sourceSnapshotDir = snapshotDir(input.dataDir, id);
  if (!(await exists(sourceSnapshotDir))) {
    throw new ApiError(500, "skill_removal_snapshot_missing", "Skill removal snapshot is missing");
  }
  const snapshotHash = await hashDirectory(sourceSnapshotDir);
  if (snapshotHash !== record.hash) {
    throw new ApiError(409, "skill_removal_snapshot_integrity_failed", "Skill removal snapshot hash does not match the journal record");
  }

  await mkdir(dirname(record.originalDir), { recursive: true });
  await cp(sourceSnapshotDir, record.originalDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const restored: SkillRemovalRecord = {
    ...record,
    status: "restored",
    restoredAt: new Date().toISOString(),
    restoredBy: input.actor ?? { type: "host" },
  };
  await writeRecord(input.dataDir, restored);
  return { path: record.originalPath };
}
