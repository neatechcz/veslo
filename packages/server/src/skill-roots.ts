import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { exists } from "./utils.js";
import { projectSkillsDir } from "./workspace-files.js";

export const SKILL_ENTRYPOINT = "SKILL.md";
export const VESLO_MANAGED_SKILL_CATEGORY = "veslo-managed";
export const VESLO_REGISTRY_PERSONAL_SKILL_CATEGORY = "veslo-registry";

const uniquePaths = (paths: string[]): string[] =>
  Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));

export function userHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function userConfigHomeDir(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(userHomeDir(), ".config");
}

export function workspaceSkillsRoot(workspaceRoot: string): string {
  return projectSkillsDir(workspaceRoot);
}

export type WorkspaceRootResolutionOptions = {
  /**
   * Hard boundary owned by the caller (normally the registered workspace
   * root). No implicit walk into the user's home or filesystem root is ever
   * allowed.
   */
  boundaryRoot?: string;
};

export async function findWorkspaceRoots(
  workspaceRoot: string,
  options: WorkspaceRootResolutionOptions = {},
): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);
  let boundary = options.boundaryRoot?.trim() ? resolve(options.boundaryRoot) : current;
  if (!options.boundaryRoot?.trim()) {
    let probe = current;
    while (true) {
      if (await exists(join(probe, ".git"))) {
        boundary = probe;
        break;
      }
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (!isPathInside(boundary, current)) return roots;
  while (true) {
    roots.push(current);
    const gitPath = join(current, ".git");
    if (await exists(gitPath)) break;
    const parent = resolve(current, "..");
    if (parent === current || !isPathInside(boundary, parent)) break;
    current = parent;
  }
  return roots;
}

export async function workspaceSkillRootsForMutation(
  workspaceRoot: string,
  options: WorkspaceRootResolutionOptions = {},
): Promise<string[]> {
  const roots = await findWorkspaceRoots(workspaceRoot, options.boundaryRoot
    ? options
    : { ...options, boundaryRoot: workspaceRoot });
  return roots.flatMap((root) => [
    workspaceSkillsRoot(root),
    join(root, ".claude", "skills"),
  ]);
}

export function userGlobalSkillRoots(): string[] {
  const homeDir = userHomeDir();
  return uniquePaths([
    join(userConfigHomeDir(), "opencode", "skills"),
    join(homeDir, ".config", "opencode", "skills"),
    join(homeDir, ".claude", "skills"),
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".agent", "skills"),
  ]);
}

export function userGlobalSkillRootsForMutation(): string[] {
  return userGlobalSkillRoots();
}

export function workspaceManagedSkillsRoot(workspaceRoot: string): string {
  return join(workspaceSkillsRoot(workspaceRoot), VESLO_MANAGED_SKILL_CATEGORY);
}

/** Registry-backed personal-global projection; separate from user-store skills. */
export function workspaceRegistryPersonalSkillsRoot(workspaceRoot: string): string {
  return join(workspaceSkillsRoot(workspaceRoot), VESLO_REGISTRY_PERSONAL_SKILL_CATEGORY);
}

export function personalGlobalManagedSkillsRoot(globalSkillsRoot?: string): string {
  const configuredRoot = globalSkillsRoot?.trim();
  if (configuredRoot) return join(configuredRoot, VESLO_MANAGED_SKILL_CATEGORY);
  return join(userGlobalSkillRoots()[0] ?? join(userConfigHomeDir(), "opencode", "skills"), VESLO_MANAGED_SKILL_CATEGORY);
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel));
}

export function isVesloManagedSkillRelativePath(relativeToRoot: string): boolean {
  const normalized = relativeToRoot.replace(/\\/g, "/");
  return normalized === VESLO_MANAGED_SKILL_CATEGORY ||
    normalized.startsWith(`${VESLO_MANAGED_SKILL_CATEGORY}/`);
}
