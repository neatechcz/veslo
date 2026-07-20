import { parse } from "jsonc-parser";
import { minimatch } from "minimatch";
import type { McpServerConfig, McpServerEntry } from "./types";
import { readOpencodeConfig, writeOpencodeConfig } from "./lib/tauri";
import type { McpDirectoryInfo } from "./constants";
export { validateMcpServerName } from "./mcp-validation";

type McpConfigValue = Record<string, unknown> | null | undefined;

const parseJsoncObject = (content: string): Record<string, unknown> => {
  if (!content.trim()) return {};

  try {
    const parsed = parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const toSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function quickConnectEntryKey(entry: Pick<McpDirectoryInfo, "id" | "name">): string {
  const preferred = entry.id?.trim();
  if (preferred) return preferred;
  return toSlug(entry.name);
}

export function parseLocalCommandInput(input: string): string[] {
  const text = input.trim();
  if (!text) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        const next = text[index + 1];
        if (next === quote || next === "\\") {
          current += next;
          index += 1;
          continue;
        }
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  // Keep a conservative fallback when the user enters an unmatched quote.
  if (quote) {
    return text.split(/\s+/).filter(Boolean);
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export async function removeMcpFromConfig(
  projectDir: string,
  name: string,
): Promise<void> {
  const configFile = await readOpencodeConfig("project", projectDir);
  let existingConfig: Record<string, unknown> = {};
  if (configFile.exists && configFile.content?.trim()) {
    try {
      existingConfig = parse(configFile.content) ?? {};
    } catch {
      existingConfig = {};
    }
  }

  const mcpSection = existingConfig["mcp"] as Record<string, unknown> | undefined;
  if (!mcpSection || !(name in mcpSection)) return;

  delete mcpSection[name];
  const writeResult = await writeOpencodeConfig(
    "project",
    projectDir,
    `${JSON.stringify(existingConfig, null, 2)}\n`,
  );
  if (!writeResult.ok) {
    throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
  }
}

export function parseMcpServersFromContent(content: string): McpServerEntry[] {
  const parsed = parseJsoncObject(content);
  const mcp = parsed.mcp as McpConfigValue;

  if (!mcp || typeof mcp !== "object") {
    return [];
  }

  return Object.entries(mcp).flatMap(([name, value]) => {
    if (name === "servers") {
      return [];
    }
    if (!value || typeof value !== "object") {
      return [];
    }

    const config = value as { type?: unknown };
    if (config.type !== "remote" && config.type !== "local") {
      return [];
    }

    return [{ name, config: config as McpServerConfig }];
  });
}

function parseDisabledMcpOverrideNamesFromContent(content: string): Set<string> {
  const parsed = parseJsoncObject(content);
  const mcp = parsed.mcp as McpConfigValue;
  const disabled = new Set<string>();

  if (!mcp || typeof mcp !== "object") {
    return disabled;
  }

  for (const [name, value] of Object.entries(mcp)) {
    if (name === "servers") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const config = value as { type?: unknown; enabled?: unknown };
    if ((config.type === "remote" || config.type === "local") || config.enabled !== false) continue;
    disabled.add(name);
  }

  return disabled;
}

function getDisabledToolPatterns(config: Record<string, unknown>): string[] {
  const tools = config.tools;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return [];
  const patterns: string[] = [];
  for (const [pattern, value] of Object.entries(tools)) {
    if (pattern === "deny") continue;
    if (value === false) patterns.push(pattern);
  }
  const deny = (tools as { deny?: unknown }).deny;
  if (Array.isArray(deny)) {
    patterns.push(...deny.filter((item): item is string => typeof item === "string"));
  }
  return patterns;
}

function isMcpDisabledByTools(config: Record<string, unknown>, name: string): boolean {
  const patterns = getDisabledToolPatterns(config);
  if (!patterns.length) return false;
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

export function mergeMcpServerEntries(
  globalEntries: McpServerEntry[],
  projectEntries: McpServerEntry[],
): McpServerEntry[] {
  const projectNames = new Set(projectEntries.map((entry) => entry.name));
  return [
    ...globalEntries
      .filter((entry) => !projectNames.has(entry.name))
      .map((entry) => ({ ...entry, source: entry.source ?? ("config.global" as const) })),
    ...projectEntries.map((entry) => ({ ...entry, source: entry.source ?? ("config.project" as const) })),
  ];
}

export function buildEffectiveMcpServerEntriesFromContent(
  globalContent: string,
  projectContent: string,
): McpServerEntry[] {
  const globalConfig = parseJsoncObject(globalContent);
  const projectConfig = parseJsoncObject(projectContent);
  const projectDisabledOverrides = parseDisabledMcpOverrideNamesFromContent(projectContent);
  const globalEntries = parseMcpServersFromContent(globalContent).map((entry) => ({
    ...entry,
    source: "config.global" as const,
    disabledByTools:
      isMcpDisabledByTools(globalConfig, entry.name) || isMcpDisabledByTools(projectConfig, entry.name) || undefined,
  }));
  const projectEntries = parseMcpServersFromContent(projectContent).map((entry) => ({
    ...entry,
    source: "config.project" as const,
    disabledByTools: isMcpDisabledByTools(projectConfig, entry.name) || undefined,
  }));
  const projectEntryNames = new Set(projectEntries.map((entry) => entry.name));
  const disabledInheritedEntries = globalEntries
    .filter((entry) => projectDisabledOverrides.has(entry.name) && !projectEntryNames.has(entry.name))
    .map((entry) => ({
      ...entry,
      config: {
        ...entry.config,
        enabled: false,
      },
      source: "config.project" as const,
    }));

  return mergeMcpServerEntries(globalEntries, [...projectEntries, ...disabledInheritedEntries]);
}

export async function readEffectiveMcpServerEntries(projectDir: string): Promise<McpServerEntry[]> {
  const [globalConfig, projectConfig] = await Promise.all([
    readOpencodeConfig("global", projectDir),
    readOpencodeConfig("project", projectDir),
  ]);

  return buildEffectiveMcpServerEntriesFromContent(globalConfig.content ?? "", projectConfig.content ?? "");
}

export function canRemoveMcpFromProjectConfig(entry: McpServerEntry | undefined): boolean {
  return Boolean(entry && entry.source !== "config.global");
}
