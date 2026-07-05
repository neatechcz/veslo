import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { resolveVesloDataDir } from "./audit.js";
import { readJsoncFile, updateJsoncTopLevel } from "./jsonc.js";
import type { EffectivePluginPolicy, PluginPolicy } from "./plugin-policy.js";
import {
  opencodeConfigPath,
  projectManagedPluginSpecManifestPath,
  projectManagedPluginsDir,
  userManagedPluginSpecManifestPath,
  userManagedPluginsDir,
  userOpencodeConfigPath,
} from "./workspace-files.js";
import { ensureDir, exists } from "./utils.js";

export type PluginMaterializationTarget = "project" | "user";

export type MaterializablePluginFile = {
  path: string;
  content: string;
  executable?: boolean;
};

export type MaterializablePluginPolicy = PluginPolicy & Partial<Pick<EffectivePluginPolicy, "lifecycle" | "effectiveEnabled">> & {
  files?: MaterializablePluginFile[];
};

export type ManagedPluginSpecManifestEntry = {
  policyId: string;
  spec: string;
  normalizedSpec: string;
  displayName: string;
  target: PluginMaterializationTarget;
  source: PluginPolicy["source"];
  owner: PluginPolicy["owner"];
  materializedAt: string;
};

export type ManagedPluginSpecManifest = {
  schemaVersion: 1;
  managedBy: typeof MANAGED_BY;
  target: PluginMaterializationTarget;
  generatedAt: string;
  entries: ManagedPluginSpecManifestEntry[];
};

export type ManagedPluginFileManifestFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
  executable: boolean;
};

export type ManagedPluginFileManifestEntry = {
  policyId: string;
  spec: string;
  displayName: string;
  target: PluginMaterializationTarget;
  source: PluginPolicy["source"];
  owner: PluginPolicy["owner"];
  pluginDir: string;
  files: ManagedPluginFileManifestFile[];
  materializedAt: string;
};

export type ManagedPluginFileManifest = {
  schemaVersion: 1;
  managedBy: typeof MANAGED_BY;
  target: PluginMaterializationTarget;
  generatedAt: string;
  entries: ManagedPluginFileManifestEntry[];
};

export type PluginMaterializationConflict = {
  code:
    | "unmanaged_config_spec_conflict"
    | "unmanaged_file_plugin_conflict"
    | "stale_file_plugin_unmarked";
  policyId: string;
  spec: string;
  target: PluginMaterializationTarget;
  message: string;
  path?: string;
};

export type PluginMaterializationTargetResult = {
  config: {
    manifestPath: string;
    addedSpecs: string[];
    removedSpecs: string[];
    desiredSpecs: string[];
  };
  files: {
    rootDir: string;
    materializedPolicyIds: string[];
    removedPolicyIds: string[];
  };
};

export type PluginMaterializationSuccess = {
  ok: true;
  conflicts: [];
  project: PluginMaterializationTargetResult;
  user: PluginMaterializationTargetResult;
  reloadRequired: boolean;
};

export type PluginMaterializationFailure = {
  ok: false;
  conflicts: PluginMaterializationConflict[];
  project: PluginMaterializationTargetResult;
  user: PluginMaterializationTargetResult;
  reloadRequired: false;
};

export type PluginMaterializationResult = PluginMaterializationSuccess | PluginMaterializationFailure;

export type MaterializePluginPoliciesInput = {
  workspaceRoot: string;
  dataDir?: string;
  userOpencodeConfigDir?: string;
  policies: MaterializablePluginPolicy[];
};

type ConfigTargetContext = {
  target: PluginMaterializationTarget;
  configPath: string;
  manifestPath: string;
  pluginSpecs: string[];
  previousManifest: ManagedPluginSpecManifest | null;
  desiredEntries: ManagedPluginSpecManifestEntry[];
  conflicts: PluginMaterializationConflict[];
};

type FileTargetContext = {
  target: PluginMaterializationTarget;
  rootDir: string;
  previousManifest: ManagedPluginFileManifest | null;
  policies: MaterializablePluginPolicy[];
  conflicts: PluginMaterializationConflict[];
};

const MANAGED_BY = "veslo-plugin-materializer";
const SPEC_MANIFEST_FILE = "managed-plugin-specs.json";
const FILE_ROOT_MANIFEST_FILE = ".veslo-plugin-materialization.json";
const FILE_PLUGIN_MARKER_FILE = ".veslo-managed-plugin.json";

export function pluginMaterializerManagedBy(): typeof MANAGED_BY {
  return MANAGED_BY;
}

export function managedPluginSpecManifestFileName(): typeof SPEC_MANIFEST_FILE {
  return SPEC_MANIFEST_FILE;
}

export function managedPluginFileManifestPath(rootDir: string): string {
  return join(rootDir, FILE_ROOT_MANIFEST_FILE);
}

export function managedPluginFileMarkerPath(pluginDir: string): string {
  return join(pluginDir, FILE_PLUGIN_MARKER_FILE);
}

export async function readManagedPluginSpecManifest(path: string): Promise<ManagedPluginSpecManifest | null> {
  if (!(await exists(path))) return null;
  return validateManagedPluginSpecManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function readManagedPluginFileManifest(rootDir: string): Promise<ManagedPluginFileManifest | null> {
  const path = managedPluginFileManifestPath(rootDir);
  if (!(await exists(path))) return null;
  return validateManagedPluginFileManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function materializePluginPolicies(
  input: MaterializePluginPoliciesInput,
): Promise<PluginMaterializationResult> {
  const dataDir = resolveDataDir(input.dataDir);
  const desiredPolicies = input.policies.filter(shouldMaterializePolicy);
  const configPolicies = desiredPolicies.filter((policy) => !isFilePolicy(policy));
  const filePolicies = desiredPolicies.filter(isFilePolicy);

  const projectConfig = await prepareConfigTarget({
    target: "project",
    configPath: opencodeConfigPath(input.workspaceRoot),
    manifestPath: projectManagedPluginSpecManifestPath(input.workspaceRoot),
    policies: configPolicies.filter((policy) => policy.target === "project"),
  });
  const userConfig = await prepareConfigTarget({
    target: "user",
    configPath: userOpencodeConfigPath(input.userOpencodeConfigDir),
    manifestPath: userManagedPluginSpecManifestPath(dataDir),
    policies: configPolicies.filter((policy) => policy.target === "user"),
  });
  const projectFiles = await prepareFileTarget({
    target: "project",
    rootDir: projectManagedPluginsDir(input.workspaceRoot),
    policies: filePolicies.filter((policy) => policy.target === "project"),
  });
  const userFiles = await prepareFileTarget({
    target: "user",
    rootDir: userManagedPluginsDir(input.userOpencodeConfigDir),
    policies: filePolicies.filter((policy) => policy.target === "user"),
  });

  const conflicts = [
    ...projectConfig.conflicts,
    ...userConfig.conflicts,
    ...projectFiles.conflicts,
    ...userFiles.conflicts,
  ];
  if (conflicts.length > 0) {
    return {
      ok: false,
      conflicts,
      project: emptyTargetResult(projectConfig.manifestPath, projectFiles.rootDir),
      user: emptyTargetResult(userConfig.manifestPath, userFiles.rootDir),
      reloadRequired: false,
    };
  }

  const projectConfigResult = await applyConfigTarget(projectConfig);
  const userConfigResult = await applyConfigTarget(userConfig);
  const projectFileResult = await applyFileTarget(projectFiles);
  const userFileResult = await applyFileTarget(userFiles);

  const project = combineTargetResults(projectConfigResult, projectFileResult);
  const user = combineTargetResults(userConfigResult, userFileResult);
  const reloadRequired = targetChanged(project) || targetChanged(user);

  return {
    ok: true,
    conflicts: [],
    project,
    user,
    reloadRequired,
  };
}

async function prepareConfigTarget(input: {
  target: PluginMaterializationTarget;
  configPath: string;
  manifestPath: string;
  policies: MaterializablePluginPolicy[];
}): Promise<ConfigTargetContext> {
  const { data: config } = await readJsoncFile<Record<string, unknown>>(input.configPath, {});
  const pluginSpecs = pluginListFromConfig(config);
  const previousManifest = await readManagedPluginSpecManifest(input.manifestPath);
  const desiredEntries = input.policies.map((policy) => specManifestEntryForPolicy(policy, input.target));
  const previousManagedSpecs = new Set(
    (previousManifest?.entries ?? []).map((entry) => managedSpecOwnershipKey(entry)),
  );
  const conflicts: PluginMaterializationConflict[] = [];

  for (const entry of desiredEntries) {
    const existing = pluginSpecs.find((spec) => normalizePluginSpec(spec) === entry.normalizedSpec);
    if (!existing) continue;
    const previousKey = managedSpecOwnershipKey({
      policyId: entry.policyId,
      normalizedSpec: normalizePluginSpec(existing),
    });
    if (previousManagedSpecs.has(previousKey)) continue;
    conflicts.push({
      code: "unmanaged_config_spec_conflict",
      policyId: entry.policyId,
      spec: entry.spec,
      target: input.target,
      path: input.configPath,
      message: `Refusing to claim unmanaged OpenCode plugin spec ${entry.spec}`,
    });
  }

  return {
    target: input.target,
    configPath: input.configPath,
    manifestPath: input.manifestPath,
    pluginSpecs,
    previousManifest,
    desiredEntries,
    conflicts,
  };
}

async function applyConfigTarget(
  context: ConfigTargetContext,
): Promise<PluginMaterializationTargetResult["config"]> {
  const desiredNormalizedSpecs = new Set(context.desiredEntries.map((entry) => entry.normalizedSpec));
  const desiredSpecs = context.desiredEntries.map((entry) => entry.spec);
  const removedSpecs: string[] = [];
  let nextSpecs = [...context.pluginSpecs];

  for (const previous of context.previousManifest?.entries ?? []) {
    if (desiredNormalizedSpecs.has(previous.normalizedSpec)) continue;
    const before = nextSpecs.length;
    nextSpecs = nextSpecs.filter((spec) => spec !== previous.spec);
    if (nextSpecs.length !== before) removedSpecs.push(previous.spec);
  }

  const addedSpecs: string[] = [];
  for (const entry of context.desiredEntries) {
    if (nextSpecs.some((spec) => normalizePluginSpec(spec) === entry.normalizedSpec)) continue;
    nextSpecs.push(entry.spec);
    addedSpecs.push(entry.spec);
  }

  if (addedSpecs.length > 0 || removedSpecs.length > 0) {
    await updateJsoncTopLevel(context.configPath, { plugin: nextSpecs });
  }
  if (context.desiredEntries.length > 0 || context.previousManifest) {
    await writeManagedPluginSpecManifest(context.manifestPath, context.target, context.desiredEntries);
  }

  return {
    manifestPath: context.manifestPath,
    addedSpecs,
    removedSpecs,
    desiredSpecs,
  };
}

async function prepareFileTarget(input: {
  target: PluginMaterializationTarget;
  rootDir: string;
  policies: MaterializablePluginPolicy[];
}): Promise<FileTargetContext> {
  const previousManifest = await readManagedPluginFileManifest(input.rootDir);
  const conflicts: PluginMaterializationConflict[] = [];

  for (const policy of input.policies) {
    const pluginDir = pluginDirForPolicy(input.rootDir, policy);
    if (!(await exists(pluginDir))) continue;
    const marker = await readManagedPluginFileMarker(pluginDir).catch(() => null);
    if (marker?.policyId === policy.id && marker.managedBy === MANAGED_BY) continue;
    conflicts.push({
      code: "unmanaged_file_plugin_conflict",
      policyId: policy.id,
      spec: policy.spec,
      target: input.target,
      path: pluginDir,
      message: `Refusing to overwrite unmanaged file plugin directory ${pluginDir}`,
    });
  }

  const desiredPolicyIds = new Set(input.policies.map((policy) => policy.id));
  for (const entry of previousManifest?.entries ?? []) {
    if (desiredPolicyIds.has(entry.policyId)) continue;
    if (!(await exists(entry.pluginDir))) continue;
    const marker = await readManagedPluginFileMarker(entry.pluginDir).catch(() => null);
    if (marker?.policyId === entry.policyId && marker.managedBy === MANAGED_BY) continue;
    conflicts.push({
      code: "stale_file_plugin_unmarked",
      policyId: entry.policyId,
      spec: entry.spec,
      target: input.target,
      path: entry.pluginDir,
      message: `Refusing to remove stale file plugin without Veslo marker ${entry.pluginDir}`,
    });
  }

  return {
    target: input.target,
    rootDir: input.rootDir,
    previousManifest,
    policies: input.policies,
    conflicts,
  };
}

async function applyFileTarget(context: FileTargetContext): Promise<PluginMaterializationTargetResult["files"]> {
  const desiredPolicyIds = new Set(context.policies.map((policy) => policy.id));
  const removedPolicyIds: string[] = [];

  for (const entry of context.previousManifest?.entries ?? []) {
    if (desiredPolicyIds.has(entry.policyId)) continue;
    if (!(await exists(entry.pluginDir))) continue;
    const marker = await readManagedPluginFileMarker(entry.pluginDir).catch(() => null);
    if (marker?.policyId !== entry.policyId || marker.managedBy !== MANAGED_BY) continue;
    await rm(entry.pluginDir, { recursive: true, force: true });
    removedPolicyIds.push(entry.policyId);
  }

  const materializedAt = new Date().toISOString();
  const entries: ManagedPluginFileManifestEntry[] = [];
  const materializedPolicyIds: string[] = [];
  for (const policy of context.policies) {
    const entry = await writeFilePluginPolicy(context.rootDir, context.target, policy, materializedAt);
    entries.push(entry);
    materializedPolicyIds.push(policy.id);
  }

  if (entries.length > 0 || context.previousManifest) {
    await writeManagedPluginFileManifest(context.rootDir, context.target, entries);
  }

  return {
    rootDir: context.rootDir,
    materializedPolicyIds,
    removedPolicyIds: removedPolicyIds.sort(),
  };
}

async function writeFilePluginPolicy(
  rootDir: string,
  target: PluginMaterializationTarget,
  policy: MaterializablePluginPolicy,
  materializedAt: string,
): Promise<ManagedPluginFileManifestEntry> {
  const files = normalizePluginFiles(policy.files ?? []);
  const pluginDir = pluginDirForPolicy(rootDir, policy);
  if (await exists(pluginDir)) {
    await rm(pluginDir, { recursive: true, force: true });
  }
  await mkdir(pluginDir, { recursive: true });

  const manifestFiles: ManagedPluginFileManifestFile[] = [];
  for (const file of files) {
    const filePath = join(pluginDir, file.path);
    await ensureDir(dirname(filePath));
    await writeFile(filePath, file.content, "utf8");
    manifestFiles.push({
      path: file.path,
      sha256: sha256(file.content),
      sizeBytes: Buffer.byteLength(file.content, "utf8"),
      executable: file.executable === true,
    });
  }

  const entry: ManagedPluginFileManifestEntry = {
    policyId: policy.id,
    spec: policy.spec,
    displayName: policy.displayName,
    target,
    source: policy.source,
    owner: policy.owner,
    pluginDir,
    files: manifestFiles,
    materializedAt,
  };
  await writeManagedPluginFileMarker(pluginDir, entry);
  return entry;
}

async function writeManagedPluginSpecManifest(
  path: string,
  target: PluginMaterializationTarget,
  entries: ManagedPluginSpecManifestEntry[],
): Promise<void> {
  const manifest: ManagedPluginSpecManifest = {
    schemaVersion: 1,
    managedBy: MANAGED_BY,
    target,
    generatedAt: new Date().toISOString(),
    entries: [...entries].sort(compareSpecEntries),
  };
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeManagedPluginFileManifest(
  rootDir: string,
  target: PluginMaterializationTarget,
  entries: ManagedPluginFileManifestEntry[],
): Promise<void> {
  const manifest: ManagedPluginFileManifest = {
    schemaVersion: 1,
    managedBy: MANAGED_BY,
    target,
    generatedAt: new Date().toISOString(),
    entries: [...entries].sort(compareFileEntries),
  };
  await mkdir(rootDir, { recursive: true });
  await writeFile(managedPluginFileManifestPath(rootDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readManagedPluginFileMarker(pluginDir: string): Promise<ManagedPluginFileManifestEntry & { schemaVersion: 1; managedBy: typeof MANAGED_BY }> {
  return validateManagedPluginFileMarker(JSON.parse(await readFile(managedPluginFileMarkerPath(pluginDir), "utf8")));
}

async function writeManagedPluginFileMarker(
  pluginDir: string,
  entry: ManagedPluginFileManifestEntry,
): Promise<void> {
  await writeFile(
    managedPluginFileMarkerPath(pluginDir),
    `${JSON.stringify({ schemaVersion: 1, managedBy: MANAGED_BY, ...entry }, null, 2)}\n`,
    "utf8",
  );
}

function shouldMaterializePolicy(policy: MaterializablePluginPolicy): boolean {
  if (policy.autoInstall === false) return false;
  if (policy.effectiveEnabled === false) return false;
  if (policy.lifecycle === "disabled" || policy.lifecycle === "removed" || policy.lifecycle === "conflict") return false;
  return true;
}

function isFilePolicy(policy: MaterializablePluginPolicy): policy is MaterializablePluginPolicy & { files: MaterializablePluginFile[] } {
  return Array.isArray(policy.files) && policy.files.length > 0;
}

function specManifestEntryForPolicy(
  policy: MaterializablePluginPolicy,
  target: PluginMaterializationTarget,
  materializedAt = new Date().toISOString(),
): ManagedPluginSpecManifestEntry {
  return {
    policyId: policy.id,
    spec: policy.spec,
    normalizedSpec: normalizePluginSpec(policy.spec),
    displayName: policy.displayName,
    target,
    source: policy.source,
    owner: policy.owner,
    materializedAt,
  };
}

function pluginDirForPolicy(rootDir: string, policy: MaterializablePluginPolicy): string {
  return join(rootDir, safePluginDirectoryName(policy.id));
}

function safePluginDirectoryName(policyId: string): string {
  const safeBase = policyId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "plugin";
  return `${safeBase}-${sha256(policyId).slice(0, 10)}`;
}

function normalizePluginFiles(files: MaterializablePluginFile[]): MaterializablePluginFile[] {
  if (files.length === 0) {
    throw new Error("File plugin policies must include at least one file");
  }
  const seen = new Set<string>();
  return files.map((file) => {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new Error("Managed plugin file entries must include path and content");
    }
    const path = file.path.trim();
    if (!path || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
      throw new Error("Managed plugin file path is invalid");
    }
    if (seen.has(path)) {
      throw new Error(`Managed plugin file path is duplicated: ${path}`);
    }
    seen.add(path);
    return {
      path,
      content: file.content,
      executable: file.executable === true,
    };
  });
}

function pluginListFromConfig(config: Record<string, unknown>): string[] {
  const plugin = config.plugin;
  if (typeof plugin === "string") return [plugin];
  if (Array.isArray(plugin)) return plugin.filter((item): item is string => typeof item === "string");
  return [];
}

export function normalizePluginSpecForMaterialization(spec: string): string {
  return normalizePluginSpec(spec);
}

function normalizePluginSpec(spec: string): string {
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

function managedSpecOwnershipKey(entry: Pick<ManagedPluginSpecManifestEntry, "policyId" | "normalizedSpec">): string {
  return `${entry.policyId}\0${entry.normalizedSpec}`;
}

function emptyTargetResult(manifestPath: string, rootDir: string): PluginMaterializationTargetResult {
  return {
    config: {
      manifestPath,
      addedSpecs: [],
      removedSpecs: [],
      desiredSpecs: [],
    },
    files: {
      rootDir,
      materializedPolicyIds: [],
      removedPolicyIds: [],
    },
  };
}

function combineTargetResults(
  config: PluginMaterializationTargetResult["config"],
  files: PluginMaterializationTargetResult["files"],
): PluginMaterializationTargetResult {
  return { config, files };
}

function targetChanged(result: PluginMaterializationTargetResult): boolean {
  return result.config.addedSpecs.length > 0 ||
    result.config.removedSpecs.length > 0 ||
    result.files.materializedPolicyIds.length > 0 ||
    result.files.removedPolicyIds.length > 0;
}

function validateManagedPluginSpecManifest(value: unknown): ManagedPluginSpecManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.managedBy !== MANAGED_BY) {
    throw new Error("Managed plugin spec manifest is invalid");
  }
  const target = validateTarget(value.target);
  const generatedAt = stringValue(value.generatedAt);
  if (!generatedAt || !Array.isArray(value.entries)) {
    throw new Error("Managed plugin spec manifest is incomplete");
  }
  return {
    schemaVersion: 1,
    managedBy: MANAGED_BY,
    target,
    generatedAt,
    entries: value.entries.map((entry) => validateManagedPluginSpecManifestEntry(entry, target)).sort(compareSpecEntries),
  };
}

function validateManagedPluginSpecManifestEntry(
  value: unknown,
  target: PluginMaterializationTarget,
): ManagedPluginSpecManifestEntry {
  if (!isRecord(value)) throw new Error("Managed plugin spec manifest entry is invalid");
  const policyId = stringValue(value.policyId);
  const spec = stringValue(value.spec);
  const displayName = stringValue(value.displayName);
  const materializedAt = stringValue(value.materializedAt);
  const owner = validateOwner(value.owner);
  if (!policyId || !spec || !displayName || !materializedAt || !owner) {
    throw new Error("Managed plugin spec manifest entry is incomplete");
  }
  return {
    policyId,
    spec,
    normalizedSpec: stringValue(value.normalizedSpec) || normalizePluginSpec(spec),
    displayName,
    target: validateTarget(value.target ?? target),
    source: validatePolicySource(value.source),
    owner,
    materializedAt,
  };
}

function validateManagedPluginFileManifest(value: unknown): ManagedPluginFileManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.managedBy !== MANAGED_BY) {
    throw new Error("Managed plugin file manifest is invalid");
  }
  const target = validateTarget(value.target);
  const generatedAt = stringValue(value.generatedAt);
  if (!generatedAt || !Array.isArray(value.entries)) {
    throw new Error("Managed plugin file manifest is incomplete");
  }
  return {
    schemaVersion: 1,
    managedBy: MANAGED_BY,
    target,
    generatedAt,
    entries: value.entries.map((entry) => validateManagedPluginFileManifestEntry(entry, target)).sort(compareFileEntries),
  };
}

function validateManagedPluginFileMarker(
  value: unknown,
): ManagedPluginFileManifestEntry & { schemaVersion: 1; managedBy: typeof MANAGED_BY } {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.managedBy !== MANAGED_BY) {
    throw new Error("Managed plugin file marker is invalid");
  }
  return {
    schemaVersion: 1,
    managedBy: MANAGED_BY,
    ...validateManagedPluginFileManifestEntry(value, validateTarget(value.target)),
  };
}

function validateManagedPluginFileManifestEntry(
  value: unknown,
  target: PluginMaterializationTarget,
): ManagedPluginFileManifestEntry {
  if (!isRecord(value)) throw new Error("Managed plugin file manifest entry is invalid");
  const policyId = stringValue(value.policyId);
  const spec = stringValue(value.spec);
  const displayName = stringValue(value.displayName);
  const pluginDir = stringValue(value.pluginDir);
  const materializedAt = stringValue(value.materializedAt);
  const owner = validateOwner(value.owner);
  if (!policyId || !spec || !displayName || !pluginDir || !materializedAt || !owner || !Array.isArray(value.files)) {
    throw new Error("Managed plugin file manifest entry is incomplete");
  }
  return {
    policyId,
    spec,
    displayName,
    target: validateTarget(value.target ?? target),
    source: validatePolicySource(value.source),
    owner,
    pluginDir,
    files: value.files.map(validateManagedPluginFile),
    materializedAt,
  };
}

function validateManagedPluginFile(value: unknown): ManagedPluginFileManifestFile {
  if (!isRecord(value)) throw new Error("Managed plugin file entry is invalid");
  const path = stringValue(value.path);
  const sha = stringValue(value.sha256);
  const sizeBytes = typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes) ? value.sizeBytes : -1;
  if (!path || !sha || sizeBytes < 0) {
    throw new Error("Managed plugin file entry is incomplete");
  }
  return {
    path,
    sha256: sha,
    sizeBytes,
    executable: value.executable === true,
  };
}

function validateTarget(value: unknown): PluginMaterializationTarget {
  if (value === "project" || value === "user") return value;
  throw new Error("Managed plugin target is invalid");
}

function validatePolicySource(value: unknown): PluginPolicy["source"] {
  if (
    value === "policy.platform" ||
    value === "policy.organization" ||
    value === "policy.user" ||
    value === "policy.project" ||
    value === "config.unmanaged"
  ) {
    return value;
  }
  return "policy.platform";
}

function validateOwner(value: unknown): PluginPolicy["owner"] | null {
  if (!isRecord(value)) return null;
  const kind = stringValue(value.kind);
  const id = stringValue(value.id);
  const label = stringValue(value.label);
  if (!kind || !id || (kind !== "platform" && kind !== "organization" && kind !== "user" && kind !== "project")) {
    return null;
  }
  return {
    kind,
    id,
    ...(label ? { label } : {}),
  };
}

function compareSpecEntries(left: ManagedPluginSpecManifestEntry, right: ManagedPluginSpecManifestEntry): number {
  return left.policyId.localeCompare(right.policyId) || left.spec.localeCompare(right.spec);
}

function compareFileEntries(left: ManagedPluginFileManifestEntry, right: ManagedPluginFileManifestEntry): number {
  return left.policyId.localeCompare(right.policyId) || left.pluginDir.localeCompare(right.pluginDir);
}

function resolveDataDir(dataDir?: string): string {
  const trimmed = dataDir?.trim();
  return trimmed ? trimmed : resolveVesloDataDir();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const __pluginMaterializerTestHooks = {
  managedBy: MANAGED_BY,
  specManifestFile: SPEC_MANIFEST_FILE,
  fileRootManifestFile: FILE_ROOT_MANIFEST_FILE,
  filePluginMarkerFile: FILE_PLUGIN_MARKER_FILE,
  safePluginDirectoryName,
};
