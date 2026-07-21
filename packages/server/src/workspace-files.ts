import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function opencodeConfigPath(workspaceRoot: string): string {
  const jsoncPath = join(workspaceRoot, "opencode.jsonc");
  const jsonPath = join(workspaceRoot, "opencode.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return jsoncPath;
}

export function opencodeConfigPathInDir(configDir: string): string {
  const jsoncPath = join(configDir, "opencode.jsonc");
  const jsonPath = join(configDir, "opencode.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return jsoncPath;
}

export function userOpencodeConfigDir(configDir?: string): string {
  const trimmed = configDir?.trim();
  return trimmed ? trimmed : join(homedir(), ".config", "opencode");
}

export function userOpencodeConfigPath(configDir?: string): string {
  return opencodeConfigPathInDir(userOpencodeConfigDir(configDir));
}

export function vesloConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo.json");
}

export function projectSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "skills");
}

export function workspaceSkillLockfilePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo.skills.lock.json");
}

/** Server-owned effective runtime skill view consumed by the orchestrator. */
export function workspaceEffectiveSkillManifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo.runtime.skills.json");
}

export function projectCommandsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "commands");
}

export function projectPluginsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "plugins");
}

export function projectManagedPluginsDir(workspaceRoot: string): string {
  return join(projectPluginsDir(workspaceRoot), "veslo-managed");
}

export function userPluginsDir(configDir?: string): string {
  return join(userOpencodeConfigDir(configDir), "plugins");
}

export function userManagedPluginsDir(configDir?: string): string {
  return join(userPluginsDir(configDir), "veslo-managed");
}

export function projectManagedPluginSpecManifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "plugins", "managed-plugin-specs.json");
}

export function userManagedPluginSpecManifestPath(dataDir: string): string {
  return join(dataDir, "plugins", "managed-plugin-specs.json");
}
