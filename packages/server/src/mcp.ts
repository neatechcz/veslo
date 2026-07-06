import { minimatch } from "minimatch";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { localUserResourceOwner, workspaceResourceOwner } from "./resource-owner.js";
import type { HubMcpItem, McpItem, ResourceOwner } from "./types.js";
import { readJsoncFile, updateJsoncTopLevel } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { ApiError } from "./errors.js";
import { validateMcpConfig, validateMcpName, type ValidateMcpConfigOptions } from "./validators.js";

export type ListMcpOptions = {
  workspaceOwner?: ResourceOwner;
  globalOwner?: ResourceOwner;
};

function globalOpenCodeConfigPath(): string {
  const base = join(homedir(), ".config", "opencode");
  const jsonc = join(base, "opencode.jsonc");
  const json = join(base, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc; // fall back to jsonc (readJsoncFile handles missing files gracefully)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getMcpConfig(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = getMcpObject(config);
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(mcp)) {
    // Future OpenCode v2 docs use mcp.servers; Veslo stays on top-level mcp.<name> for the installed SDK.
    if (name === "servers") continue;
    if (!isRecord(entry)) continue;
    result[name] = entry;
  }
  return result;
}

function getMcpObject(config: Record<string, unknown>): Record<string, unknown> {
  return isRecord(config.mcp) ? { ...config.mcp } : {};
}

function getDisabledToolPatterns(config: Record<string, unknown>): string[] {
  const tools = config.tools;
  if (!isRecord(tools)) return [];
  const patterns: string[] = [];
  for (const [pattern, value] of Object.entries(tools)) {
    if (pattern === "deny") continue;
    if (value === false) patterns.push(pattern);
  }
  const deny = tools.deny;
  if (Array.isArray(deny)) {
    for (const item of deny) {
      if (typeof item === "string") patterns.push(item);
    }
  }
  return patterns;
}

function isMcpDisabledByTools(config: Record<string, unknown>, name: string): boolean {
  const patterns = getDisabledToolPatterns(config);
  if (patterns.length === 0) return false;
  // Official boolean tool globs and legacy tools.deny are additive; any disabled pattern wins.
  const candidates = [
    name,
    `${name}.*`,
    `${name}:*`,
    `${name}-tool`,
    `mcp.${name}`,
    `mcp.${name}.*`,
    `mcp:${name}`,
    `mcp:${name}:*`,
    "mcp.*",
    "mcp:*",
  ];
  return patterns.some((pattern) => candidates.some((candidate) => minimatch(candidate, pattern)));
}

export async function listMcp(workspaceRoot: string, options: ListMcpOptions = {}): Promise<McpItem[]> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const { data: globalConfig } = await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>);

  const projectMcpMap = getMcpConfig(config);
  const globalMcpMap = getMcpConfig(globalConfig);
  const workspaceOwner = options.workspaceOwner ?? workspaceResourceOwner({ root: workspaceRoot });
  const globalOwner = options.globalOwner ?? localUserResourceOwner();

  const items: McpItem[] = [];

  // Global MCPs first; project-level entries override global ones with the same name.
  for (const [name, entry] of Object.entries(globalMcpMap)) {
    if (Object.prototype.hasOwnProperty.call(projectMcpMap, name)) continue;
    items.push({
      name,
      config: entry,
      source: "config.global",
      owner: globalOwner,
      disabledByTools:
        (isMcpDisabledByTools(globalConfig, name) || isMcpDisabledByTools(config, name)) || undefined,
    });
  }

  // Project MCPs (highest priority).
  for (const [name, entry] of Object.entries(projectMcpMap)) {
    items.push({
      name,
      config: entry,
      source: "config.project",
      owner: workspaceOwner,
      disabledByTools: isMcpDisabledByTools(config, name) || undefined,
    });
  }

  return items;
}

export async function addMcp(
  workspaceRoot: string,
  name: string,
  config: Record<string, unknown>,
  options: ValidateMcpConfigOptions = {},
): Promise<{ action: "added" | "updated" }> {
  validateMcpName(name);
  validateMcpConfig(config, options);
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcp = getMcpObject(data);
  const mcpMap = getMcpConfig(data);
  const existed = Object.prototype.hasOwnProperty.call(mcpMap, name);
  mcp[name] = config;
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp });
  return { action: existed ? "updated" : "added" };
}

export async function removeMcp(workspaceRoot: string, name: string): Promise<boolean> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcp = getMcpObject(data);
  const mcpMap = getMcpConfig(data);
  if (!Object.prototype.hasOwnProperty.call(mcpMap, name)) return false;
  delete mcp[name];
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp });
  return true;
}

export async function installHubMcp(
  workspaceRoot: string,
  item: HubMcpItem,
): Promise<{ name: string; action: "added" | "updated" }> {
  const name = item.id.trim() || item.name.trim();
  validateMcpName(name);

  const config: Record<string, unknown> = {
    type: item.config.type,
    enabled: true,
  };

  if (item.config.type === "remote") {
    config.url = item.config.url;
    if (typeof item.config.oauth === "boolean" || typeof item.config.oauth === "object") {
      config.oauth = item.config.oauth;
    }
    if (item.config.headers && Object.keys(item.config.headers).length > 0) {
      config.headers = item.config.headers;
    }
  }

  if (item.config.type === "local") {
    config.command = item.config.command;
  }

  validateMcpConfig(config, { allowVesloConnectorTokenHeader: true });
  const result = await addMcp(workspaceRoot, name, config, { allowVesloConnectorTokenHeader: true });
  return { name, action: result.action };
}

export async function refreshMcpRuntimeToken(
  workspaceRoot: string,
  name: string,
  token: string,
): Promise<{ name: string; action: "updated" }> {
  validateMcpName(name);
  const runtimeToken = token.trim();
  if (!runtimeToken) {
    throw new ApiError(400, "invalid_mcp_runtime_token", "MCP runtime token is required");
  }

  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcp = getMcpObject(data);
  const mcpMap = getMcpConfig(data);
  const entry = mcpMap[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ApiError(404, "mcp_not_found", `MCP not found: ${name}`);
  }
  if (entry.type !== "remote") {
    throw new ApiError(400, "invalid_mcp_config", "MCP runtime token refresh requires a remote MCP");
  }

  const existingHeaders =
    entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
      ? (entry.headers as Record<string, unknown>)
      : {};
  const nextEntry: Record<string, unknown> = {
    ...entry,
    headers: {
      ...existingHeaders,
      "X-Veslo-Connector-Token": runtimeToken,
    },
  };
  validateMcpConfig(nextEntry, { allowVesloConnectorTokenHeader: true });
  mcp[name] = nextEntry;
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp });
  return { name, action: "updated" };
}
