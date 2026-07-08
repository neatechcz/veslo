import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { localUserResourceOwner, workspaceResourceOwner } from "./resource-owner.js";
import type {
  DisabledSkillRecord,
  ManagedSkillSource,
  ResourceOwner,
  SkillItem,
  WorkspaceSkillRolloutRemovalPolicy,
} from "./types.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { ApiError } from "./errors.js";
import { removeSkillWithSnapshot } from "./skill-removal-journal.js";
import type { Actor } from "./types.js";
import {
  extractTriggerFromSkillBody,
  parseSkillMarkdownMetadata,
  type SkillMarkdownMetadata,
} from "./skill-metadata.js";
import {
  SKILL_ENTRYPOINT,
  findWorkspaceRoots,
  isPathInside,
  isVesloManagedSkillRelativePath,
  userGlobalSkillRoots,
  userGlobalSkillRootsForMutation,
  workspaceSkillRootsForMutation,
  workspaceSkillsRoot,
} from "./skill-roots.js";

const MANAGED_MARKER_FILE = ".veslo-managed.json";
const MANAGED_SKILL_SOURCES = new Set(["personal", "workspace", "organization", "platform"]);
const SKILL_REMOVAL_POLICIES = new Set(["user_removable", "admin_removable", "locked"]);
const IGNORED_SKILL_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type SkillFileEntry = {
  path: string;
  sizeBytes: number;
  mediaType: string;
  executable?: boolean;
  text?: string;
};

export interface SkillRemovalJournalContext {
  dataDir?: string;
  workspaceId?: string;
  actor: Actor;
  reason?: string;
}

export type ListSkillsOptions = {
  includeGlobal?: boolean;
  includeDisabled?: boolean;
  disabledSkills?: DisabledSkillRecord[];
  workspaceId?: string;
  workspaceOwner?: ResourceOwner;
  globalOwner?: ResourceOwner;
};

function normalizeListSkillsOptions(
  includeGlobalOrOptions: boolean | ListSkillsOptions,
  options: ListSkillsOptions,
): ListSkillsOptions & { includeGlobal: boolean } {
  if (typeof includeGlobalOrOptions === "boolean") {
    return {
      ...options,
      includeGlobal: includeGlobalOrOptions,
    };
  }
  return {
    ...includeGlobalOrOptions,
    includeGlobal: includeGlobalOrOptions.includeGlobal ?? false,
  };
}

export function disabledRecordMatchesSkill(
  record: DisabledSkillRecord,
  item: SkillItem,
  workspaceId: string | undefined,
): boolean {
  const scope = item.scope === "project" ? "workspace" : "user-global";
  if (record.path) {
    if (resolve(record.path) !== resolve(item.path)) return false;
    if (record.scope !== scope && record.scope !== "organization" && record.scope !== "platform") return false;
    return !record.workspaceId || !workspaceId || record.workspaceId === workspaceId;
  }

  if (record.name !== item.name) return false;
  if (record.scope !== scope) return false;
  if (scope === "workspace") {
    return Boolean(workspaceId) && record.workspaceId === workspaceId;
  }
  return true;
}

function applyDisabledSkillRecords(
  items: SkillItem[],
  options: Pick<ListSkillsOptions, "disabledSkills" | "workspaceId">,
): SkillItem[] {
  const disabledSkills = options.disabledSkills ?? [];
  if (disabledSkills.length === 0) return items;
  return items.map((item) => {
    const disabled = disabledSkills.some((record) => disabledRecordMatchesSkill(record, item, options.workspaceId));
    return disabled
      ? { ...item, enabled: false as const, disabledReason: "user" as const }
      : item;
  });
}

const mediaTypeForSkillFilePath = (path: string): string => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".sh")) return "text/x-shellscript";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
};

const shouldEmbedSkillFileText = (mediaType: string): boolean =>
  mediaType.startsWith("text/") ||
  mediaType === "application/json" ||
  mediaType === "application/yaml" ||
  mediaType === "image/svg+xml";

const decodeUtf8SkillFile = (bytes: Buffer): string | undefined => {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return undefined;
  }
};

async function collectSkillFiles(skillRoot: string, dir: string = skillRoot, files: SkillFileEntry[] = []): Promise<SkillFileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (IGNORED_SKILL_FILE_NAMES.has(entry.name)) continue;
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(skillRoot, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;

    const rawRelativePath = relative(skillRoot, absolutePath);
    if (!rawRelativePath || rawRelativePath.startsWith("..")) continue;
    const packagePath = rawRelativePath.split(/[\\/]/).join("/");
    const fileStat = await stat(absolutePath);
    const mediaType = mediaTypeForSkillFilePath(packagePath);
    const text = shouldEmbedSkillFileText(mediaType) ? decodeUtf8SkillFile(await readFile(absolutePath)) : undefined;
    files.push({
      path: packagePath,
      sizeBytes: fileStat.size,
      mediaType,
      ...(fileStat.mode & 0o111 ? { executable: true } : {}),
      ...(text !== undefined ? { text } : {}),
    });
  }
  return files;
}
const extractTriggerFromBody = extractTriggerFromSkillBody;

const markerString = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
};

const markerSource = (
  marker: unknown,
  fallbackScope: "project" | "global",
): ManagedSkillSource => {
  const source = markerString(marker, "source");
  if (source && MANAGED_SKILL_SOURCES.has(source)) {
    return source as ManagedSkillSource;
  }
  const target = markerString(marker, "target");
  if (target === "workspace") return "workspace";
  if (target === "personal-global") return "personal";
  return fallbackScope === "project" ? "workspace" : "personal";
};

const markerRemovalPolicy = (marker: unknown): WorkspaceSkillRolloutRemovalPolicy => {
  const removalPolicy = markerString(marker, "removalPolicy");
  if (removalPolicy && SKILL_REMOVAL_POLICIES.has(removalPolicy)) {
    return removalPolicy as WorkspaceSkillRolloutRemovalPolicy;
  }
  return "user_removable";
};

async function registryMetadataFromManagedMarker(
  skillDir: string,
  scope: "project" | "global",
): Promise<SkillItem["registry"] | undefined> {
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(join(skillDir, MANAGED_MARKER_FILE), "utf8"));
  } catch {
    return undefined;
  }

  const rawInstallationId = markerString(marker, "installationId");
  if (!rawInstallationId) return undefined;
  const skillId = markerString(marker, "skillId");
  const versionId = markerString(marker, "versionId");
  const packageSha256 = markerString(marker, "packageSha256");
  const registry: NonNullable<SkillItem["registry"]> = {
    ...(skillId ? { skillId } : {}),
    ...(versionId ? { versionId } : {}),
    ...(packageSha256 ? { packageSha256 } : {}),
    source: markerSource(marker, scope),
    removalPolicy: markerRemovalPolicy(marker),
  };

  if (rawInstallationId.startsWith("rollout:")) {
    const policyId = rawInstallationId.slice("rollout:".length).trim();
    return policyId ? { ...registry, policyId } : undefined;
  }
  return { ...registry, installationId: rawInstallationId };
}

async function parseSkillEntry(
  skillPath: string,
  entryName: string,
  scope: "project" | "global",
  owner: ResourceOwner,
): Promise<SkillItem | null> {
  let content: string;
  try {
    content = await readFile(skillPath, "utf8");
  } catch {
    return null;
  }
  let metadata: SkillMarkdownMetadata;
  try {
    metadata = parseSkillMarkdownMetadata(content, {
      expectedName: entryName,
      fallbackName: entryName,
      requireDescription: true,
    });
  } catch {
    return null;
  }
  const registry = await registryMetadataFromManagedMarker(dirname(skillPath), scope);
  return {
    name: metadata.name,
    description: metadata.description ?? "",
    path: skillPath,
    scope,
    owner,
    ...(metadata.trigger !== undefined ? { trigger: metadata.trigger } : {}),
    ...(metadata.disableModelInvocation !== undefined ? { disableModelInvocation: metadata.disableModelInvocation } : {}),
    ...(metadata.userInvocable !== undefined ? { userInvocable: metadata.userInvocable } : {}),
    ...(metadata.aliases !== undefined ? { aliases: metadata.aliases } : {}),
    ...(metadata.whenToUse !== undefined ? { whenToUse: metadata.whenToUse } : {}),
    ...(metadata.paths !== undefined ? { paths: metadata.paths } : {}),
    ...(registry !== undefined ? { registry } : {}),
  };
}

async function listSkillsInDir(dir: string, scope: "project" | "global", owner: ResourceOwner): Promise<SkillItem[]> {
  if (!(await exists(dir))) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items: SkillItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (await exists(skillPath)) {
      // Direct skill: <dir>/<name>/SKILL.md
      const item = await parseSkillEntry(skillPath, entry.name, scope, owner);
      if (item) items.push(item);
    } else {
      // Domain/category folder: <dir>/<domain>/<name>/SKILL.md – scan one level deeper.
      // This supports the convention where global skills are organised as
      //   skills/<domain>/<skill-name>/SKILL.md
      // in addition to the flat   skills/<skill-name>/SKILL.md  layout.
      const domainDir = join(dir, entry.name);
      let subEntries: Dirent[];
      try {
        subEntries = await readdir(domainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const subEntry of subEntries) {
        if (!subEntry.isDirectory()) continue;
        const subSkillPath = join(domainDir, subEntry.name, "SKILL.md");
        if (!(await exists(subSkillPath))) continue;
        const item = await parseSkillEntry(subSkillPath, subEntry.name, scope, owner);
        if (item) items.push(item);
      }
    }
  }
  return items;
}

export async function listSkills(
  workspaceRoot: string,
  includeGlobalOrOptions: boolean | ListSkillsOptions,
  options: ListSkillsOptions = {},
): Promise<SkillItem[]> {
  const normalizedOptions = normalizeListSkillsOptions(includeGlobalOrOptions, options);
  const roots = await findWorkspaceRoots(workspaceRoot);
  const items: SkillItem[] = [];
  for (const root of roots) {
    const workspaceOwner = normalizedOptions.workspaceOwner ?? workspaceResourceOwner({ root });
    const opencodeDir = workspaceSkillsRoot(root);
    const claudeDir = join(root, ".claude", "skills");
    items.push(...(await listSkillsInDir(opencodeDir, "project", workspaceOwner)));
    items.push(...(await listSkillsInDir(claudeDir, "project", workspaceOwner)));
  }

  if (normalizedOptions.includeGlobal) {
    const globalOwner = normalizedOptions.globalOwner ?? localUserResourceOwner();
    for (const globalRoot of userGlobalSkillRoots()) {
      items.push(...(await listSkillsInDir(globalRoot, "global", globalOwner)));
    }
  }

  const markedItems = applyDisabledSkillRecords(items, normalizedOptions);
  const filteredItems = normalizedOptions.includeDisabled ? markedItems : markedItems.filter((item) => item.enabled !== false);
  const seen = new Set<string>();
  return filteredItems.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

export const prepareSkillContent = (payload: { name: string; content: string; description?: string }): string => {
  const name = payload.name.trim();
  validateSkillName(name);
  if (!payload.content) {
    throw new ApiError(400, "invalid_skill_content", "Skill content is required");
  }

  let content = payload.content;
  const { data, body } = parseFrontmatter(payload.content);
  if (Object.keys(data).length > 0) {
    const frontmatterName = typeof data.name === "string" ? data.name : "";
    const frontmatterDescription = typeof data.description === "string" ? data.description : "";
    if (frontmatterName && frontmatterName !== name) {
      throw new ApiError(400, "invalid_skill_name", "Skill frontmatter name must match payload name");
    }
    validateDescription(frontmatterDescription || payload.description);
    const nextDescription = frontmatterDescription || payload.description || "";
    const frontmatter = buildFrontmatter({
      ...data,
      name,
      description: nextDescription,
    });
    content = frontmatter + body.replace(/^\n/, "");
  } else {
    validateDescription(payload.description);
    const frontmatter = buildFrontmatter({ name, description: payload.description });
    content = frontmatter + payload.content.replace(/^\n/, "");
  }

  return content.endsWith("\n") ? content : content + "\n";
};

async function resolveExistingWorkspaceSkillTarget(
  workspaceRoot: string,
  name: string,
  instancePath: string,
  options: { allowManaged?: boolean } = {},
): Promise<{ skillPath: string; skillRoot: string }> {
  validateSkillName(name);
  const target = resolve(instancePath.trim());
  if (basename(target) !== SKILL_ENTRYPOINT) {
    throw new ApiError(400, "invalid_skill_path", "Skill instance path must point to SKILL.md");
  }
  if (basename(dirname(target)) !== name) {
    throw new ApiError(400, "invalid_skill_path", "Skill instance path must match payload name");
  }
  const roots = await workspaceSkillRootsForMutation(workspaceRoot);
  const owningRoot = roots.map((root) => resolve(root)).find((root) => isPathInside(root, target));
  if (!owningRoot) {
    throw new ApiError(400, "invalid_skill_path", "Skill instance path must be inside a workspace skill root");
  }
  const relativeToRoot = relative(owningRoot, target).replace(/\\/g, "/");
  if (!options.allowManaged && isVesloManagedSkillRelativePath(relativeToRoot)) {
    throw new ApiError(409, "managed_skill_read_only", "Managed materialized skills must be edited through the registry");
  }
  if (!(await exists(target))) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
  }
  return { skillPath: target, skillRoot: owningRoot };
}

async function resolveExistingUserGlobalSkillTarget(
  name: string,
  instancePath?: string,
  options: { allowManaged?: boolean } = {},
): Promise<{ skillPath: string; skillRoot: string }> {
  validateSkillName(name);
  const roots = userGlobalSkillRootsForMutation().map((root) => resolve(root));
  const defaultRoot = roots[0];
  if (!defaultRoot) {
    throw new ApiError(500, "skill_roots_unavailable", "No user-global skill root is available");
  }
  const target = instancePath?.trim()
    ? resolve(instancePath.trim())
    : join(defaultRoot, name, SKILL_ENTRYPOINT);
  if (basename(target) !== SKILL_ENTRYPOINT) {
    throw new ApiError(400, "invalid_skill_path", "Skill instance path must point to SKILL.md");
  }
  if (basename(dirname(target)) !== name) {
    throw new ApiError(400, "invalid_skill_path", "Skill instance path must match payload name");
  }
  const owningRoot = roots.find((root) => isPathInside(root, target));
  if (!owningRoot) {
    throw new ApiError(400, "invalid_skill_path", "Skill instance path must be inside a user-global skill root");
  }
  const relativeToRoot = relative(owningRoot, target).replace(/\\/g, "/");
  if (!options.allowManaged && isVesloManagedSkillRelativePath(relativeToRoot)) {
    throw new ApiError(409, "managed_skill_read_only", "Managed materialized skills must be edited through the registry");
  }
  if (!(await exists(target))) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
  }
  return { skillPath: target, skillRoot: owningRoot };
}

async function resolveExistingWorkspaceSkillPath(
  workspaceRoot: string,
  name: string,
  instancePath: string,
  options: { allowManaged?: boolean } = {},
): Promise<string> {
  return (await resolveExistingWorkspaceSkillTarget(workspaceRoot, name, instancePath, options)).skillPath;
}

export async function upsertSkill(
  workspaceRoot: string,
  payload: { name: string; content: string; description?: string },
): Promise<{ path: string; action: "added" | "updated" }> {
  const name = payload.name.trim();
  const content = prepareSkillContent({ ...payload, name });

  const baseDir = workspaceSkillsRoot(workspaceRoot);
  const skillDir = join(baseDir, name);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  const existed = await exists(skillPath);
  await writeFile(skillPath, content, "utf8");
  return { path: skillPath, action: existed ? "updated" : "added" };
}

export async function updateSkillAtPath(
  workspaceRoot: string,
  payload: { name: string; path: string; content: string; description?: string },
): Promise<{ path: string; action: "updated" }> {
  const name = payload.name.trim();
  const skillPath = await resolveExistingWorkspaceSkillPath(workspaceRoot, name, payload.path);
  const content = prepareSkillContent({
    name,
    content: payload.content,
    ...(payload.description !== undefined ? { description: payload.description } : {}),
  });
  await writeFile(skillPath, content, "utf8");
  return { path: skillPath, action: "updated" };
}

export async function readSkillAtPath(
  workspaceRoot: string,
  payload: { name: string; path: string },
): Promise<{ path: string; content: string }> {
  const skillPath = await resolveExistingWorkspaceSkillPath(workspaceRoot, payload.name.trim(), payload.path, {
    allowManaged: true,
  });
  return {
    path: skillPath,
    content: await readFile(skillPath, "utf8"),
  };
}

export async function readSkillFilesAtPath(
  workspaceRoot: string,
  payload: { name: string; path: string },
): Promise<{ path: string; files: SkillFileEntry[] }> {
  const target = await resolveExistingWorkspaceSkillTarget(workspaceRoot, payload.name.trim(), payload.path, {
    allowManaged: true,
  });
  return {
    path: target.skillPath,
    files: await collectSkillFiles(dirname(target.skillPath)),
  };
}

export async function readGlobalSkillAtPath(
  payload: { name: string; path: string },
): Promise<{ path: string; content: string }> {
  const target = await resolveExistingUserGlobalSkillTarget(payload.name.trim(), payload.path, {
    allowManaged: true,
  });
  return {
    path: target.skillPath,
    content: await readFile(target.skillPath, "utf8"),
  };
}

export async function readGlobalSkillFilesAtPath(
  payload: { name: string; path: string },
): Promise<{ path: string; files: SkillFileEntry[] }> {
  const target = await resolveExistingUserGlobalSkillTarget(payload.name.trim(), payload.path, {
    allowManaged: true,
  });
  return {
    path: target.skillPath,
    files: await collectSkillFiles(dirname(target.skillPath)),
  };
}

async function deleteSkill(workspaceRoot: string, name: string): Promise<{ path: string }> {
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const baseDir = workspaceSkillsRoot(workspaceRoot);
  const skillDir = join(baseDir, trimmed);
  const skillPath = join(skillDir, "SKILL.md");
  if (!(await exists(skillPath))) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${trimmed}`);
  }
  await rm(skillDir, { recursive: true, force: true });
  return { path: skillDir };
}

export async function deleteSkillRecoverable(
  workspaceRoot: string,
  name: string,
  journal: SkillRemovalJournalContext,
): Promise<{ path: string; removalId: string }> {
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const baseDir = workspaceSkillsRoot(workspaceRoot);
  const skillDir = join(baseDir, trimmed);
  const skillPath = join(skillDir, SKILL_ENTRYPOINT);
  if (!(await exists(skillPath))) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${trimmed}`);
  }
  const source = {
    scope: "workspace" as const,
    ...(journal.workspaceId !== undefined ? { workspaceId: journal.workspaceId } : {}),
    rootDir: baseDir,
    skillPath,
  };
  const record = await removeSkillWithSnapshot({
    actor: journal.actor,
    source,
    ...(journal.dataDir !== undefined ? { dataDir: journal.dataDir } : {}),
    ...(journal.reason !== undefined ? { reason: journal.reason } : {}),
  });
  return { path: record.originalDir, removalId: record.id };
}

export async function deleteGlobalSkillRecoverable(
  name: string,
  options: { path?: string } | undefined,
  journal: SkillRemovalJournalContext,
): Promise<{ path: string; removalId: string }> {
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const target = await resolveExistingUserGlobalSkillTarget(trimmed, options?.path);
  const record = await removeSkillWithSnapshot({
    actor: journal.actor,
    source: {
      scope: "user-global",
      rootDir: target.skillRoot,
      skillPath: target.skillPath,
    },
    ...(journal.dataDir !== undefined ? { dataDir: journal.dataDir } : {}),
    ...(journal.reason !== undefined ? { reason: journal.reason } : {}),
  });
  return { path: record.originalDir, removalId: record.id };
}

async function deleteSkillAtPath(
  workspaceRoot: string,
  payload: { name: string; path: string },
): Promise<{ path: string }> {
  const skillPath = await resolveExistingWorkspaceSkillPath(workspaceRoot, payload.name.trim(), payload.path);
  const skillDir = dirname(skillPath);
  await rm(skillDir, { recursive: true, force: true });
  return { path: skillDir };
}

export async function deleteSkillAtPathRecoverable(
  workspaceRoot: string,
  payload: { name: string; path: string },
  journal: SkillRemovalJournalContext,
): Promise<{ path: string; removalId: string }> {
  const target = await resolveExistingWorkspaceSkillTarget(workspaceRoot, payload.name.trim(), payload.path);
  const source = {
    scope: "workspace" as const,
    ...(journal.workspaceId !== undefined ? { workspaceId: journal.workspaceId } : {}),
    rootDir: target.skillRoot,
    skillPath: target.skillPath,
  };
  const record = await removeSkillWithSnapshot({
    actor: journal.actor,
    source,
    ...(journal.dataDir !== undefined ? { dataDir: journal.dataDir } : {}),
    ...(journal.reason !== undefined ? { reason: journal.reason } : {}),
  });
  return { path: record.originalDir, removalId: record.id };
}
