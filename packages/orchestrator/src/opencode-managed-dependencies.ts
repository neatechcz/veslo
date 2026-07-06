import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile, access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VESLO_MANAGED_PLUGIN_VERSION = "1.17.13";
export const VESLO_MANAGED_ZOD_VERSION = "4.1.8";
export const VESLO_MANAGED_OPENAI_COMPATIBLE_VERSION = "3.0.5";
export const VESLO_MANAGED_AI_SDK_PROVIDER_VERSION = "4.0.2";
export const VESLO_MANAGED_AI_SDK_PROVIDER_UTILS_VERSION = "5.0.5";
export const VESLO_MANAGED_STANDARD_SCHEMA_SPEC_VERSION = "1.1.0";
export const VESLO_MANAGED_WORKFLOW_SERDE_VERSION = "4.1.0";
export const VESLO_MANAGED_EVENTSOURCE_PARSER_VERSION = "3.1.0";
export const VESLO_MANAGED_JSON_SCHEMA_VERSION = "0.4.0";

const VESLO_MANAGED_RUNTIME_PACKAGES = [
  { name: "@opencode-ai/plugin", version: VESLO_MANAGED_PLUGIN_VERSION },
  { name: "zod", version: VESLO_MANAGED_ZOD_VERSION },
  { name: "@ai-sdk/openai-compatible", version: VESLO_MANAGED_OPENAI_COMPATIBLE_VERSION },
  { name: "@ai-sdk/provider", version: VESLO_MANAGED_AI_SDK_PROVIDER_VERSION },
  { name: "@ai-sdk/provider-utils", version: VESLO_MANAGED_AI_SDK_PROVIDER_UTILS_VERSION },
  { name: "@standard-schema/spec", version: VESLO_MANAGED_STANDARD_SCHEMA_SPEC_VERSION },
  { name: "@workflow/serde", version: VESLO_MANAGED_WORKFLOW_SERDE_VERSION },
  { name: "eventsource-parser", version: VESLO_MANAGED_EVENTSOURCE_PARSER_VERSION },
  { name: "json-schema", version: VESLO_MANAGED_JSON_SCHEMA_VERSION },
] as const;

const VESLO_CONFIG_PACKAGE_DEPENDENCIES = VESLO_MANAGED_RUNTIME_PACKAGES.filter(
  (spec) => spec.name !== "@opencode-ai/plugin",
);

type ManagedDependencyEvent = {
  event: string;
  payload: Record<string, unknown>;
};

export type ManagedDependencyEmitter = (
  event: string,
  payload: Record<string, unknown>,
) => void;

export type ManagedDependencyStatus = {
  configDir: string;
  pluginMode: "fallback-zod-shim" | "vendored" | "vendored-version-mismatch" | "missing";
  pluginVersion: string | null;
  pluginPackagePath: string;
  expectedPluginVersion: string;
  zodMode: "vendored" | "vendored-version-mismatch" | "missing";
  zodVersion: string | null;
  zodPackagePath: string;
  expectedZodVersion: string;
  openAiCompatibleMode: "vendored" | "vendored-version-mismatch" | "missing";
  openAiCompatibleVersion: string | null;
  openAiCompatiblePackagePath: string;
  expectedOpenAiCompatibleVersion: string;
};

export type EnsureOpencodeManagedToolsOptions = {
  home?: string;
  managedDepsManifestPath?: string;
  nodeModuleSearchRoots?: string[];
  emit?: ManagedDependencyEmitter;
  toolSources?: {
    send: string;
    status: string;
  };
};

type ManagedDepsManifestFile = {
  schemaVersion?: unknown;
  packages?: unknown;
};

type ManagedDepsManifestPackage = {
  name: string;
  version: string;
  target?: string;
  files: Array<{
    path: string;
    contentBase64: string;
  }>;
};

function emit(options: EnsureOpencodeManagedToolsOptions | undefined, entry: ManagedDependencyEvent): void {
  try {
    options?.emit?.(entry.event, entry.payload);
  } catch {
    // Diagnostics must never affect runtime behavior.
  }
}

async function readPackageJsonVersion(packageDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(packageDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function inspectOpencodeManagedDependencyStatus(configDir: string): Promise<ManagedDependencyStatus> {
  const pluginDir = managedPackageDir(configDir, "@opencode-ai/plugin");
  const zodDir = managedPackageDir(configDir, "zod");
  const openAiCompatibleDir = managedPackageDir(configDir, "@ai-sdk/openai-compatible");
  const pluginVersion = await readPackageJsonVersion(pluginDir);
  const zodVersion = await readPackageJsonVersion(zodDir);
  const openAiCompatibleVersion = await readPackageJsonVersion(openAiCompatibleDir);
  const pluginMode =
    pluginVersion === "0.0.0-veslo-managed"
      ? "fallback-zod-shim"
      : pluginVersion
        ? pluginVersion === VESLO_MANAGED_PLUGIN_VERSION
          ? "vendored"
          : "vendored-version-mismatch"
        : "missing";
  const zodMode =
    zodVersion
      ? zodVersion === VESLO_MANAGED_ZOD_VERSION
        ? "vendored"
        : "vendored-version-mismatch"
      : "missing";
  const openAiCompatibleMode =
    openAiCompatibleVersion
      ? openAiCompatibleVersion === VESLO_MANAGED_OPENAI_COMPATIBLE_VERSION
        ? "vendored"
        : "vendored-version-mismatch"
      : "missing";
  return {
    configDir,
    pluginMode,
    pluginVersion,
    pluginPackagePath: join(pluginDir, "package.json"),
    expectedPluginVersion: VESLO_MANAGED_PLUGIN_VERSION,
    zodMode,
    zodVersion,
    zodPackagePath: join(zodDir, "package.json"),
    expectedZodVersion: VESLO_MANAGED_ZOD_VERSION,
    openAiCompatibleMode,
    openAiCompatibleVersion,
    openAiCompatiblePackagePath: join(openAiCompatibleDir, "package.json"),
    expectedOpenAiCompatibleVersion: VESLO_MANAGED_OPENAI_COMPATIBLE_VERSION,
  };
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  try {
    await cp(src, dst, { recursive: true, force: true });
    const entries = await readdir(src).catch(() => [] as string[]);
    if (entries.length > 0) {
      const dstEntries = await readdir(dst).catch(() => [] as string[]);
      if (dstEntries.length > 0) return;
    } else {
      return;
    }
  } catch {
    // fall through to shell cp
  }
  const result = spawn("cp", ["-R", `${src}/.`, dst], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    result.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cp -R ${src} -> ${dst} exited with code ${code}`));
    });
    result.on("error", reject);
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function resolveBunCacheEntry(home: string, pkg: string, version: string): string {
  return join(home, ".bun", "install", "cache", `${pkg}@${version}@@@1`);
}

function resolveLegacyBunCacheEntry(home: string, pkg: string, version: string): string {
  return join(home, ".bun", "install", "cache", pkg, `${version}@@@1`);
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolveManagedDependencyHome(
  options?: EnsureOpencodeManagedToolsOptions,
): { home: string; source: string } {
  const optionHome = nonEmpty(options?.home);
  if (optionHome) return { home: optionHome, source: "options.home" };

  const envHome = nonEmpty(process.env.HOME);
  if (envHome) return { home: envHome, source: "HOME" };

  const userProfile = nonEmpty(process.env.USERPROFILE);
  if (userProfile) return { home: userProfile, source: "USERPROFILE" };

  const homeDrive = nonEmpty(process.env.HOMEDRIVE);
  const homePath = nonEmpty(process.env.HOMEPATH);
  if (homeDrive && homePath) return { home: `${homeDrive}${homePath}`, source: "HOMEDRIVE/HOMEPATH" };

  const osHome = nonEmpty(homedir());
  if (osHome) return { home: osHome, source: "os.homedir" };

  return { home: "", source: "empty" };
}

function managedDepsManifestCandidates(
  options?: EnsureOpencodeManagedToolsOptions,
): Array<{ path: string; source: string; explicit: boolean }> {
  const candidates: Array<{ path: string; source: string; explicit: boolean }> = [];
  const optionPath = nonEmpty(options?.managedDepsManifestPath);
  if (optionPath) candidates.push({ path: optionPath, source: "options.managedDepsManifestPath", explicit: true });

  const envPath = nonEmpty(process.env.VESLO_OPENCODE_MANAGED_DEPS_FILE);
  if (envPath) candidates.push({ path: envPath, source: "VESLO_OPENCODE_MANAGED_DEPS_FILE", explicit: true });

  const execPath = nonEmpty(process.execPath);
  if (execPath) candidates.push({ path: join(dirname(execPath), "opencode-managed-deps.json"), source: "process.execPath", explicit: false });

  const argv0 = nonEmpty(process.argv[0]);
  if (argv0 && argv0 !== execPath) {
    candidates.push({ path: join(dirname(argv0), "opencode-managed-deps.json"), source: "process.argv[0]", explicit: false });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManagedDepsManifestPackage(value: unknown): ManagedDepsManifestPackage | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name : "";
  const version = typeof value.version === "string" ? value.version : "";
  const target = typeof value.target === "string" && value.target.trim() ? value.target.trim() : undefined;
  if (!name || !version || !Array.isArray(value.files)) return null;

  const files: ManagedDepsManifestPackage["files"] = [];
  for (const file of value.files) {
    if (!isRecord(file)) return null;
    const path = typeof file.path === "string" ? file.path : "";
    const contentBase64 = typeof file.contentBase64 === "string" ? file.contentBase64 : null;
    if (!path || contentBase64 === null) return null;
    files.push({ path, contentBase64 });
  }
  return { name, version, target, files };
}

async function readManagedDepsManifest(path: string): Promise<ManagedDepsManifestPackage[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as ManagedDepsManifestFile;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.packages)) {
    throw new Error(`Invalid managed dependencies manifest at ${path}`);
  }
  return parsed.packages.map((pkg, index) => {
    const parsedPackage = parseManagedDepsManifestPackage(pkg);
    if (!parsedPackage) {
      throw new Error(`Invalid package entry ${index} in managed dependencies manifest at ${path}`);
    }
    return parsedPackage;
  });
}

function safeManifestRelativeParts(path: string): string[] | null {
  if (!path || path.includes("\0")) return null;
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts;
}

async function writeManifestPackageToNodeModules(
  manifestPackage: ManagedDepsManifestPackage,
  destNodeModules: string,
): Promise<{ target: string; wrote: boolean }> {
  const targetPath = manifestPackage.target ?? manifestPackage.name;
  const targetParts = safeManifestRelativeParts(targetPath);
  if (!targetParts) {
    throw new Error(
      `Invalid managed dependency target '${targetPath}' for ${manifestPackage.name}@${manifestPackage.version}`,
    );
  }
  const destDir = join(destNodeModules, ...targetParts);
  const currentVersion = await readPackageJsonVersion(destDir);
  if (currentVersion === manifestPackage.version) {
    return { target: destDir, wrote: false };
  }

  await rm(destDir, { recursive: true, force: true });
  for (const file of manifestPackage.files) {
    const parts = safeManifestRelativeParts(file.path);
    if (!parts) {
      throw new Error(
        `Invalid managed dependency file path '${file.path}' for ${manifestPackage.name}@${manifestPackage.version}`,
      );
    }
    const target = join(destDir, ...parts);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, "base64"));
  }

  const actualVersion = await readPackageJsonVersion(destDir);
  if (actualVersion !== manifestPackage.version) {
    throw new Error(
      `Managed dependencies manifest wrote ${manifestPackage.name}@${actualVersion ?? "unknown"} ` +
        `instead of ${manifestPackage.name}@${manifestPackage.version}`,
    );
  }

  return { target: destDir, wrote: true };
}

async function vendorManifestRuntimeTree(
  destNodeModules: string,
  options?: EnsureOpencodeManagedToolsOptions,
): Promise<boolean> {
  const candidates = managedDepsManifestCandidates(options);
  for (const candidate of candidates) {
    if (!(await pathExists(candidate.path))) {
      if (candidate.explicit) {
        emit(options, {
          event: "opencode-managed-dependencies:manifest-miss",
          payload: { manifestPath: candidate.path, manifestSource: candidate.source },
        });
      }
      continue;
    }

    let packages: ManagedDepsManifestPackage[];
    try {
      packages = await readManagedDepsManifest(candidate.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(options, {
        event: "opencode-managed-dependencies:manifest-error",
        payload: { manifestPath: candidate.path, manifestSource: candidate.source, error: message },
      });
      if (candidate.explicit) throw error;
      continue;
    }

    let wrote = 0;
    for (const manifestPackage of packages) {
      const result = await writeManifestPackageToNodeModules(manifestPackage, destNodeModules);
      if (result.wrote) wrote += 1;
    }
    emit(options, {
      event: "opencode-managed-dependencies:manifest-tree-vendored",
      payload: {
        manifestPath: candidate.path,
        manifestSource: candidate.source,
        packageCount: packages.length,
        wrote,
        skipped: packages.length - wrote,
      },
    });
    return true;
  }

  return false;
}

async function vendorManifestPackage(
  pkg: string,
  version: string,
  destNodeModules: string,
  options?: EnsureOpencodeManagedToolsOptions,
): Promise<boolean> {
  const candidates = managedDepsManifestCandidates(options);
  for (const candidate of candidates) {
    if (!(await pathExists(candidate.path))) {
      if (candidate.explicit) {
        emit(options, {
          event: "opencode-managed-dependencies:manifest-miss",
          payload: { package: pkg, version, manifestPath: candidate.path, manifestSource: candidate.source },
        });
      }
      continue;
    }

    let packages: ManagedDepsManifestPackage[];
    try {
      packages = await readManagedDepsManifest(candidate.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(options, {
        event: "opencode-managed-dependencies:manifest-error",
        payload: { package: pkg, version, manifestPath: candidate.path, manifestSource: candidate.source, error: message },
      });
      if (candidate.explicit) throw error;
      continue;
    }

    const manifestPackage = packages.find((entry) => entry.name === pkg && entry.version === version);
    if (!manifestPackage) {
      emit(options, {
        event: "opencode-managed-dependencies:manifest-package-miss",
        payload: { package: pkg, version, manifestPath: candidate.path, manifestSource: candidate.source },
      });
      if (candidate.explicit) {
        throw new Error(`Managed dependencies manifest ${candidate.path} does not contain ${pkg}@${version}`);
      }
      continue;
    }

    const { target: destDir } = await writeManifestPackageToNodeModules(manifestPackage, destNodeModules);

    emit(options, {
      event: "opencode-managed-dependencies:vendored",
      payload: {
        package: pkg,
        version,
        manifestPath: candidate.path,
        manifestSource: candidate.source,
        source: "managed-manifest",
        target: destDir,
      },
    });
    return true;
  }

  return false;
}

async function vendorBunCachePackage(
  pkg: string,
  version: string,
  destNodeModules: string,
  options?: EnsureOpencodeManagedToolsOptions,
): Promise<boolean> {
  const { home, source: homeSource } = resolveManagedDependencyHome(options);
  let cacheRoot = resolveBunCacheEntry(home, pkg, version);
  if (!(await pathExists(cacheRoot))) {
    const legacy = resolveLegacyBunCacheEntry(home, pkg, version);
    if (!(await pathExists(legacy))) {
      emit(options, {
        event: "opencode-managed-dependencies:cache-miss",
        payload: {
          package: pkg,
          version,
          home,
          homeSource,
          checked: [cacheRoot, legacy],
        },
      });
      return false;
    }
    cacheRoot = legacy;
  }
  const destDir = join(destNodeModules, ...packagePathParts(pkg));
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await copyDirRecursive(cacheRoot, destDir);
  emit(options, {
    event: "opencode-managed-dependencies:vendored",
    payload: {
      package: pkg,
      version,
      home,
      homeSource,
      source: cacheRoot,
      target: destDir,
    },
  });
  return true;
}

function packagePathParts(name: string): string[] {
  return name.split("/").filter(Boolean);
}

function managedPackageDir(root: string, name: string): string {
  return join(root, "node_modules", ...packagePathParts(name));
}

function defaultNodeModuleSearchRoots(): string[] {
  const roots = [
    dirname(fileURLToPath(import.meta.url)),
    process.cwd(),
    dirname(process.execPath),
  ];
  return roots.filter((root) => root.trim().length > 0);
}

async function resolveNodeModulePackageDir(
  pkg: string,
  version: string,
  options?: EnsureOpencodeManagedToolsOptions,
): Promise<string | null> {
  const packageParts = packagePathParts(pkg);
  const roots = options?.nodeModuleSearchRoots?.length
    ? options.nodeModuleSearchRoots
    : defaultNodeModuleSearchRoots();
  const seen = new Set<string>();

  for (const root of roots) {
    let current = root;
    while (true) {
      const currentKey = current.toLowerCase();
      if (!seen.has(currentKey)) {
        seen.add(currentKey);
        const candidates = [
          join(current, "node_modules", ...packageParts),
          join(current, "packages", "orchestrator", "node_modules", ...packageParts),
        ];
        for (const candidate of candidates) {
          const installedVersion = await readPackageJsonVersion(candidate);
          if (installedVersion === version) return realpath(candidate);
        }
      }

      const next = dirname(current);
      if (next === current) break;
      current = next;
    }
  }

  return null;
}

async function vendorNodeModulePackage(
  pkg: string,
  version: string,
  destNodeModules: string,
  options?: EnsureOpencodeManagedToolsOptions,
): Promise<boolean> {
  const packageRoot = await resolveNodeModulePackageDir(pkg, version, options);
  if (!packageRoot) return false;

  const destDir = join(destNodeModules, ...packagePathParts(pkg));
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await copyDirRecursive(packageRoot, destDir);
  emit(options, {
    event: "opencode-managed-dependencies:vendored",
    payload: {
      package: pkg,
      version,
      source: "node-modules",
      sourcePath: packageRoot,
      target: destDir,
    },
  });
  return true;
}

async function ensureManagedPackage(
  pkg: string,
  version: string,
  nodeModulesDir: string,
  options?: EnsureOpencodeManagedToolsOptions,
): Promise<void> {
  const packageDir = join(nodeModulesDir, ...packagePathParts(pkg));
  const currentVersion = await readPackageJsonVersion(packageDir);
  if (currentVersion === version) return;

  if (await vendorManifestPackage(pkg, version, nodeModulesDir, options)) return;

  if (await vendorBunCachePackage(pkg, version, nodeModulesDir, options)) {
    const nextVersion = await readPackageJsonVersion(packageDir);
    if (nextVersion === version) return;
  }

  if (await vendorNodeModulePackage(pkg, version, nodeModulesDir, options)) {
    const nextVersion = await readPackageJsonVersion(packageDir);
    if (nextVersion === version) return;
  }

  throw new Error(
    `Unable to provision ${pkg}@${version} into ${nodeModulesDir}. ` +
      "Checked managed dependency manifest, Bun cache, and local node_modules; no shim fallback will be written.",
  );
}

async function ensureConfigPackageJsonDependencies(configDir: string): Promise<void> {
  const packageJsonPath = join(configDir, "package.json");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
    if (!isRecord(parsed)) parsed = {};
  } catch {
    parsed = {};
  }

  const dependencies = isRecord(parsed.dependencies)
    ? { ...parsed.dependencies }
    : {};
  let changed = !isRecord(parsed.dependencies);

  for (const spec of VESLO_CONFIG_PACKAGE_DEPENDENCIES) {
    if (dependencies[spec.name] === spec.version) continue;
    dependencies[spec.name] = spec.version;
    changed = true;
  }

  if (!changed) return;

  await writeFile(
    packageJsonPath,
    `${JSON.stringify({ ...parsed, dependencies }, null, 2)}\n`,
    "utf8",
  );
}

export async function ensureOpencodeManagedTools(
  configDir: string,
  options?: EnsureOpencodeManagedToolsOptions,
): Promise<ManagedDependencyStatus> {
  emit(options, {
    event: "opencode-managed-dependencies:start",
    payload: { configDir },
  });

  const toolsDir = join(configDir, "tools");
  await mkdir(toolsDir, { recursive: true });
  const writeManagedTool = async (name: string, source: string) => {
    const toolPath = join(toolsDir, name);
    const content = `${source}\n`;
    try {
      const existing = await readFile(toolPath, "utf8");
      if (existing === content) return;
    } catch {
      // ignore
    }
    await writeFile(toolPath, content, "utf8");
  };

  const nodeModulesDir = join(configDir, "node_modules");
  await mkdir(nodeModulesDir, { recursive: true });
  await ensureConfigPackageJsonDependencies(configDir);
  await vendorManifestRuntimeTree(nodeModulesDir, options);

  for (const spec of VESLO_MANAGED_RUNTIME_PACKAGES) {
    await ensureManagedPackage(spec.name, spec.version, nodeModulesDir, options);
  }

  const toolSources = options?.toolSources ?? {
    send: opencodeRouterSendToolSource(),
    status: opencodeRouterStatusToolSource(),
  };
  await writeManagedTool("opencode_router_send.ts", toolSources.send);
  await writeManagedTool("opencode_router_status.ts", toolSources.status);

  const status = await inspectOpencodeManagedDependencyStatus(configDir);
  emit(options, {
    event: "opencode-managed-dependencies:status",
    payload: status,
  });
  return status;
}

function opencodeRouterSendToolSource(): string {
  return [
    'import { tool } from "@opencode-ai/plugin";',
    'import { z } from "zod";',
    "",
    "export default tool({",
    '  description: "Send a message through a configured Veslo channel.",',
    "  parameters: z.object({",
    '    channel: z.enum(["telegram", "slack"]),',
    "    message: z.string(),",
    "    identityId: z.string().optional(),",
    "    target: z.string().optional(),",
    "    directory: z.string().optional(),",
    "  }),",
    "  async execute(input) {",
    "    const port = process.env.OPENCODE_ROUTER_HEALTH_PORT || '3005'",
    "    const response = await fetch(`http://127.0.0.1:${port}/send`, {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    "      body: JSON.stringify(input),",
    "    })",
    "    const body = await response.text()",
    "    if (!response.ok) throw new Error(body || `HTTP ${response.status}`)",
    "    try { return JSON.parse(body) } catch { return { ok: true, body } }",
    "  },",
    "})",
    "",
  ].join("\n");
}

function opencodeRouterStatusToolSource(): string {
  return [
    'import { tool } from "@opencode-ai/plugin";',
    'import { z } from "zod";',
    "",
    "export default tool({",
    '  description: "Inspect Veslo channel status and workspace bindings.",',
    "  parameters: z.object({",
    '    channel: z.enum(["telegram", "slack"]).optional(),',
    "    identityId: z.string().optional(),",
    "    directory: z.string().optional(),",
    "    includeBindings: z.boolean().optional(),",
    "  }),",
    "  async execute(input) {",
    "    const port = process.env.OPENCODE_ROUTER_HEALTH_PORT || '3005'",
    "    const channel = input.channel || 'telegram'",
    "    const identityId = input.identityId || ''",
    "    const directory = input.directory || ''",
    "    const includeBindings = input.includeBindings !== false",
    "    const fetchJson = async (path) => {",
    "      const response = await fetch(`http://127.0.0.1:${port}${path}`)",
    "      const body = await response.text()",
    "      let json = null",
    "      try { json = body ? JSON.parse(body) : null } catch {}",
    "      return { ok: response.ok, status: response.status, json, body, error: response.ok ? null : (json?.error || body || `HTTP ${response.status}`) }",
    "    }",
    "    const health = await fetchJson('/health')",
    "    const identities = await fetchJson(`/identities/${channel}`)",
    "    let bindings = null",
    "    if (includeBindings) {",
    "      const search = new URLSearchParams()",
    "      if (identityId) search.set('identityId', identityId)",
    "      if (directory) search.set('directory', directory)",
    "      bindings = await fetchJson(`/bindings?${search.toString()}`)",
    "    }",
    "    const identityItems = Array.isArray(identities.json?.items) ? identities.json.items : []",
    "    const scopedIdentityItems = identityId ? identityItems.filter((item) => item?.id === identityId) : identityItems",
    "    const enabledItems = scopedIdentityItems.filter((item) => item?.enabled)",
    "    const runningItems = scopedIdentityItems.filter((item) => item?.running)",
    "    const bindingItems = Array.isArray(bindings?.json?.items) ? bindings.json.items : []",
    "    const filteredBindings = bindingItems",
    "    const publicBindings = filteredBindings.map((item) => ({ identityId: item.identityId, directory: item.directory }))",
    "    return JSON.stringify({",
    "      channel,",
    "      ...(identityId ? { identityId } : {}),",
    "      ...(directory ? { directory } : {}),",
    "      health: { ok: health.ok, status: health.status, error: health.ok ? undefined : health.error, snapshot: health.ok ? health.json : undefined },",
    "      identities: { ok: identities.ok, status: identities.status, error: identities.ok ? undefined : identities.error, configured: scopedIdentityItems.length, enabled: enabledItems.length, running: runningItems.length, items: scopedIdentityItems },",
    "      ...(includeBindings ? { bindings: { ok: Boolean(bindings?.ok), status: bindings?.status, error: bindings?.ok ? undefined : bindings?.error, count: filteredBindings.length, items: publicBindings } } : {}),",
    "    }, null, 2)",
    "  },",
    "})",
    "",
  ].join("\n");
}
