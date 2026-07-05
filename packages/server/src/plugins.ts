import { join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import { resolveVesloDataDir } from "./audit.js";
import { localUserResourceOwner, workspaceResourceOwner } from "./resource-owner.js";
import type { PluginItem, ResourceOwner } from "./types.js";
import { readJsoncFile, updateJsoncTopLevel } from "./jsonc.js";
import {
  opencodeConfigPath,
  projectManagedPluginSpecManifestPath,
  projectManagedPluginsDir,
  projectPluginsDir,
  userManagedPluginSpecManifestPath,
  userManagedPluginsDir,
  userOpencodeConfigPath,
  userPluginsDir,
} from "./workspace-files.js";
import { exists } from "./utils.js";
import { validatePluginSpec } from "./validators.js";
import {
  readManagedPluginFileManifest,
  readManagedPluginSpecManifest,
  type ManagedPluginFileManifestEntry,
  type ManagedPluginSpecManifestEntry,
} from "./plugin-materializer.js";

export type ListPluginsOptions = {
  workspaceOwner?: ResourceOwner;
  globalOwner?: ResourceOwner;
  dataDir?: string;
  userOpencodeConfigDir?: string;
};

export function normalizePluginSpec(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("file:") || trimmed.startsWith("http:") || trimmed.startsWith("https:") || trimmed.startsWith("git:")) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  if (trimmed.startsWith("@")) {
    const atIndex = trimmed.indexOf("@", 1);
    return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
}

function pluginListFromConfig(config: Record<string, unknown>): string[] {
  const plugin = config.plugin;
  if (typeof plugin === "string") return [plugin];
  if (Array.isArray(plugin)) return plugin.filter((item) => typeof item === "string") as string[];
  return [];
}

async function listPluginFiles(
  dir: string,
  scope: "project" | "global",
  owner: ResourceOwner,
  workspaceRoot?: string,
): Promise<PluginItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: PluginItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".ts")) continue;
    const absolutePath = join(dir, entry.name);
    const relativePath = workspaceRoot ? relative(workspaceRoot, absolutePath) : absolutePath;
    items.push({
      spec: `file://${absolutePath}`,
      source: scope === "project" ? "dir.project" : "dir.global",
      scope,
      owner,
      path: relativePath,
      managed: false,
    });
  }
  return items;
}

async function listManagedPluginFiles(
  rootDir: string,
  scope: "project" | "global",
  fallbackOwner: ResourceOwner,
  workspaceRoot?: string,
): Promise<PluginItem[]> {
  const manifest = await readManagedPluginFileManifest(rootDir).catch(() => null);
  if (!manifest) return [];

  const items: PluginItem[] = [];
  for (const entry of manifest.entries) {
    for (const file of entry.files) {
      if (!file.path.endsWith(".js") && !file.path.endsWith(".ts")) continue;
      const absolutePath = join(entry.pluginDir, file.path);
      if (!(await exists(absolutePath))) continue;
      items.push({
        spec: `file://${absolutePath}`,
        source: scope === "project" ? "dir.project" : "dir.global",
        scope,
        owner: ownerFromManagedEntry(entry.owner, fallbackOwner),
        path: workspaceRoot ? relative(workspaceRoot, absolutePath) : absolutePath,
        managed: true,
        policyId: entry.policyId,
        displayName: entry.displayName,
        target: entry.target,
      });
    }
  }
  return items;
}

export async function listPlugins(
  workspaceRoot: string,
  includeGlobal: boolean,
  options: ListPluginsOptions = {},
): Promise<{ items: PluginItem[]; loadOrder: string[] }> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const pluginSpecs = pluginListFromConfig(config);
  const workspaceOwner = options.workspaceOwner ?? workspaceResourceOwner({ root: workspaceRoot });
  const globalOwner = options.globalOwner ?? localUserResourceOwner();
  const projectSpecManifest = await readManagedPluginSpecManifest(projectManagedPluginSpecManifestPath(workspaceRoot))
    .catch(() => null);
  const projectManagedSpecs = managedSpecEntryMap(projectSpecManifest?.entries ?? []);
  const items: PluginItem[] = pluginSpecs.map((spec) =>
    configPluginItem(spec, "project", workspaceOwner, projectManagedSpecs)
  );

  const projectDir = projectPluginsDir(workspaceRoot);
  items.push(...(await listPluginFiles(projectDir, "project", workspaceOwner, workspaceRoot)));
  items.push(...(await listManagedPluginFiles(projectManagedPluginsDir(workspaceRoot), "project", workspaceOwner, workspaceRoot)));

  if (includeGlobal) {
    const dataDir = options.dataDir?.trim() || resolveVesloDataDir();
    const { data: globalConfig } = await readJsoncFile(
      userOpencodeConfigPath(options.userOpencodeConfigDir),
      {} as Record<string, unknown>,
    );
    const globalSpecManifest = await readManagedPluginSpecManifest(userManagedPluginSpecManifestPath(dataDir))
      .catch(() => null);
    const globalManagedSpecs = managedSpecEntryMap(globalSpecManifest?.entries ?? []);
    items.push(
      ...pluginListFromConfig(globalConfig).map((spec) => configPluginItem(spec, "global", globalOwner, globalManagedSpecs)),
    );

    const globalDir = userPluginsDir(options.userOpencodeConfigDir);
    items.push(...(await listPluginFiles(globalDir, "global", globalOwner)));
    items.push(...(await listManagedPluginFiles(userManagedPluginsDir(options.userOpencodeConfigDir), "global", globalOwner)));
  }

  return {
    items,
    loadOrder: ["config.global", "config.project", "dir.global", "dir.project"],
  };
}

function managedSpecEntryMap(entries: ManagedPluginSpecManifestEntry[]): Map<string, ManagedPluginSpecManifestEntry> {
  const map = new Map<string, ManagedPluginSpecManifestEntry>();
  for (const entry of entries) {
    map.set(entry.normalizedSpec, entry);
  }
  return map;
}

function configPluginItem(
  spec: string,
  scope: "project" | "global",
  fallbackOwner: ResourceOwner,
  managedSpecs: Map<string, ManagedPluginSpecManifestEntry>,
): PluginItem {
  const managedEntry = managedSpecs.get(normalizePluginSpec(spec));
  return {
    spec,
    source: "config",
    scope,
    owner: managedEntry ? ownerFromManagedEntry(managedEntry.owner, fallbackOwner) : fallbackOwner,
    managed: Boolean(managedEntry),
    ...(managedEntry
      ? {
        policyId: managedEntry.policyId,
        displayName: managedEntry.displayName,
        target: managedEntry.target,
      }
      : {}),
  };
}

function ownerFromManagedEntry(
  owner: ManagedPluginSpecManifestEntry["owner"] | ManagedPluginFileManifestEntry["owner"],
  fallbackOwner: ResourceOwner,
): ResourceOwner {
  if (owner.kind === "platform" || owner.kind === "organization" || owner.kind === "user") {
    return {
      kind: owner.kind,
      id: owner.id,
      ...(owner.label ? { label: owner.label } : {}),
    };
  }
  return {
    ...fallbackOwner,
    id: owner.id || fallbackOwner.id,
    ...(owner.label ? { label: owner.label } : {}),
  };
}

export async function addPlugin(workspaceRoot: string, spec: string): Promise<boolean> {
  validatePluginSpec(spec);
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const pluginSpecs = pluginListFromConfig(config);
  const normalized = normalizePluginSpec(spec);
  const existing = pluginSpecs.find((item) => normalizePluginSpec(item) === normalized);
  if (existing) return false;
  pluginSpecs.push(spec);
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { plugin: pluginSpecs });
  return true;
}

export async function removePlugin(workspaceRoot: string, name: string): Promise<boolean> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const pluginSpecs = pluginListFromConfig(config);
  const normalized = normalizePluginSpec(name);
  const filtered = pluginSpecs.filter((item) => normalizePluginSpec(item) !== normalized);
  if (filtered.length === pluginSpecs.length) return false;
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { plugin: filtered });
  return true;
}
