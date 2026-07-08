import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { exists } from "./utils.js";
import { workspaceSkillLockfilePath as resolveWorkspaceSkillLockfilePath } from "./workspace-files.js";

type WorkspaceSkillLockfileEntry = {
  skillId: string;
  installationId: string;
  versionId: string;
  name: string;
  packageSha256: string;
};

export type WorkspaceSkillLockfile = {
  schemaVersion: 1;
  workspaceId: string;
  skillSetId: string;
  skillSetRevision: string;
  entries: WorkspaceSkillLockfileEntry[];
};

export type DesiredWorkspaceSkillSetLock = Omit<WorkspaceSkillLockfile, "schemaVersion">;

export type WorkspaceSkillLockfileComparison = {
  matches: boolean;
  revisionMatches: boolean;
  missing: WorkspaceSkillLockfileEntry[];
  changed: Array<{
    current: WorkspaceSkillLockfileEntry;
    desired: WorkspaceSkillLockfileEntry;
  }>;
  extra: WorkspaceSkillLockfileEntry[];
};

class WorkspaceSkillLockfileError extends Error {
  code: string;
  repairable: boolean;

  constructor(message: string, code = "workspace_skill_lockfile_invalid", repairable = true) {
    super(message);
    this.name = "WorkspaceSkillLockfileError";
    this.code = code;
    this.repairable = repairable;
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkspaceSkillLockfileError(`Workspace skill lockfile ${field} must be a non-empty string`);
  }
  return value.trim();
};

const validateEntry = (value: unknown, field: string): WorkspaceSkillLockfileEntry => {
  if (!isRecord(value)) {
    throw new WorkspaceSkillLockfileError(`Workspace skill lockfile ${field} must be an object`);
  }
  const packageSha256 = requireString(value.packageSha256, `${field}.packageSha256`);
  if (!SHA256_PATTERN.test(packageSha256)) {
    throw new WorkspaceSkillLockfileError(`Workspace skill lockfile ${field}.packageSha256 must be a sha256 digest`);
  }
  return {
    skillId: requireString(value.skillId, `${field}.skillId`),
    installationId: requireString(value.installationId, `${field}.installationId`),
    versionId: requireString(value.versionId, `${field}.versionId`),
    name: requireString(value.name, `${field}.name`),
    packageSha256: packageSha256.toLowerCase(),
  };
};

function validateWorkspaceSkillLockfile(value: unknown): WorkspaceSkillLockfile {
  if (!isRecord(value)) {
    throw new WorkspaceSkillLockfileError("Workspace skill lockfile must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new WorkspaceSkillLockfileError("Workspace skill lockfile schemaVersion must be 1");
  }
  if (!Array.isArray(value.entries)) {
    throw new WorkspaceSkillLockfileError("Workspace skill lockfile entries must be an array");
  }
  const seenSkillIds = new Set<string>();
  const entries = value.entries.map((entry, index) => {
    const parsed = validateEntry(entry, `entries[${index}]`);
    if (seenSkillIds.has(parsed.skillId)) {
      throw new WorkspaceSkillLockfileError(`Workspace skill lockfile contains duplicate skillId: ${parsed.skillId}`);
    }
    seenSkillIds.add(parsed.skillId);
    return parsed;
  });

  return {
    schemaVersion: 1,
    workspaceId: requireString(value.workspaceId, "workspaceId"),
    skillSetId: requireString(value.skillSetId, "skillSetId"),
    skillSetRevision: requireString(value.skillSetRevision, "skillSetRevision"),
    entries,
  };
}

export function workspaceSkillLockfilePath(workspaceRoot: string): string {
  return resolveWorkspaceSkillLockfilePath(workspaceRoot);
}

export async function readWorkspaceSkillLockfile(workspaceRoot: string): Promise<WorkspaceSkillLockfile | null> {
  const path = workspaceSkillLockfilePath(workspaceRoot);
  if (!(await exists(path))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new WorkspaceSkillLockfileError("Workspace skill lockfile is not valid JSON");
  }
  return validateWorkspaceSkillLockfile(parsed);
}

export async function writeWorkspaceSkillLockfile(
  workspaceRoot: string,
  lockfile: WorkspaceSkillLockfile,
): Promise<string> {
  const validated = validateWorkspaceSkillLockfile(lockfile);
  const path = workspaceSkillLockfilePath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return path;
}

const sameEntry = (current: WorkspaceSkillLockfileEntry, desired: WorkspaceSkillLockfileEntry) =>
  current.installationId === desired.installationId &&
  current.versionId === desired.versionId &&
  current.name === desired.name &&
  current.packageSha256 === desired.packageSha256.toLowerCase();

export function compareWorkspaceSkillLockfile(
  current: WorkspaceSkillLockfile | null,
  desired: DesiredWorkspaceSkillSetLock,
): WorkspaceSkillLockfileComparison {
  const currentEntries = new Map((current?.entries ?? []).map((entry) => [entry.skillId, entry]));
  const desiredEntries = new Map(desired.entries.map((entry) => [entry.skillId, validateEntry(entry, "desired.entries[]")]));
  const missing: WorkspaceSkillLockfileEntry[] = [];
  const changed: WorkspaceSkillLockfileComparison["changed"] = [];

  for (const desiredEntry of desiredEntries.values()) {
    const currentEntry = currentEntries.get(desiredEntry.skillId);
    if (!currentEntry) {
      missing.push(desiredEntry);
      continue;
    }
    if (!sameEntry(currentEntry, desiredEntry)) {
      changed.push({ current: currentEntry, desired: desiredEntry });
    }
  }

  const extra = [...currentEntries.values()].filter((entry) => !desiredEntries.has(entry.skillId));
  const revisionMatches =
    Boolean(current) &&
    current?.workspaceId === desired.workspaceId &&
    current?.skillSetId === desired.skillSetId &&
    current?.skillSetRevision === desired.skillSetRevision;
  const matches = revisionMatches && missing.length === 0 && changed.length === 0 && extra.length === 0;

  return {
    matches,
    revisionMatches,
    missing,
    changed,
    extra,
  };
}
