import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { SkillItem } from "./types.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { ApiError } from "./errors.js";
import { projectSkillsDir } from "./workspace-files.js";
import { removeSkillWithSnapshot } from "./skill-removal-journal.js";
import type { Actor } from "./types.js";
import {
  extractTriggerFromSkillBody,
  parseSkillMarkdownMetadata,
  type SkillMarkdownMetadata,
} from "./skill-metadata.js";

export const SKILL_ENTRYPOINT = "SKILL.md";

export interface SkillRemovalJournalContext {
  dataDir?: string;
  workspaceId?: string;
  actor: Actor;
  reason?: string;
}

const userHomeDir = (): string => process.env.HOME?.trim() || homedir();

async function findWorkspaceRoots(workspaceRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    roots.push(current);
    const gitPath = join(current, ".git");
    if (await exists(gitPath)) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

export const extractTriggerFromBody = extractTriggerFromSkillBody;

async function parseSkillEntry(
  skillPath: string,
  entryName: string,
  scope: "project" | "global",
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
  return {
    name: metadata.name,
    description: metadata.description ?? "",
    path: skillPath,
    scope,
    trigger: metadata.trigger,
    disableModelInvocation: metadata.disableModelInvocation,
    userInvocable: metadata.userInvocable,
    aliases: metadata.aliases,
    whenToUse: metadata.whenToUse,
    paths: metadata.paths,
  };
}

async function listSkillsInDir(dir: string, scope: "project" | "global"): Promise<SkillItem[]> {
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
      const item = await parseSkillEntry(skillPath, entry.name, scope);
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
        const item = await parseSkillEntry(subSkillPath, subEntry.name, scope);
        if (item) items.push(item);
      }
    }
  }
  return items;
}

export async function listSkills(workspaceRoot: string, includeGlobal: boolean): Promise<SkillItem[]> {
  const roots = await findWorkspaceRoots(workspaceRoot);
  const items: SkillItem[] = [];
  for (const root of roots) {
    const opencodeDir = join(root, ".opencode", "skills");
    const claudeDir = join(root, ".claude", "skills");
    items.push(...(await listSkillsInDir(opencodeDir, "project")));
    items.push(...(await listSkillsInDir(claudeDir, "project")));
  }

  if (includeGlobal) {
    const homeDir = userHomeDir();
    const globalOpenCode = join(homeDir, ".config", "opencode", "skills");
    const globalClaude = join(homeDir, ".claude", "skills");
    const globalAgents = join(homeDir, ".agents", "skills");
    const globalAgentLegacy = join(homeDir, ".agent", "skills");
    items.push(...(await listSkillsInDir(globalOpenCode, "global")));
    items.push(...(await listSkillsInDir(globalClaude, "global")));
    items.push(...(await listSkillsInDir(globalAgents, "global")));
    items.push(...(await listSkillsInDir(globalAgentLegacy, "global")));
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

const isPathInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel));
};

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

export const workspaceSkillRootsForMutation = async (workspaceRoot: string): Promise<string[]> => {
  const roots = await findWorkspaceRoots(workspaceRoot);
  return roots.flatMap((root) => [
    join(root, ".opencode", "skills"),
    join(root, ".claude", "skills"),
  ]);
};

export const userGlobalSkillRootsForMutation = (): string[] => [
  join(userHomeDir(), ".config", "opencode", "skills"),
  join(userHomeDir(), ".claude", "skills"),
  join(userHomeDir(), ".agents", "skills"),
  join(userHomeDir(), ".agent", "skills"),
];

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
  if (!options.allowManaged && (relativeToRoot === `veslo-managed/${name}/${SKILL_ENTRYPOINT}` || relativeToRoot.startsWith("veslo-managed/"))) {
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
): Promise<{ skillPath: string; skillRoot: string }> {
  validateSkillName(name);
  const roots = userGlobalSkillRootsForMutation().map((root) => resolve(root));
  const target = instancePath?.trim()
    ? resolve(instancePath.trim())
    : join(roots[0], name, SKILL_ENTRYPOINT);
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
  if (relativeToRoot === `veslo-managed/${name}/${SKILL_ENTRYPOINT}` || relativeToRoot.startsWith("veslo-managed/")) {
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

  const baseDir = projectSkillsDir(workspaceRoot);
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
  const content = prepareSkillContent({ name, content: payload.content, description: payload.description });
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

export async function deleteSkill(workspaceRoot: string, name: string): Promise<{ path: string }> {
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const baseDir = projectSkillsDir(workspaceRoot);
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
  const baseDir = projectSkillsDir(workspaceRoot);
  const skillDir = join(baseDir, trimmed);
  const skillPath = join(skillDir, SKILL_ENTRYPOINT);
  if (!(await exists(skillPath))) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${trimmed}`);
  }
  const record = await removeSkillWithSnapshot({
    dataDir: journal.dataDir,
    actor: journal.actor,
    reason: journal.reason,
    source: {
      scope: "workspace",
      workspaceId: journal.workspaceId,
      rootDir: baseDir,
      skillPath,
    },
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
    dataDir: journal.dataDir,
    actor: journal.actor,
    reason: journal.reason,
    source: {
      scope: "user-global",
      rootDir: target.skillRoot,
      skillPath: target.skillPath,
    },
  });
  return { path: record.originalDir, removalId: record.id };
}

export async function deleteSkillAtPath(
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
  const record = await removeSkillWithSnapshot({
    dataDir: journal.dataDir,
    actor: journal.actor,
    reason: journal.reason,
    source: {
      scope: "workspace",
      workspaceId: journal.workspaceId,
      rootDir: target.skillRoot,
      skillPath: target.skillPath,
    },
  });
  return { path: record.originalDir, removalId: record.id };
}
