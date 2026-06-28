import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveVesloDataDir } from "./audit.js";
import { ApiError } from "./errors.js";
import { localUserResourceOwner } from "./resource-owner.js";
import { parseSkillMarkdownMetadata } from "./skill-metadata.js";
import { prepareSkillContent } from "./skills.js";
import {
  SKILL_ENTRYPOINT,
  isPathInside,
  workspaceSkillRootsForMutation,
  workspaceSkillsRoot,
} from "./skill-roots.js";
import type { ResourceOwner } from "./types.js";
import { exists } from "./utils.js";
import { validateSkillName } from "./validators.js";

export const USER_GLOBAL_SKILL_STORE_SOURCE = "veslo-user-store";
export const USER_GLOBAL_SKILL_VIRTUAL_PATH_PREFIX = "veslo-user-store://";
export const USER_GLOBAL_SKILL_MATERIALIZED_CATEGORY = "veslo-user";

const STORE_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const STORE_FILE = "store.json";
const MATERIALIZATION_MANIFEST_FILE = ".veslo-user-skills.json";
const MATERIALIZATION_MARKER_FILE = ".veslo-user-skill.json";

export type UserGlobalSkillRecord = {
  name: string;
  description: string;
  content: string;
  files?: UserGlobalSkillFileRecord[];
  hash: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UserGlobalSkillFileRecord = {
  path: string;
  contentBase64: string;
  hash: string;
};

export type UserGlobalSkillFileInput = {
  path: string;
  content: Uint8Array;
};

export type UserGlobalSkillSummary = Omit<UserGlobalSkillRecord, "content"> & {
  path: string;
  scope: "user-global";
  source: typeof USER_GLOBAL_SKILL_STORE_SOURCE;
  owner?: ResourceOwner;
};

export type UserGlobalSkillStoreOptions = {
  owner?: ResourceOwner;
};

type UserGlobalSkillStoreData = {
  schemaVersion: 1;
  skills: UserGlobalSkillRecord[];
};

type UserGlobalSkillMaterializationManifestEntry = {
  name: string;
  hash: string;
  skillDir: string;
  materializedAt: string;
};

type UserGlobalSkillMaterializationManifest = {
  schemaVersion: 1;
  generatedAt: string;
  entries: UserGlobalSkillMaterializationManifestEntry[];
};

export type UserGlobalSkillMaterializationConflict = {
  code: "local-skill-conflict";
  name: string;
  message: string;
  localPath: string;
};

export type UserGlobalSkillMaterializationResult = {
  workspaceId?: string;
  status: "synced";
  synced: true;
  reloadRequired: boolean;
  rootDir: string;
  materializedSkills: UserGlobalSkillMaterializationManifestEntry[];
  removedSkillNames: string[];
  conflicts: UserGlobalSkillMaterializationConflict[];
};

const nowIso = () => new Date().toISOString();

const normalizeStoreFilePath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((part) => part === "." || part === "..") ||
    normalized === SKILL_ENTRYPOINT
  ) {
    throw new ApiError(400, "invalid_user_skill_file", "User skill file path is invalid");
  }
  return parts.join("/");
};

const hashBytes = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");

const normalizeFileRecord = (input: UserGlobalSkillFileInput): UserGlobalSkillFileRecord => {
  const path = normalizeStoreFilePath(input.path);
  return {
    path,
    contentBase64: Buffer.from(input.content).toString("base64"),
    hash: hashBytes(input.content),
  };
};

const compareFileRecords = (left: UserGlobalSkillFileRecord, right: UserGlobalSkillFileRecord) =>
  left.path.localeCompare(right.path);

const hashSkillRecord = (content: string, files: UserGlobalSkillFileRecord[] = []) => {
  const hash = createHash("sha256").update(content);
  for (const file of [...files].sort(compareFileRecords)) {
    hash.update("\0");
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.hash);
  }
  return hash.digest("hex");
};

export function userGlobalSkillVirtualPath(name: string): string {
  return `${USER_GLOBAL_SKILL_VIRTUAL_PATH_PREFIX}${encodeURIComponent(name)}`;
}

export function userGlobalSkillNameFromVirtualPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed.startsWith(USER_GLOBAL_SKILL_VIRTUAL_PATH_PREFIX)) return null;
  const encoded = trimmed.slice(USER_GLOBAL_SKILL_VIRTUAL_PATH_PREFIX.length);
  if (!encoded) return null;
  try {
    const name = decodeURIComponent(encoded).trim();
    validateSkillName(name);
    return name;
  } catch {
    return null;
  }
}

export function userGlobalSkillStorePath(dataDirOverride?: string): string {
  return join(dataDirOverride?.trim() || resolveVesloDataDir(), "user-skills", STORE_FILE);
}

export function userGlobalMaterializedSkillsRoot(workspaceRoot: string): string {
  return join(workspaceSkillsRoot(workspaceRoot), USER_GLOBAL_SKILL_MATERIALIZED_CATEGORY);
}

const compareRecords = (left: UserGlobalSkillRecord, right: UserGlobalSkillRecord) =>
  left.name.localeCompare(right.name);

const compareEntries = (
  left: UserGlobalSkillMaterializationManifestEntry,
  right: UserGlobalSkillMaterializationManifestEntry,
) => left.name.localeCompare(right.name);

const validateRecord = (value: unknown): UserGlobalSkillRecord => {
  if (!value || typeof value !== "object") {
    throw new ApiError(500, "invalid_user_skill_store", "User skill store record must be an object");
  }
  const record = value as Record<string, unknown>;
  const name = String(record.name ?? "").trim();
  validateSkillName(name);
  const content = String(record.content ?? "");
  if (!content) {
    throw new ApiError(500, "invalid_user_skill_store", "User skill store record is missing content");
  }
  const files = Array.isArray(record.files)
    ? record.files.map((file): UserGlobalSkillFileRecord => {
        if (!file || typeof file !== "object") {
          throw new ApiError(500, "invalid_user_skill_store", "User skill file record must be an object");
        }
        const item = file as Record<string, unknown>;
        const path = normalizeStoreFilePath(String(item.path ?? ""));
        const contentBase64 = String(item.contentBase64 ?? "").trim();
        const hash = String(item.hash ?? "").trim().toLowerCase();
        if (!contentBase64 || !hash) {
          throw new ApiError(500, "invalid_user_skill_store", "User skill file record is missing required fields");
        }
        return { path, contentBase64, hash };
      }).sort(compareFileRecords)
    : [];
  const hash = String(record.hash ?? "").trim().toLowerCase() || hashSkillRecord(content, files);
  const createdAt = String(record.createdAt ?? "").trim() || nowIso();
  const updatedAt = String(record.updatedAt ?? "").trim() || createdAt;
  const description = String(record.description ?? "").trim();
  return {
    name,
    description,
    content,
    ...(files.length > 0 ? { files } : {}),
    hash,
    enabled: record.enabled !== false,
    createdAt,
    updatedAt,
  };
};

const validateStoreData = (value: unknown): UserGlobalSkillStoreData => {
  if (!value || typeof value !== "object") {
    throw new ApiError(500, "invalid_user_skill_store", "User skill store must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new ApiError(500, "invalid_user_skill_store", "Unsupported user skill store schema");
  }
  if (!Array.isArray(record.skills)) {
    throw new ApiError(500, "invalid_user_skill_store", "User skill store skills must be an array");
  }
  const seen = new Set<string>();
  const skills = record.skills.map(validateRecord).sort(compareRecords);
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new ApiError(500, "invalid_user_skill_store", `Duplicate user skill name: ${skill.name}`);
    }
    seen.add(skill.name);
  }
  return { schemaVersion: STORE_SCHEMA_VERSION, skills };
};

const readStore = async (dataDirOverride?: string): Promise<UserGlobalSkillStoreData> => {
  const path = userGlobalSkillStorePath(dataDirOverride);
  if (!(await exists(path))) {
    return { schemaVersion: STORE_SCHEMA_VERSION, skills: [] };
  }
  return validateStoreData(JSON.parse(await readFile(path, "utf8")));
};

const writeStore = async (store: UserGlobalSkillStoreData, dataDirOverride?: string): Promise<void> => {
  const path = userGlobalSkillStorePath(dataDirOverride);
  const normalized = validateStoreData(store);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
};

const toSummary = (
  record: UserGlobalSkillRecord,
  owner: ResourceOwner = localUserResourceOwner(),
): UserGlobalSkillSummary => ({
  name: record.name,
  description: record.description,
  hash: record.hash,
  enabled: record.enabled,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  path: userGlobalSkillVirtualPath(record.name),
  scope: "user-global",
  source: USER_GLOBAL_SKILL_STORE_SOURCE,
  owner,
});

export async function listUserGlobalSkills(
  dataDirOverride?: string,
  options: UserGlobalSkillStoreOptions = {},
): Promise<UserGlobalSkillSummary[]> {
  const store = await readStore(dataDirOverride);
  const owner = options.owner ?? localUserResourceOwner();
  return store.skills.map((record) => toSummary(record, owner));
}

export async function readUserGlobalSkill(
  name: string,
  dataDirOverride?: string,
  options: UserGlobalSkillStoreOptions = {},
): Promise<{ item: UserGlobalSkillSummary; content: string }> {
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const store = await readStore(dataDirOverride);
  const record = store.skills.find((skill) => skill.name === trimmed);
  if (!record) {
    throw new ApiError(404, "skill_not_found", `User-global skill not found: ${trimmed}`);
  }
  return { item: toSummary(record, options.owner ?? localUserResourceOwner()), content: record.content };
}

export async function upsertUserGlobalSkill(
  payload: {
    name: string;
    content: string;
    description?: string;
    enabled?: boolean;
    files?: UserGlobalSkillFileInput[];
  },
  dataDirOverride?: string,
  options: UserGlobalSkillStoreOptions = {},
): Promise<{ item: UserGlobalSkillSummary; action: "added" | "updated" }> {
  const name = payload.name.trim();
  validateSkillName(name);
  const content = prepareSkillContent({ name, content: payload.content, description: payload.description });
  const metadata = parseSkillMarkdownMetadata(content, {
    expectedName: name,
    fallbackName: name,
    requireDescription: true,
  });
  const store = await readStore(dataDirOverride);
  const existing = store.skills.find((skill) => skill.name === name);
  const files = (payload.files ?? []).map(normalizeFileRecord).sort(compareFileRecords);
  const timestamp = nowIso();
  const next: UserGlobalSkillRecord = {
    name,
    description: metadata.description ?? payload.description?.trim() ?? "",
    content,
    ...(files.length > 0 ? { files } : {}),
    hash: hashSkillRecord(content, files),
    enabled: payload.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  const action = existing ? "updated" : "added";
  const skills = store.skills.filter((skill) => skill.name !== name);
  skills.push(next);
  await writeStore({ schemaVersion: STORE_SCHEMA_VERSION, skills: skills.sort(compareRecords) }, dataDirOverride);
  return { item: toSummary(next, options.owner ?? localUserResourceOwner()), action };
}

export async function deleteUserGlobalSkill(
  name: string,
  dataDirOverride?: string,
  options: UserGlobalSkillStoreOptions = {},
): Promise<{ item: UserGlobalSkillSummary }> {
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const store = await readStore(dataDirOverride);
  const existing = store.skills.find((skill) => skill.name === trimmed);
  if (!existing) {
    throw new ApiError(404, "skill_not_found", `User-global skill not found: ${trimmed}`);
  }
  await writeStore(
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      skills: store.skills.filter((skill) => skill.name !== trimmed),
    },
    dataDirOverride,
  );
  return { item: toSummary(existing, options.owner ?? localUserResourceOwner()) };
}

const manifestPath = (rootDir: string) => join(rootDir, MATERIALIZATION_MANIFEST_FILE);
const markerPath = (skillDir: string) => join(skillDir, MATERIALIZATION_MARKER_FILE);

const validateManifestEntry = (value: unknown): UserGlobalSkillMaterializationManifestEntry => {
  if (!value || typeof value !== "object") {
    throw new ApiError(500, "invalid_user_skill_materialization", "Manifest entry must be an object");
  }
  const record = value as Record<string, unknown>;
  const name = String(record.name ?? "").trim();
  validateSkillName(name);
  const hash = String(record.hash ?? "").trim().toLowerCase();
  const skillDir = String(record.skillDir ?? "").trim();
  const materializedAt = String(record.materializedAt ?? "").trim();
  if (!hash || !skillDir || !materializedAt) {
    throw new ApiError(500, "invalid_user_skill_materialization", "Manifest entry is missing required fields");
  }
  return { name, hash, skillDir, materializedAt };
};

const validateManifest = (value: unknown): UserGlobalSkillMaterializationManifest => {
  if (!value || typeof value !== "object") {
    throw new ApiError(500, "invalid_user_skill_materialization", "Manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ApiError(500, "invalid_user_skill_materialization", "Unsupported manifest schema");
  }
  const generatedAt = String(record.generatedAt ?? "").trim();
  if (!generatedAt || !Array.isArray(record.entries)) {
    throw new ApiError(500, "invalid_user_skill_materialization", "Manifest is missing required fields");
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt,
    entries: record.entries.map(validateManifestEntry).sort(compareEntries),
  };
};

const readManifest = async (rootDir: string): Promise<UserGlobalSkillMaterializationManifest | null> => {
  const path = manifestPath(rootDir);
  if (!(await exists(path))) return null;
  return validateManifest(JSON.parse(await readFile(path, "utf8")));
};

const readMarker = async (skillDir: string): Promise<UserGlobalSkillMaterializationManifestEntry | null> => {
  const path = markerPath(skillDir);
  if (!(await exists(path))) return null;
  return validateManifestEntry(JSON.parse(await readFile(path, "utf8")));
};

const writeManifest = async (
  rootDir: string,
  entries: UserGlobalSkillMaterializationManifestEntry[],
): Promise<void> => {
  const manifest: UserGlobalSkillMaterializationManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: nowIso(),
    entries: entries.map(validateManifestEntry).sort(compareEntries),
  };
  await mkdir(rootDir, { recursive: true });
  await writeFile(manifestPath(rootDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

const writeMarker = async (
  skillDir: string,
  entry: UserGlobalSkillMaterializationManifestEntry,
): Promise<void> => {
  await writeFile(
    markerPath(skillDir),
    `${JSON.stringify({ schemaVersion: MANIFEST_SCHEMA_VERSION, ...validateManifestEntry(entry) }, null, 2)}\n`,
    "utf8",
  );
};

const manifestEntryEquals = (
  left: UserGlobalSkillMaterializationManifestEntry,
  right: UserGlobalSkillMaterializationManifestEntry,
) => left.name === right.name && left.hash === right.hash && left.skillDir === right.skillDir;

const manifestEntriesEqual = (
  left: UserGlobalSkillMaterializationManifestEntry[],
  right: UserGlobalSkillMaterializationManifestEntry[],
) => {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort(compareEntries);
  const rightSorted = [...right].sort(compareEntries);
  return leftSorted.every((entry, index) => manifestEntryEquals(entry, rightSorted[index]!));
};

const findLocalSkillConflict = async (workspaceRoot: string, name: string): Promise<string | null> => {
  const roots = await workspaceSkillRootsForMutation(workspaceRoot);
  for (const root of roots) {
    const direct = join(root, name, SKILL_ENTRYPOINT);
    if (await exists(direct)) return direct;
    if (!(await exists(root))) continue;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === USER_GLOBAL_SKILL_MATERIALIZED_CATEGORY) continue;
      const nested = join(root, entry.name, name, SKILL_ENTRYPOINT);
      if (await exists(nested)) return nested;
    }
  }
  return null;
};

const writeSkillRecordFiles = async (skillDir: string, skill: UserGlobalSkillRecord): Promise<void> => {
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, SKILL_ENTRYPOINT), skill.content, "utf8");
  const skillDirResolved = resolve(skillDir);
  for (const file of skill.files ?? []) {
    const target = resolve(skillDir, file.path);
    if (!isPathInside(skillDirResolved, target)) {
      throw new ApiError(500, "invalid_user_skill_store", "User skill file path escapes materialization directory");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, "base64"));
  }
};

const skillRecordFilesMatch = async (skillDir: string, skill: UserGlobalSkillRecord): Promise<boolean> => {
  const skillDirResolved = resolve(skillDir);
  for (const file of skill.files ?? []) {
    const target = resolve(skillDir, file.path);
    if (!isPathInside(skillDirResolved, target)) {
      throw new ApiError(500, "invalid_user_skill_store", "User skill file path escapes materialization directory");
    }
    const content = await readFile(target).catch(() => null);
    if (!content || hashBytes(content) !== file.hash) return false;
  }
  return true;
};

const readManagedNamesFromRoot = async (
  rootDir: string,
  manifest: UserGlobalSkillMaterializationManifest | null,
): Promise<Set<string>> => {
  const names = new Set<string>((manifest?.entries ?? []).map((entry) => entry.name));
  if (!(await exists(rootDir))) return names;
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const marker = await readMarker(join(rootDir, entry.name)).catch(() => null);
    if (marker) names.add(marker.name);
  }
  return names;
};

export async function materializeUserGlobalSkillsForWorkspace(input: {
  workspaceRoot: string;
  workspaceId?: string;
  dataDir?: string;
}): Promise<UserGlobalSkillMaterializationResult> {
  const workspaceRoot = input.workspaceRoot.trim();
  if (!workspaceRoot) {
    throw new ApiError(400, "invalid_workspace", "Workspace root is required");
  }
  const rootDir = userGlobalMaterializedSkillsRoot(workspaceRoot);
  const rootDirResolved = resolve(rootDir);
  const store = await readStore(input.dataDir);
  const enabledSkills = store.skills.filter((skill) => skill.enabled);
  const manifest = await readManifest(rootDir).catch(() => null);
  const existingEntriesByName = new Map((manifest?.entries ?? []).map((entry) => [entry.name, entry]));
  const conflicts: UserGlobalSkillMaterializationConflict[] = [];
  const desiredSkills: UserGlobalSkillRecord[] = [];

  for (const skill of enabledSkills) {
    const conflictPath = await findLocalSkillConflict(workspaceRoot, skill.name);
    if (conflictPath) {
      conflicts.push({
        code: "local-skill-conflict",
        name: skill.name,
        localPath: conflictPath,
        message: `User-global skill ${skill.name} is shadowed by an existing workspace skill`,
      });
      continue;
    }
    const targetDir = join(rootDir, skill.name);
    const targetExists = await exists(targetDir);
    const targetMarker = targetExists ? await readMarker(targetDir).catch(() => null) : null;
    const targetManifestEntry = existingEntriesByName.get(skill.name);
    if (targetExists && !targetMarker && !targetManifestEntry) {
      conflicts.push({
        code: "local-skill-conflict",
        name: skill.name,
        localPath: targetDir,
        message: `User-global skill ${skill.name} cannot overwrite an unmanaged runtime skill directory`,
      });
      continue;
    }
    desiredSkills.push(skill);
  }

  const desiredNames = new Set(desiredSkills.map((skill) => skill.name));
  const managedNames = await readManagedNamesFromRoot(rootDir, manifest);
  const removedSkillNames: string[] = [];
  let changed = false;

  for (const name of managedNames) {
    if (desiredNames.has(name)) continue;
    const targetDir = join(rootDir, name);
    const targetResolved = resolve(targetDir);
    if (!isPathInside(rootDirResolved, targetResolved)) continue;
    await rm(targetDir, { recursive: true, force: true });
    removedSkillNames.push(name);
    changed = true;
  }

  const materializedAt = nowIso();
  const nextEntries: UserGlobalSkillMaterializationManifestEntry[] = [];

  for (const skill of desiredSkills) {
    const skillDir = join(rootDir, skill.name);
    const skillPath = join(skillDir, SKILL_ENTRYPOINT);
    const existingEntry = existingEntriesByName.get(skill.name);
    const entry: UserGlobalSkillMaterializationManifestEntry = {
      name: skill.name,
      hash: skill.hash,
      skillDir,
      materializedAt: existingEntry?.hash === skill.hash ? existingEntry.materializedAt : materializedAt,
    };
    const existingContent = (await exists(skillPath)) ? await readFile(skillPath, "utf8").catch(() => null) : null;
    const existingMarker = await readMarker(skillDir).catch(() => null);
    const markerMatches = Boolean(existingMarker && manifestEntryEquals(existingMarker, entry));
    const filesMatch = markerMatches ? await skillRecordFilesMatch(skillDir, skill) : false;
    if (existingContent !== skill.content || !markerMatches || !filesMatch) {
      await rm(skillDir, { recursive: true, force: true });
      await writeSkillRecordFiles(skillDir, skill);
      await writeMarker(skillDir, entry);
      changed = true;
    }
    nextEntries.push(entry);
  }

  if (nextEntries.length > 0 || changed || manifest) {
    if (!manifest || !manifestEntriesEqual(manifest.entries, nextEntries)) {
      await writeManifest(rootDir, nextEntries);
      changed = true;
    }
  }

  return {
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    status: "synced",
    synced: true,
    reloadRequired: changed,
    rootDir,
    materializedSkills: nextEntries.sort(compareEntries),
    removedSkillNames: removedSkillNames.sort(),
    conflicts: conflicts.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
