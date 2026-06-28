import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { ApiError } from "./errors.js";
import { parseSkillMarkdownMetadata } from "./skill-metadata.js";
import { SKILL_ENTRYPOINT } from "./skills.js";
import type { Actor, WorkspaceInfo } from "./types.js";
import {
  listUserGlobalSkills,
  upsertUserGlobalSkill,
  type UserGlobalSkillFileInput,
} from "./user-skill-store.js";
import { exists } from "./utils.js";
import { validateSkillName } from "./validators.js";
import { projectSkillsDir } from "./workspace-files.js";

export type SkillImportSourceAgent = "codex" | "claude" | "opencode" | "agents";
export type SkillImportSourceLocation = "user-global" | "workspace";
export type SkillImportStatus = "ready" | "needs-review" | "invalid" | "conflict";

export type SkillImportTarget =
  | { scope: "user-global" }
  | { scope: "workspace"; workspaceId: string; workspaceName: string };

export type SkillImportConflict = {
  code: "target-exists" | "duplicate-candidate";
  message: string;
  path?: string;
};

export type SkillImportCandidate = {
  id: string;
  name: string;
  description: string;
  trigger?: string;
  sourceAgent: SkillImportSourceAgent;
  sourceLocation: SkillImportSourceLocation;
  sourcePath: string;
  sourceRoot: string;
  target: SkillImportTarget;
  status: SkillImportStatus;
  warnings: string[];
  conflict?: SkillImportConflict;
  fileCount: number;
};

export type SkillImportCandidateInput = {
  workspaces: WorkspaceInfo[];
  homeDir?: string;
  xdgConfigHome?: string;
  dataDir?: string;
};

export type SkillImportRequest = SkillImportCandidateInput & {
  actor: Actor;
  candidateIds: string[];
};

export type SkillImportResultItem = {
  candidateId: string;
  name?: string;
  ok: boolean;
  code?: string;
  message?: string;
  path?: string;
  target?: SkillImportTarget;
};

export type SkillImportResult = {
  results: SkillImportResultItem[];
};

type SkillRoot = {
  sourceAgent: SkillImportSourceAgent;
  sourceLocation: SkillImportSourceLocation;
  root: string;
  workspace?: WorkspaceInfo;
};

type SkillFolder = {
  dir: string;
  fallbackName: string;
};

const userHomeDir = (input?: SkillImportCandidateInput) => input?.homeDir?.trim() || process.env.HOME?.trim() || homedir();
const userConfigHomeDir = (input: SkillImportCandidateInput) =>
  input.xdgConfigHome?.trim() || process.env.XDG_CONFIG_HOME?.trim() || join(userHomeDir(input), ".config");

const isPathInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel));
};

const workspaceLabel = (workspace: WorkspaceInfo): string => workspace.name?.trim() || workspace.path;

const uniqueRoots = (roots: SkillRoot[]): SkillRoot[] => {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = [
      root.sourceAgent,
      root.sourceLocation,
      root.workspace?.id ?? "",
      resolve(root.root),
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

async function findWorkspaceRoots(workspaceRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    roots.push(current);
    if (await exists(join(current, ".git"))) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

async function buildCandidateRoots(input: SkillImportCandidateInput): Promise<SkillRoot[]> {
  const homeDir = userHomeDir(input);
  const configHome = userConfigHomeDir(input);
  const roots: SkillRoot[] = [
    { sourceAgent: "codex", sourceLocation: "user-global", root: join(homeDir, ".codex", "skills") },
    { sourceAgent: "claude", sourceLocation: "user-global", root: join(homeDir, ".claude", "skills") },
    { sourceAgent: "opencode", sourceLocation: "user-global", root: join(configHome, "opencode", "skills") },
    { sourceAgent: "opencode", sourceLocation: "user-global", root: join(homeDir, ".config", "opencode", "skills") },
    { sourceAgent: "agents", sourceLocation: "user-global", root: join(homeDir, ".agents", "skills") },
    { sourceAgent: "agents", sourceLocation: "user-global", root: join(homeDir, ".agent", "skills") },
  ];

  for (const workspace of input.workspaces) {
    if (workspace.workspaceType !== "local" || !workspace.path.trim()) continue;
    for (const root of await findWorkspaceRoots(workspace.path)) {
      roots.push(
        { sourceAgent: "codex", sourceLocation: "workspace", root: join(root, ".codex", "skills"), workspace },
        { sourceAgent: "claude", sourceLocation: "workspace", root: join(root, ".claude", "skills"), workspace },
        { sourceAgent: "opencode", sourceLocation: "workspace", root: join(root, ".opencode", "skills"), workspace },
        { sourceAgent: "agents", sourceLocation: "workspace", root: join(root, ".agents", "skills"), workspace },
        { sourceAgent: "agents", sourceLocation: "workspace", root: join(root, ".agent", "skills"), workspace },
      );
    }
  }

  return uniqueRoots(roots);
}

async function readDirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function findSkillFolders(root: string): Promise<SkillFolder[]> {
  if (!(await exists(root))) return [];
  const folders: SkillFolder[] = [];
  for (const entry of await readDirEntries(root)) {
    if (!entry.isDirectory()) continue;
    const directDir = join(root, entry.name);
    if (await exists(join(directDir, SKILL_ENTRYPOINT))) {
      folders.push({ dir: directDir, fallbackName: entry.name });
      continue;
    }
    for (const nested of await readDirEntries(directDir)) {
      if (!nested.isDirectory()) continue;
      const nestedDir = join(directDir, nested.name);
      if (await exists(join(nestedDir, SKILL_ENTRYPOINT))) {
        folders.push({ dir: nestedDir, fallbackName: nested.name });
      }
    }
  }
  return folders;
}

async function collectFiles(dir: string, baseDir = dir): Promise<UserGlobalSkillFileInput[]> {
  const files: UserGlobalSkillFileInput[] = [];
  for (const entry of await readDirEntries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, baseDir)));
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = relative(baseDir, path).replace(/\\/g, "/");
    files.push({
      path: relativePath,
      content: await readFile(path),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

const candidateId = (input: {
  sourceAgent: SkillImportSourceAgent;
  sourcePath: string;
  sourceLocation: SkillImportSourceLocation;
  workspaceId?: string;
  targetScope: string;
}) =>
  createHash("sha256")
    .update([
      input.sourceAgent,
      input.sourceLocation,
      input.workspaceId ?? "",
      resolve(input.sourcePath),
      input.targetScope,
    ].join("\0"))
    .digest("hex")
    .slice(0, 24);

async function workspaceTargetConflict(workspaces: WorkspaceInfo[], name: string): Promise<string | undefined> {
  for (const workspace of workspaces) {
    if (workspace.workspaceType !== "local" || !workspace.path.trim()) continue;
    const target = join(projectSkillsDir(workspace.path), name, SKILL_ENTRYPOINT);
    if (await exists(target)) return target;
  }
  return undefined;
}

async function candidateConflict(
  input: SkillImportCandidateInput,
  target: SkillImportTarget,
  name: string,
): Promise<SkillImportConflict | undefined> {
  if (target.scope === "user-global") {
    const existingUserSkill = (await listUserGlobalSkills(input.dataDir)).find((item) => item.name === name);
    if (existingUserSkill) {
      return {
        code: "target-exists",
        message: `A Veslo user skill named ${name} already exists`,
        path: existingUserSkill.path,
      };
    }
    const localConflict = await workspaceTargetConflict(input.workspaces, name);
    if (localConflict) {
      return {
        code: "target-exists",
        message: `A workspace skill named ${name} already exists`,
        path: localConflict,
      };
    }
    return undefined;
  }

  const workspace = input.workspaces.find((item) => item.id === target.workspaceId);
  const targetPath = workspace ? join(projectSkillsDir(workspace.path), name, SKILL_ENTRYPOINT) : undefined;
  if (targetPath && await exists(targetPath)) {
    return {
      code: "target-exists",
      message: `A workspace skill named ${name} already exists`,
      path: targetPath,
    };
  }
  return undefined;
}

async function candidateFromFolder(
  input: SkillImportCandidateInput,
  root: SkillRoot,
  folder: SkillFolder,
): Promise<SkillImportCandidate> {
  const skillPath = join(folder.dir, SKILL_ENTRYPOINT);
  let name = folder.fallbackName;
  let description = "";
  let trigger: string | undefined;
  let invalid = false;
  const warnings: string[] = [];

  try {
    const content = await readFile(skillPath, "utf8");
    const metadata = parseSkillMarkdownMetadata(content, {
      fallbackName: folder.fallbackName,
      requireDescription: true,
    });
    name = metadata.name;
    description = metadata.description ?? "";
    trigger = metadata.trigger;
  } catch (error) {
    invalid = true;
    warnings.push(error instanceof Error ? error.message : "Skill metadata could not be parsed");
  }

  const files = await collectFiles(folder.dir);
  const extraFileCount = files.filter((file) => file.path !== SKILL_ENTRYPOINT).length;
  if (extraFileCount > 0) {
    warnings.push("Contains files outside SKILL.md; review before importing.");
  }

  const target: SkillImportTarget = root.sourceLocation === "user-global"
    ? { scope: "user-global" }
    : {
        scope: "workspace",
        workspaceId: root.workspace?.id ?? "",
        workspaceName: root.workspace ? workspaceLabel(root.workspace) : "",
      };
  const conflict = invalid ? undefined : await candidateConflict(input, target, name);
  const status: SkillImportStatus = invalid
    ? "invalid"
    : conflict
      ? "conflict"
      : extraFileCount > 0
        ? "needs-review"
        : "ready";

  return {
    id: candidateId({
      sourceAgent: root.sourceAgent,
      sourceLocation: root.sourceLocation,
      sourcePath: folder.dir,
      workspaceId: root.workspace?.id,
      targetScope: target.scope,
    }),
    name,
    description,
    ...(trigger ? { trigger } : {}),
    sourceAgent: root.sourceAgent,
    sourceLocation: root.sourceLocation,
    sourcePath: folder.dir,
    sourceRoot: root.root,
    target,
    status,
    warnings,
    ...(conflict ? { conflict } : {}),
    fileCount: files.length,
  };
}

function markDuplicateCandidates(candidates: SkillImportCandidate[]): SkillImportCandidate[] {
  const seen = new Map<string, SkillImportCandidate>();
  return candidates.map((candidate) => {
    const key = candidate.target.scope === "user-global"
      ? `user-global:${candidate.name}`
      : `workspace:${candidate.target.workspaceId}:${candidate.name}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, candidate);
      return candidate;
    }
    return {
      ...candidate,
      status: "conflict",
      conflict: {
        code: "duplicate-candidate",
        message: `Another import candidate resolves to ${candidate.name}`,
        path: existing.sourcePath,
      },
    };
  });
}

export async function listSkillImportCandidates(input: SkillImportCandidateInput): Promise<SkillImportCandidate[]> {
  const candidates: SkillImportCandidate[] = [];
  for (const root of await buildCandidateRoots(input)) {
    for (const folder of await findSkillFolders(root.root)) {
      candidates.push(await candidateFromFolder(input, root, folder));
    }
  }
  return markDuplicateCandidates(candidates).sort((left, right) =>
    left.sourceAgent.localeCompare(right.sourceAgent) ||
    left.name.localeCompare(right.name) ||
    left.sourcePath.localeCompare(right.sourcePath)
  );
}

async function importUserGlobalCandidate(
  input: SkillImportRequest,
  candidate: SkillImportCandidate,
): Promise<SkillImportResultItem> {
  const files = await collectFiles(candidate.sourcePath);
  const entry = files.find((file) => file.path === SKILL_ENTRYPOINT);
  if (!entry) {
    return {
      candidateId: candidate.id,
      name: candidate.name,
      ok: false,
      code: "invalid",
      message: "Skill entrypoint disappeared",
      target: candidate.target,
    };
  }
  await upsertUserGlobalSkill(
    {
      name: candidate.name,
      content: Buffer.from(entry.content).toString("utf8"),
      description: candidate.description,
      enabled: true,
      files: files.filter((file) => file.path !== SKILL_ENTRYPOINT),
    },
    input.dataDir,
  );
  return {
    candidateId: candidate.id,
    name: candidate.name,
    ok: true,
    target: candidate.target,
  };
}

async function importWorkspaceCandidate(
  input: SkillImportRequest,
  candidate: SkillImportCandidate,
): Promise<SkillImportResultItem> {
  if (candidate.target.scope !== "workspace") {
    throw new ApiError(500, "invalid_skill_import_target", "Workspace import requires workspace target");
  }
  const target = candidate.target;
  const workspace = input.workspaces.find((item) => item.id === target.workspaceId);
  if (!workspace || workspace.workspaceType !== "local") {
    return {
      candidateId: candidate.id,
      name: candidate.name,
      ok: false,
      code: "workspace-unavailable",
      message: "Workspace is no longer available",
      target: candidate.target,
    };
  }
  validateSkillName(candidate.name);
  const targetDir = join(projectSkillsDir(workspace.path), candidate.name);
  const targetPath = join(targetDir, SKILL_ENTRYPOINT);
  if (await exists(targetPath)) {
    return {
      candidateId: candidate.id,
      name: candidate.name,
      ok: false,
      code: "target-exists",
      message: `A workspace skill named ${candidate.name} already exists`,
      path: targetPath,
      target: candidate.target,
    };
  }
  const sourceResolved = resolve(candidate.sourcePath);
  const targetResolved = resolve(targetDir);
  if (isPathInside(sourceResolved, targetResolved) || isPathInside(targetResolved, sourceResolved)) {
    return {
      candidateId: candidate.id,
      name: candidate.name,
      ok: false,
      code: "target-exists",
      message: "Source and target skill folders overlap",
      path: targetDir,
      target: candidate.target,
    };
  }
  await mkdir(dirname(targetDir), { recursive: true });
  await cp(candidate.sourcePath, targetDir, { recursive: true, errorOnExist: true, force: false });
  return {
    candidateId: candidate.id,
    name: candidate.name,
    ok: true,
    path: targetPath,
    target: candidate.target,
  };
}

export async function importSkillCandidates(input: SkillImportRequest): Promise<SkillImportResult> {
  const ids = new Set(input.candidateIds.map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) {
    throw new ApiError(400, "invalid_skill_import_selection", "At least one import candidate is required");
  }

  const candidates = await listSkillImportCandidates(input);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const results: SkillImportResultItem[] = [];

  for (const id of ids) {
    const candidate = candidatesById.get(id);
    if (!candidate) {
      results.push({ candidateId: id, ok: false, code: "not-found", message: "Import candidate not found" });
      continue;
    }
    if (candidate.status === "invalid") {
      results.push({
        candidateId: candidate.id,
        name: candidate.name,
        ok: false,
        code: "invalid",
        message: candidate.warnings[0] ?? "Import candidate is invalid",
        target: candidate.target,
      });
      continue;
    }
    if (candidate.conflict) {
      results.push({
        candidateId: candidate.id,
        name: candidate.name,
        ok: false,
        code: candidate.conflict.code,
        message: candidate.conflict.message,
        path: candidate.conflict.path,
        target: candidate.target,
      });
      continue;
    }
    results.push(
      candidate.target.scope === "user-global"
        ? await importUserGlobalCandidate(input, candidate)
        : await importWorkspaceCandidate(input, candidate),
    );
  }

  return { results };
}
