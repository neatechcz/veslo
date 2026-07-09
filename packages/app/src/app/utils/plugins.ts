import { applyEdits, modify, parse } from "jsonc-parser";

import type { OpencodeConfigFile } from "../lib/tauri";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../i18n";

type PluginConfigTuple = [string, Record<string, unknown>?];
export type PluginConfigEntry = string | PluginConfigTuple;
type PluginListValue = string | unknown[] | null | undefined;

type PluginConfig = {
  content: string | null;
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePluginConfigEntry(entry: unknown): PluginConfigEntry | null {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed ? trimmed : null;
  }
  if (
    Array.isArray(entry) &&
    typeof entry[0] === "string" &&
    entry[0].trim().length > 0 &&
    (entry.length === 1 || (entry.length === 2 && isRecord(entry[1])))
  ) {
    return entry.length === 1 ? [entry[0].trim()] : [entry[0].trim(), entry[1]];
  }
  return null;
}

function pluginSpecFromConfigEntry(entry: PluginConfigEntry): string {
  return typeof entry === "string" ? entry : entry[0];
}

function normalizePluginConfigEntries(value: PluginListValue): PluginConfigEntry[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value
      .map(normalizePluginConfigEntry)
      .filter((entry): entry is PluginConfigEntry => Boolean(entry));
  }
  return [];
}

export function normalizePluginList(value: PluginListValue) {
  if (!value) return [] as string[];
  return normalizePluginConfigEntries(value).map(pluginSpecFromConfigEntry);
}

function pluginListFromContent(content: string): PluginConfigEntry[] {
  const parsed = parse(content) as Record<string, unknown> | undefined;
  return normalizePluginConfigEntries(parsed?.plugin as PluginListValue);
}

function writePluginListToContent(content: string, plugins: PluginConfigEntry[]): string {
  const edits = modify(content, ["plugin"], plugins, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(content, edits);
}

export function addPluginSpecToContent(content: string, pluginName: string): { added: boolean; content: string } {
  const spec = pluginName.trim();
  const plugins = pluginListFromContent(content);
  const normalized = stripPluginVersion(spec).toLowerCase();
  if (plugins.some((entry) => stripPluginVersion(pluginSpecFromConfigEntry(entry)).toLowerCase() === normalized)) {
    return { added: false, content };
  }
  return { added: true, content: writePluginListToContent(content, [...plugins, spec]) };
}

export function removePluginSpecFromContent(content: string, pluginName: string): { removed: boolean; content: string } {
  const plugins = pluginListFromContent(content);
  const normalized = stripPluginVersion(pluginName.trim()).toLowerCase();
  const next = plugins.filter((entry) => stripPluginVersion(pluginSpecFromConfigEntry(entry)).toLowerCase() !== normalized);
  if (next.length === plugins.length) {
    return { removed: false, content };
  }
  return { removed: true, content: writePluginListToContent(content, next) };
}

export function pluginConfigEntriesFromContent(content: string): PluginConfigEntry[] {
  try {
    return pluginListFromContent(content);
  } catch {
    return [];
  }
}

export function stripPluginVersion(spec: string) {
  const trimmed = spec.trim();
  if (!trimmed) return "";

  const looksLikeVersion = (suffix: string) =>
    /^(latest|next|beta|alpha|canary|rc|stable|\d)/i.test(suffix);

  if (trimmed.startsWith("@")) {
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex === -1) return trimmed;

    const atIndex = trimmed.indexOf("@", slashIndex + 1);
    if (atIndex === -1) return trimmed;

    const suffix = trimmed.slice(atIndex + 1);
    return looksLikeVersion(suffix) ? trimmed.slice(0, atIndex) : trimmed;
  }

  const atIndex = trimmed.indexOf("@");
  if (atIndex === -1) return trimmed;

  const suffix = trimmed.slice(atIndex + 1);
  return looksLikeVersion(suffix) ? trimmed.slice(0, atIndex) : trimmed;
}

export function isPluginInstalled(pluginList: string[], pluginName: string, aliases: string[] = []) {
  const normalized = pluginList.flatMap((entry) => {
    const raw = entry.toLowerCase();
    const stripped = stripPluginVersion(entry).toLowerCase();
    return stripped && stripped !== raw ? [raw, stripped] : [raw];
  });

  const list = new Set(normalized);
  return [pluginName, ...aliases].some((entry) => list.has(entry.toLowerCase()));
}

export function loadPluginsFromConfig(
  config: PluginConfig,
  onList: (next: string[]) => void,
  onError: (message: string) => void,
) {
  if (!config?.content) {
    onList([]);
    return;
  }

  try {
    const parsed = parse(config.content) as Record<string, unknown> | undefined;
    const next = normalizePluginList(parsed?.plugin as PluginListValue);
    onList(next);
  } catch (e) {
    onList([]);
    onError(e instanceof Error ? e.message : __vesloIndirectT("skills.failed_parse_opencode", __vesloIndirectLocale()));
  }
}

export function parsePluginsFromConfig(config: OpencodeConfigFile | null) {
  if (!config?.content) return [] as string[];
  return parsePluginListFromContent(config.content);
}

export function parsePluginListFromContent(content: string) {
  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    return normalizePluginList(parsed?.plugin as PluginListValue);
  } catch {
    return [] as string[];
  }
}
