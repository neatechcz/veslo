import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { resolveVesloDataDir } from "./audit.js";
import { ApiError } from "./errors.js";
import { validateSkillPackageManifest } from "./skill-package-model.js";
import type { SkillPackageArchive } from "./skill-packages.js";
import { unpackSkillPackage } from "./skill-packages.js";
import { SKILL_ENTRYPOINT } from "./skills.js";
import type { WorkspaceSkillMaterialization } from "./types.js";
import { exists } from "./utils.js";
import { validateSkillName } from "./validators.js";
import { projectSkillsDir } from "./workspace-files.js";

export type SkillMaterializationManifestEntry = WorkspaceSkillMaterialization & {
  skillDir: string;
  materializedAt: string;
};

export type SkillMaterializationManifest = {
  schemaVersion: 1;
  generatedAt: string;
  entries: SkillMaterializationManifestEntry[];
};

export type SkillMaterializationResult = {
  skillDir: string;
  backupDir?: string;
};

export type SkillSetMaterializationResult = {
  rootDir: string;
  materializedSkills: SkillMaterializationResult[];
  removedSkillNames: string[];
  backupDirs: string[];
};

export type MaterializeSkillPackageToRootInput = {
  rootDir: string;
  skill: WorkspaceSkillMaterialization;
  archive: SkillPackageArchive;
  dataDir?: string;
};

export type MaterializeSkillSetInput = {
  workspaceRoot: string;
  skills: WorkspaceSkillMaterialization[];
  loadPackage: (skill: WorkspaceSkillMaterialization) => Promise<SkillPackageArchive>;
  dataDir?: string;
};

export type MaterializePersonalGlobalSkillSetInput = Omit<MaterializeSkillSetInput, "workspaceRoot"> & {
  globalSkillsRoot?: string;
  unmanagedSkillRoots?: string[];
};

const ROOT_MARKER_FILE = ".veslo-materialization.json";
const SKILL_MARKER_FILE = ".veslo-managed.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const normalizeSha256 = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error("Managed skill packageSha256 must be a sha256 digest");
  }
  return normalized;
};

const normalizeSkill = (skill: WorkspaceSkillMaterialization): WorkspaceSkillMaterialization => {
  const name = skill.name.trim();
  validateSkillName(name);
  return {
    ...skill,
    name,
    packageSha256: normalizeSha256(skill.packageSha256),
  };
};

const compareEntries = (left: SkillMaterializationManifestEntry, right: SkillMaterializationManifestEntry) =>
  left.name.localeCompare(right.name) || left.installationId.localeCompare(right.installationId);

const dataDir = (override?: string) => override?.trim() || resolveVesloDataDir();

export function workspaceManagedSkillsRoot(workspaceRoot: string): string {
  return join(projectSkillsDir(workspaceRoot), "veslo-managed");
}

export function personalGlobalManagedSkillsRoot(globalSkillsRoot?: string): string {
  const configuredRoot = globalSkillsRoot?.trim();
  if (configuredRoot) return join(configuredRoot, "veslo-managed");

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return join(xdgConfigHome, "opencode", "skills", "veslo-managed");

  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
  return join(home, ".config", "opencode", "skills", "veslo-managed");
}

export function skillMaterializationManifestPath(rootDir: string): string {
  return join(rootDir, ROOT_MARKER_FILE);
}

const skillMarkerPath = (skillDir: string): string => join(skillDir, SKILL_MARKER_FILE);

const validateManifestEntry = (value: unknown): SkillMaterializationManifestEntry => {
  if (!value || typeof value !== "object") {
    throw new Error("Skill materialization manifest entry must be an object");
  }
  const record = value as Record<string, unknown>;
  const entry = normalizeSkill({
    installationId: String(record.installationId ?? "").trim(),
    skillId: String(record.skillId ?? "").trim(),
    name: String(record.name ?? "").trim(),
    versionId: String(record.versionId ?? "").trim(),
    packageSha256: String(record.packageSha256 ?? "").trim(),
    target: record.target === "personal-global" ? "personal-global" : "workspace",
  });
  const skillDir = String(record.skillDir ?? "").trim();
  const materializedAt = String(record.materializedAt ?? "").trim();
  if (!entry.installationId || !entry.skillId || !entry.versionId || !skillDir || !materializedAt) {
    throw new Error("Skill materialization manifest entry is missing required fields");
  }
  return {
    ...entry,
    skillDir,
    materializedAt,
  };
};

export function validateSkillMaterializationManifest(value: unknown): SkillMaterializationManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Skill materialization manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new Error("Skill materialization manifest schemaVersion must be 1");
  }
  const generatedAt = String(record.generatedAt ?? "").trim();
  if (!generatedAt) {
    throw new Error("Skill materialization manifest generatedAt is required");
  }
  if (!Array.isArray(record.entries)) {
    throw new Error("Skill materialization manifest entries must be an array");
  }
  const seen = new Set<string>();
  const entries = record.entries.map(validateManifestEntry).sort(compareEntries);
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`Skill materialization manifest contains duplicate skill name: ${entry.name}`);
    }
    seen.add(entry.name);
  }
  return {
    schemaVersion: 1,
    generatedAt,
    entries,
  };
}

export async function readSkillMaterializationManifest(rootDir: string): Promise<SkillMaterializationManifest | null> {
  const path = skillMaterializationManifestPath(rootDir);
  if (!(await exists(path))) return null;
  return validateSkillMaterializationManifest(JSON.parse(await readFile(path, "utf8")));
}

const writeSkillMaterializationManifest = async (
  rootDir: string,
  entries: SkillMaterializationManifestEntry[],
  generatedAt = new Date().toISOString(),
): Promise<SkillMaterializationManifest> => {
  const manifest: SkillMaterializationManifest = {
    schemaVersion: 1,
    generatedAt,
    entries: entries.map(validateManifestEntry).sort(compareEntries),
  };
  await mkdir(rootDir, { recursive: true });
  await writeFile(skillMaterializationManifestPath(rootDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
};

const readSkillMarker = async (skillDir: string): Promise<SkillMaterializationManifestEntry | null> => {
  const path = skillMarkerPath(skillDir);
  if (!(await exists(path))) return null;
  return validateManifestEntry(JSON.parse(await readFile(path, "utf8")));
};

const writeSkillMarker = async (skillDir: string, entry: SkillMaterializationManifestEntry): Promise<void> => {
  await writeFile(
    skillMarkerPath(skillDir),
    `${JSON.stringify({ schemaVersion: 1, ...validateManifestEntry(entry) }, null, 2)}\n`,
    "utf8",
  );
};

const targetIsManaged = async (
  targetDir: string,
  skill: WorkspaceSkillMaterialization,
  manifest: SkillMaterializationManifest | null,
): Promise<boolean> => {
  const marker = await readSkillMarker(targetDir).catch(() => null);
  if (marker && marker.name === skill.name) return true;
  return manifest?.entries.some((entry) => entry.name === skill.name && entry.skillDir === targetDir) ?? false;
};

const backupRoot = (dataDirOverride?: string): string => join(dataDir(dataDirOverride), "skill-materialization-backups");

const createBackup = async (targetDir: string, skillName: string, dataDirOverride?: string): Promise<string | undefined> => {
  if (!(await exists(targetDir))) return undefined;
  const backupDir = join(backupRoot(dataDirOverride), `${skillName}-${Date.now()}-${randomUUID()}`);
  await mkdir(backupRoot(dataDirOverride), { recursive: true });
  await cp(targetDir, backupDir, { recursive: true });
  return backupDir;
};

const assertArchiveMatchesSkill = (archive: SkillPackageArchive, skill: WorkspaceSkillMaterialization): SkillPackageArchive => {
  const validated = validateSkillPackageManifest(archive);
  if (normalizeSha256(validated.packageSha256) !== normalizeSha256(skill.packageSha256)) {
    throw new Error(`Managed skill ${skill.name} package hash does not match desired package hash`);
  }
  if (validated.entrypoint !== SKILL_ENTRYPOINT) {
    throw new Error(`Managed skill ${skill.name} package entrypoint must be ${SKILL_ENTRYPOINT}`);
  }
  return {
    ...archive,
    packageSha256: validated.packageSha256,
  };
};

const manifestEntryForSkill = (
  rootDir: string,
  skill: WorkspaceSkillMaterialization,
  materializedAt = new Date().toISOString(),
): SkillMaterializationManifestEntry => ({
  ...normalizeSkill(skill),
  skillDir: join(rootDir, skill.name),
  materializedAt,
});

const assertUniqueDesiredSkillNames = (skills: WorkspaceSkillMaterialization[]) => {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new Error(`Managed skill set contains duplicate desired skill name: ${skill.name}`);
    }
    seen.add(skill.name);
  }
};

const findUnmanagedPersonalGlobalSkillConflicts = async (
  rootDir: string,
  skills: WorkspaceSkillMaterialization[],
  unmanagedSkillRoots?: string[],
): Promise<Array<{ name: string; path: string }>> => {
  const desiredNames = new Set(skills.filter((skill) => skill.target === "personal-global").map((skill) => skill.name));
  if (desiredNames.size === 0) return [];

  const globalRoots = Array.from(new Set([dirname(rootDir), ...(unmanagedSkillRoots ?? [])].map((root) => root.trim()).filter(Boolean)));
  const managedRootName = basename(rootDir);
  const conflicts: Array<{ name: string; path: string }> = [];
  const addConflictIfSkillExists = async (name: string, skillDir: string) => {
    const skillPath = join(skillDir, SKILL_ENTRYPOINT);
    if (await exists(skillPath)) conflicts.push({ name, path: skillPath });
  };

  for (const globalRoot of globalRoots) {
    for (const name of desiredNames) {
      await addConflictIfSkillExists(name, join(globalRoot, name));
    }

    let entries: Dirent[];
    try {
      entries = await readdir(globalRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === managedRootName) continue;
      const domainDir = join(globalRoot, entry.name);
      let subEntries: Dirent[];
      try {
        subEntries = await readdir(domainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const subEntry of subEntries) {
        if (!subEntry.isDirectory() || !desiredNames.has(subEntry.name)) continue;
        await addConflictIfSkillExists(subEntry.name, join(domainDir, subEntry.name));
      }
    }
  }

  return conflicts.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
};

const assertNoUnmanagedPersonalGlobalSkillConflicts = async (
  rootDir: string,
  skills: WorkspaceSkillMaterialization[],
  unmanagedSkillRoots?: string[],
): Promise<void> => {
  const conflicts = await findUnmanagedPersonalGlobalSkillConflicts(rootDir, skills, unmanagedSkillRoots);
  if (conflicts.length === 0) return;
  const conflict = conflicts[0];
  throw new ApiError(
    409,
    "managed_skill_name_conflict",
    `Refusing to materialize managed skill ${conflict.name} because an unmanaged user-global skill already exists at ${conflict.path}`,
    { conflicts },
  );
};

export async function materializeSkillPackageToRoot(
  input: MaterializeSkillPackageToRootInput,
): Promise<SkillMaterializationResult> {
  const skill = normalizeSkill(input.skill);
  const archive = assertArchiveMatchesSkill(input.archive, skill);
  const rootDir = input.rootDir;
  const targetDir = join(rootDir, skill.name);
  const existingManifest = await readSkillMaterializationManifest(rootDir);

  if ((await exists(targetDir)) && !(await targetIsManaged(targetDir, skill, existingManifest))) {
    throw new Error(`Refusing to overwrite unmanaged skill directory: ${targetDir}`);
  }

  const backupDir = await createBackup(targetDir, skill.name, input.dataDir);
  await unpackSkillPackage({ archive, targetDir });

  const entry = manifestEntryForSkill(rootDir, skill);
  await writeSkillMarker(targetDir, entry);

  const mergedEntries = [
    ...(existingManifest?.entries.filter((existing) => existing.name !== skill.name) ?? []),
    entry,
  ];
  await writeSkillMaterializationManifest(rootDir, mergedEntries);

  return {
    skillDir: targetDir,
    ...(backupDir ? { backupDir } : {}),
  };
}

const materializeSkillSetToRoot = async (
  rootDir: string,
  input: Omit<MaterializeSkillSetInput, "workspaceRoot">,
): Promise<SkillSetMaterializationResult> => {
  const previousManifest = await readSkillMaterializationManifest(rootDir);
  const desiredSkills = input.skills.map(normalizeSkill);
  assertUniqueDesiredSkillNames(desiredSkills);
  const desiredNames = new Set(desiredSkills.map((skill) => skill.name));
  const materializedSkills: SkillMaterializationResult[] = [];
  const backupDirs: string[] = [];

  for (const skill of desiredSkills) {
    const result = await materializeSkillPackageToRoot({
      rootDir,
      dataDir: input.dataDir,
      skill,
      archive: await input.loadPackage(skill),
    });
    materializedSkills.push(result);
    if (result.backupDir) backupDirs.push(result.backupDir);
  }

  const removedSkillNames: string[] = [];
  for (const entry of previousManifest?.entries ?? []) {
    if (desiredNames.has(entry.name)) continue;
    const skillDir = join(rootDir, entry.name);
    if (!(await targetIsManaged(skillDir, entry, previousManifest))) continue;
    const backupDir = await createBackup(skillDir, entry.name, input.dataDir);
    if (backupDir) backupDirs.push(backupDir);
    await rm(skillDir, { recursive: true, force: true });
    removedSkillNames.push(entry.name);
  }

  const finalEntries = desiredSkills.map((skill) => manifestEntryForSkill(rootDir, skill));
  await writeSkillMaterializationManifest(rootDir, finalEntries);

  return {
    rootDir,
    materializedSkills,
    removedSkillNames: removedSkillNames.sort(),
    backupDirs,
  };
};

export async function materializeWorkspaceSkillSet(input: MaterializeSkillSetInput): Promise<SkillSetMaterializationResult> {
  return materializeSkillSetToRoot(workspaceManagedSkillsRoot(input.workspaceRoot), input);
}

export async function materializePersonalGlobalSkillSet(
  input: MaterializePersonalGlobalSkillSetInput,
): Promise<SkillSetMaterializationResult> {
  const rootDir = personalGlobalManagedSkillsRoot(input.globalSkillsRoot);
  const desiredSkills = input.skills.map(normalizeSkill);
  await assertNoUnmanagedPersonalGlobalSkillConflicts(rootDir, desiredSkills, input.unmanagedSkillRoots);
  return materializeSkillSetToRoot(rootDir, {
    ...input,
    skills: desiredSkills,
  });
}

export const __skillMaterializerTestHooks = {
  markerFileNames: {
    root: ROOT_MARKER_FILE,
    skill: SKILL_MARKER_FILE,
  },
  backupRoot,
  skillMarkerPath,
  findUnmanagedPersonalGlobalSkillConflicts,
};
