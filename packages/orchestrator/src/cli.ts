#!/usr/bin/env node
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { WorkerSandbox } from "./sandbox/index.js";
import { resolveSandbox } from "./sandbox/index.js";
import { randomUUID, createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, realpath } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { homedir, hostname, networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { once } from "node:events";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { TuiHandle } from "./tui/app.js";
import { reconcileOpencodeVersion } from "./opencode-version.js";
import { sanitizeRuntimePayloadForLogs } from "./security.js";
import { readVersionManifestFromDirs, type VersionInfo, type VersionManifest } from "./version-manifest.js";
import type { SerializedEngineState } from "./engine-pool.js";
import { atomicWriteJson, cleanupStaleTmpFiles, createDebouncedPersister } from "./persistence.js";
import { EnginePool, type EngineProcess } from "./engine-pool.js";
import { proxyToEngine } from "./router-proxy.js";

type ApprovalMode = "manual" | "auto";

type LogFormat = "pretty" | "json";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type LoggerChild = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
  debug: (message: string, attributes?: LogAttributes) => void;
  info: (message: string, attributes?: LogAttributes) => void;
  warn: (message: string, attributes?: LogAttributes) => void;
  error: (message: string, attributes?: LogAttributes) => void;
};

type Logger = {
  format: LogFormat;
  output: "stdout" | "silent";
  log: (level: LogLevel, message: string, attributes?: LogAttributes, component?: string) => void;
  debug: (message: string, attributes?: LogAttributes, component?: string) => void;
  info: (message: string, attributes?: LogAttributes, component?: string) => void;
  warn: (message: string, attributes?: LogAttributes, component?: string) => void;
  error: (message: string, attributes?: LogAttributes, component?: string) => void;
  child: (component: string, attributes?: LogAttributes) => LoggerChild;
};

type LogEvent = {
  time: number;
  level: LogLevel;
  message: string;
  component?: string;
  attributes?: LogAttributes;
};

type OpencodeHotReload = {
  enabled: boolean;
  debounceMs: number;
  cooldownMs: number;
};

type OpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
};

const FALLBACK_VERSION = "0.1.0";

declare const __VESLO_ORCHESTRATOR_VERSION__: string | undefined;
const DEFAULT_VESLO_PORT = 8787;
const DEFAULT_APPROVAL_TIMEOUT = 30000;
const DEFAULT_OPENCODE_USERNAME = "opencode";
const DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS = 700;
const DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS = 1500;
const DEFAULT_MANAGED_AI_BASE_URL = "https://ai.veslo.work";

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type ChildHandle = {
  name: string;
  child: ReturnType<typeof spawn>;
};

type SidecarName = "veslo-server" | "veslo-code-router" | "veslo-code";

type SidecarTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "windows-x64"
  | "windows-arm64";

type RemoteSidecarAsset = {
  asset?: string;
  url?: string;
  sha256?: string;
  size?: number;
};

type RemoteSidecarEntry = {
  version: string;
  targets: Record<string, RemoteSidecarAsset>;
};

type RemoteSidecarManifest = {
  version: string;
  generatedAt?: string;
  entries: Record<string, RemoteSidecarEntry>;
};

type SidecarConfig = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
};

type BinarySource = "bundled" | "external" | "downloaded";

type BinarySourcePreference = "auto" | "bundled" | "downloaded" | "external";

type ResolvedBinary = {
  bin: string;
  source: BinarySource;
  expectedVersion?: string;
};

type BinaryDiagnostics = {
  path: string;
  source: BinarySource;
  expectedVersion?: string;
  actualVersion?: string;
};

type SidecarDiagnostics = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
  source: BinarySourcePreference;
  opencodeSource: BinarySourcePreference;
  allowExternal: boolean;
};

type RouterWorkspaceType = "local" | "remote";

type RouterWorkspace = {
  id: string;
  name: string;
  path: string;
  workspaceType: RouterWorkspaceType;
  baseUrl?: string;
  directory?: string;
  createdAt: number;
  lastUsedAt?: number;
};

type RouterDaemonState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

type RouterOpencodeState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

type RouterBinaryInfo = {
  path: string;
  source: BinarySource;
  expectedVersion?: string;
  actualVersion?: string;
};

type RouterBinaryState = {
  opencode?: RouterBinaryInfo;
};

type RouterSidecarState = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
  source: BinarySourcePreference;
  opencodeSource: BinarySourcePreference;
  allowExternal: boolean;
};

type RouterState = {
  version: number;
  daemon?: RouterDaemonState;
  /**
   * @deprecated VSLO-171 fáze 2 F2Ú3 — singleton engine path smazán.
   * Field zachován pro deserializaci starých state files; nikdy se nezapisuje.
   */
  opencode?: RouterOpencodeState;
  engines?: Record<string, SerializedEngineState>;
  cliVersion?: string;
  sidecar?: RouterSidecarState;
  binaries?: RouterBinaryState;
  activeId: string;
  workspaces: RouterWorkspace[];
};

type FieldsResult<T> = {
  data?: T;
  error?: unknown;
  request?: Request;
  response?: Response;
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v") {
      flags.set("version", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    if (!trimmed) continue;

    if (trimmed.startsWith("no-")) {
      flags.set(trimmed.slice(3), false);
      continue;
    }

    const [key, inlineValue] = trimmed.split("=");
    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { positionals, flags };
}

function parseList(value?: string): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

function readBool(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: boolean,
  envKey?: string,
): boolean {
  const raw = flags.get(key);
  if (raw !== undefined) {
    if (typeof raw === "boolean") return raw;
    const normalized = String(raw).toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }

  const envValue = envKey ? process.env[envKey] : undefined;
  if (envValue) {
    const normalized = envValue.toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }

  return fallback;
}

function readNumber(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: number | undefined,
  envKey?: string,
): number | undefined {
  const raw = flags.get(key);
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (envKey) {
    const envValue = process.env[envKey];
    if (envValue) {
      const parsed = Number(envValue);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fallback;
}

function readOpencodeHotReload(
  flags: Map<string, string | boolean>,
  defaults?: Partial<OpencodeHotReload>,
  env?: {
    enabled?: string;
    debounceMs?: string;
    cooldownMs?: string;
  },
): OpencodeHotReload {
  const enabled = readBool(flags, "opencode-hot-reload", defaults?.enabled ?? true, env?.enabled);
  const debounceRaw = readNumber(
    flags,
    "opencode-hot-reload-debounce-ms",
    defaults?.debounceMs ?? DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
    env?.debounceMs,
  );
  const cooldownRaw = readNumber(
    flags,
    "opencode-hot-reload-cooldown-ms",
    defaults?.cooldownMs ?? DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    env?.cooldownMs,
  );
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw) && debounceRaw >= 50
      ? Math.floor(debounceRaw)
      : DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS;
  const cooldownMs =
    typeof cooldownRaw === "number" && Number.isFinite(cooldownRaw) && cooldownRaw >= 100
      ? Math.floor(cooldownRaw)
      : DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS;
  return {
    enabled,
    debounceMs,
    cooldownMs,
  };
}

function readBinarySource(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: BinarySourcePreference,
  envKey?: string,
): BinarySourcePreference {
  const raw = readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "auto" || normalized === "bundled" || normalized === "downloaded" || normalized === "external") {
    return normalized as BinarySourcePreference;
  }
  throw new Error(`Invalid ${key} value: ${raw}. Use auto|bundled|downloaded|external.`);
}

function readLogFormat(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: LogFormat,
  envKey?: string,
): LogFormat {
  const raw = readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "json") return "json";
  if (normalized === "pretty" || normalized === "text" || normalized === "human") return "pretty";
  throw new Error(`Invalid ${key} value: ${raw}. Use pretty|json.`);
}

function expandTildePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

async function isDir(input: string): Promise<boolean> {
  try {
    return (await stat(input)).isDirectory();
  } catch {
    return false;
  }
}

async function realpathOrNull(input: string): Promise<string | null> {
  try {
    return await realpath(input);
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveCliVersion(): Promise<string> {
  if (
    typeof __VESLO_ORCHESTRATOR_VERSION__ === "string" &&
    __VESLO_ORCHESTRATOR_VERSION__.trim()
  ) {
    return __VESLO_ORCHESTRATOR_VERSION__.trim();
  }
  const candidates = [
    join(dirname(process.execPath), "..", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        // ignore
      }
    }
  }

  return FALLBACK_VERSION;
}

async function readPackageField(field: string): Promise<string | undefined> {
  const candidates = [
    join(dirname(process.execPath), "..", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const value = parsed[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      } catch {
        // ignore
      }
    }
  }

  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkspace(workspace: string): Promise<string> {
  const resolved = resolve(workspace);
  await mkdir(resolved, { recursive: true });

  const configPathJsonc = join(resolved, "opencode.jsonc");
  const configPathJson = join(resolved, "opencode.json");
  const hasJsonc = await fileExists(configPathJsonc);
  const hasJson = await fileExists(configPathJson);

  if (!hasJsonc && !hasJson) {
    const payload = JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2);
    await writeFile(configPathJsonc, `${payload}\n`, "utf8");
  }

  return resolved;
}

async function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", (err) => reject(err));
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function resolvePort(preferred: number | undefined, host: string, fallback?: number): Promise<number> {
  if (preferred && (await canBind(host, preferred))) {
    return preferred;
  }
  if (fallback && fallback !== preferred && (await canBind(host, fallback))) {
    return fallback;
  }
  return findFreePort(host);
}

function isCompiledBunBinary(): boolean {
  try {
    const entryPath = fileURLToPath(import.meta.url);
    return entryPath.startsWith("/$bunfs/");
  } catch {
    return false;
  }
}

function resolveLanIp(): string | null {
  const interfaces = networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    const entries = interfaces[key];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      return entry.address;
    }
  }
  return null;
}

function resolveConnectUrl(port: number, overrideHost?: string): { connectUrl?: string; lanUrl?: string; mdnsUrl?: string } {
  if (overrideHost) {
    const trimmed = overrideHost.trim();
    if (trimmed) {
      const url = `http://${trimmed}:${port}`;
      return { connectUrl: url, lanUrl: url };
    }
  }

  const host = hostname().trim();
  const mdnsUrl = host ? `http://${host.replace(/\.local$/, "")}.local:${port}` : undefined;
  const lanIp = resolveLanIp();
  const lanUrl = lanIp ? `http://${lanIp}:${port}` : undefined;
  const connectUrl = lanUrl ?? mdnsUrl;
  return { connectUrl, lanUrl, mdnsUrl };
}

function encodeBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function unwrap<T>(result: FieldsResult<T>): T {
  if (result.data !== undefined) {
    return result.data;
  }
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  throw new Error(message || "Unknown error");
}

function prefixStream(
  stream: NodeJS.ReadableStream | null,
  label: string,
  level: "stdout" | "stderr",
  logger: Logger,
  pid?: number,
): void {
  if (!stream) return;
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (logger.output === "stdout" && logger.format === "json" && looksLikeOtelLogLine(line)) {
        process.stdout.write(`${line}\n`);
        continue;
      }
      const severity: LogLevel = level === "stderr" ? "error" : "info";
      logger.log(severity, line, { stream: level, pid }, label);
    }
  });
  stream.on("end", () => {
    if (!buffer.trim()) return;
    if (logger.output === "stdout" && logger.format === "json" && looksLikeOtelLogLine(buffer)) {
      process.stdout.write(`${buffer}\n`);
      return;
    }
    const severity: LogLevel = level === "stderr" ? "error" : "info";
    logger.log(severity, buffer, { stream: level, pid }, label);
  });
}

function shouldUseBun(bin: string): boolean {
  if (!bin.endsWith(`${join("dist", "cli.js")}`)) return false;
  if (bin.includes("veslo-server")) return true;
  return bin.includes(`${join("packages", "server")}`);
}

function resolveBinCommand(bin: string): { command: string; prefixArgs: string[] } {
  if (bin.endsWith(".ts")) {
    return { command: "bun", prefixArgs: [bin, "--"] };
  }
  if (bin.endsWith(".js")) {
    if (shouldUseBun(bin)) {
      return { command: "bun", prefixArgs: [bin, "--"] };
    }
    return { command: "node", prefixArgs: [bin, "--"] };
  }
  return { command: bin, prefixArgs: [] };
}

async function readVersionManifest(): Promise<VersionManifest | null> {
  return readVersionManifestFromDirs(
    [dirname(process.execPath), dirname(fileURLToPath(import.meta.url))],
    {
      target: process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.TARGET ?? null,
    },
  );
}

const remoteManifestCache = new Map<string, Promise<RemoteSidecarManifest | null>>();

let latestOpencodeVersionTask: Promise<string | undefined> | null = null;

function resolveSidecarTarget(): SidecarTarget | null {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "darwin-arm64";
    if (process.arch === "x64") return "darwin-x64";
    return null;
  }
  if (process.platform === "linux") {
    if (process.arch === "arm64") return "linux-arm64";
    if (process.arch === "x64") return "linux-x64";
    return null;
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "windows-arm64";
    if (process.arch === "x64") return "windows-x64";
    return null;
  }
  return null;
}

function resolveSidecarConfigForTarget(
  flags: Map<string, string | boolean>,
  cliVersion: string,
  targetOverride: SidecarTarget | null,
): SidecarConfig {
  const baseUrl = resolveSidecarBaseUrl(flags, cliVersion);
  return {
    dir: resolveSidecarDir(flags),
    baseUrl,
    manifestUrl: resolveSidecarManifestUrl(flags, baseUrl),
    target: targetOverride,
  };
}

function spawnProcess(command: string, args: string[], options: SpawnOptions = {}) {
  if (process.platform === "win32") {
    return spawn(command, args, { ...options, windowsHide: true });
  }
  return spawn(command, args, options);
}

function shQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveSidecarDir(flags: Map<string, string | boolean>): string {
  const override = readFlag(flags, "sidecar-dir") ?? process.env.VESLO_SIDECAR_DIR;
  if (override && override.trim()) return resolve(override.trim());
  return join(resolveRouterDataDir(flags), "sidecars");
}

function resolveSidecarBaseUrl(flags: Map<string, string | boolean>, cliVersion: string): string {
  const override = readFlag(flags, "sidecar-base-url") ?? process.env.VESLO_SIDECAR_BASE_URL;
  if (override && override.trim()) return override.trim();
  return `https://github.com/neatech/veslo/releases/download/veslo-orchestrator-v${cliVersion}`;
}

function resolveSidecarManifestUrl(flags: Map<string, string | boolean>, baseUrl: string): string {
  const override = readFlag(flags, "sidecar-manifest") ?? process.env.VESLO_SIDECAR_MANIFEST_URL;
  if (override && override.trim()) return override.trim();
  return `${baseUrl.replace(/\/$/, "")}/veslo-orchestrator-sidecars.json`;
}

function resolveSidecarConfig(flags: Map<string, string | boolean>, cliVersion: string): SidecarConfig {
  const baseUrl = resolveSidecarBaseUrl(flags, cliVersion);
  return {
    dir: resolveSidecarDir(flags),
    baseUrl,
    manifestUrl: resolveSidecarManifestUrl(flags, baseUrl),
    target: resolveSidecarTarget(),
  };
}

async function fetchRemoteManifest(url: string): Promise<RemoteSidecarManifest | null> {
  const cached = remoteManifestCache.get(url);
  if (cached) return cached;
  const task = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return (await response.json()) as RemoteSidecarManifest;
    } catch {
      return null;
    }
  })();
  remoteManifestCache.set(url, task);
  return task;
}

async function resolveLatestOpencodeVersion(): Promise<string | undefined> {
  if (latestOpencodeVersionTask) return latestOpencodeVersionTask;
  latestOpencodeVersionTask = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("https://api.github.com/repos/anomalyco/opencode/releases/latest", {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { tag_name?: unknown };
      const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
      if (!tag) return undefined;
      const normalized = tag.startsWith("v") ? tag.slice(1) : tag;
      return normalized || undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  })();
  return latestOpencodeVersionTask;
}

function resolveAssetUrl(baseUrl: string, asset?: string, url?: string): string | null {
  if (url && url.trim()) return url.trim();
  if (asset && asset.trim()) return `${baseUrl.replace(/\/$/, "")}/${asset.trim()}`;
  return null;
}

function resolveAssetName(asset?: string, url?: string): string | null {
  if (asset && asset.trim()) return asset.trim();
  if (url && url.trim()) {
    try {
      return basename(new URL(url).pathname);
    } catch {
      const parts = url.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : null;
    }
  }
  return null;
}

async function downloadToPath(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url} (HTTP ${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  const tmpPath = `${dest}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, buffer);
  await rename(tmpPath, dest);
}

async function ensureExecutable(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o755);
  } catch {
    // ignore
  }
}

async function downloadSidecarBinary(options: {
  name: SidecarName;
  sidecar: SidecarConfig;
}): Promise<ResolvedBinary | null> {
  if (!options.sidecar.target) return null;
  const manifest = await fetchRemoteManifest(options.sidecar.manifestUrl);
  if (!manifest) return null;
  const entry = manifest.entries[options.name];
  if (!entry) return null;
  const targetInfo = entry.targets[options.sidecar.target];
  if (!targetInfo) return null;

  const assetName = resolveAssetName(targetInfo.asset, targetInfo.url);
  const assetUrl = resolveAssetUrl(options.sidecar.baseUrl, targetInfo.asset, targetInfo.url);
  if (!assetName || !assetUrl) return null;

  const targetDir = join(options.sidecar.dir, entry.version, options.sidecar.target);
  const targetPath = join(targetDir, assetName);
  if (await fileExists(targetPath)) {
    if (targetInfo.sha256) {
      try {
        await verifyBinary(targetPath, { version: entry.version, sha256: targetInfo.sha256 });
        await ensureExecutable(targetPath);
        return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
      } catch {
        await rm(targetPath, { force: true });
      }
    } else {
      await ensureExecutable(targetPath);
      return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
    }
  }

  await downloadToPath(assetUrl, targetPath);
  if (targetInfo.sha256) {
    await verifyBinary(targetPath, { version: entry.version, sha256: targetInfo.sha256 });
  }
  await ensureExecutable(targetPath);
  return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
}

function resolveOpencodeAsset(target: SidecarTarget): string | null {
  const assets: Record<SidecarTarget, string> = {
    "darwin-arm64": "opencode-darwin-arm64.zip",
    "darwin-x64": "opencode-darwin-x64-baseline.zip",
    "linux-x64": "opencode-linux-x64-baseline.tar.gz",
    "linux-arm64": "opencode-linux-arm64.tar.gz",
    "windows-x64": "opencode-windows-x64-baseline.zip",
    "windows-arm64": "opencode-windows-arm64.zip",
  };
  return assets[target] ?? null;
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  const child = spawnProcess(command, args, { cwd, stdio: "inherit" });
  const result = await Promise.race([
    once(child, "exit").then(([code]) => ({ type: "exit" as const, code })),
    once(child, "error").then(([error]) => ({ type: "error" as const, error })),
  ]);
  if (result.type === "error") {
    throw new Error(`Command failed: ${command} ${args.join(" ")}: ${String(result.error)}`);
  }
  if (result.code !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function resolveOpencodeDownload(sidecar: SidecarConfig, expectedVersion?: string): Promise<string | null> {
  if (!expectedVersion) return null;
  if (!sidecar.target) return null;

  const assetOverride = process.env.VESLO_OPENCODE_ASSET ?? process.env.OPENCODE_ASSET;
  const asset = assetOverride?.trim() || resolveOpencodeAsset(sidecar.target);
  if (!asset) return null;

  const version = expectedVersion.startsWith("v") ? expectedVersion.slice(1) : expectedVersion;
  const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/${asset}`;
  const targetDir = join(sidecar.dir, "opencode", version, sidecar.target);
  const targetPath = join(targetDir, process.platform === "win32" ? "opencode.exe" : "opencode");

  const hostTarget = resolveSidecarTarget();
  const runnableOnHost = hostTarget !== null && sidecar.target === hostTarget;

  if (await fileExists(targetPath)) {
    if (!runnableOnHost) {
      await ensureExecutable(targetPath);
      return targetPath;
    }
    const actual = await readCliVersion(targetPath);
    if (actual === version) {
      await ensureExecutable(targetPath);
      return targetPath;
    }
  }

  await mkdir(targetDir, { recursive: true });
  const stamp = Date.now();
  const archivePath = join(tmpdir(), `veslo-orchestrator-opencode-${stamp}-${asset}`);
  const extractDir = await mkdtemp(join(tmpdir(), "veslo-orchestrator-opencode-"));

  try {
    await downloadToPath(url, archivePath);
    if (process.platform === "win32") {
      const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const psScript = [
        "$ErrorActionPreference = 'Stop'",
        `Expand-Archive -Path ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`,
      ].join("; ");
      await runCommand("powershell", ["-NoProfile", "-Command", psScript]);
    } else if (asset.endsWith(".zip")) {
      await runCommand("unzip", ["-q", archivePath, "-d", extractDir]);
    } else if (asset.endsWith(".tar.gz")) {
      await runCommand("tar", ["-xzf", archivePath, "-C", extractDir]);
    } else {
      throw new Error(`Unsupported opencode asset type: ${asset}`);
    }

    const entries = await readdir(extractDir, { withFileTypes: true });
    const queue = entries.map((entry) => join(extractDir, entry.name));
    let candidate: string | null = null;
    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      const statInfo = await stat(current);
      if (statInfo.isDirectory()) {
        const nested = await readdir(current, { withFileTypes: true });
        queue.push(...nested.map((entry) => join(current, entry.name)));
        continue;
      }
      const base = basename(current);
      if (base === "opencode" || base === "opencode.exe") {
        candidate = current;
        break;
      }
    }

    if (!candidate) {
      throw new Error("OpenCode binary not found after extraction.");
    }

    await copyFile(candidate, targetPath);
    await ensureExecutable(targetPath);
    return targetPath;
  } finally {
    await rm(extractDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function verifyBinary(path: string, expected?: VersionInfo): Promise<void> {
  if (!expected) return;
  const hash = await sha256File(path);
  if (hash !== expected.sha256) {
    throw new Error(`Integrity check failed for ${path}`);
  }
}

async function resolveBundledBinary(manifest: VersionManifest | null, name: string): Promise<string | null> {
  if (!manifest) return null;
  const candidates = [join(manifest.dir, name)];
  if (process.platform === "win32") {
    candidates.push(join(manifest.dir, `${name}.exe`));
  }
  for (const bundled of candidates) {
    if (!(await isExecutable(bundled))) continue;
    // Desktop bundles may be code-signed after we generate versions.json, which
    // mutates the on-disk bytes and makes a precomputed sha256 unstable.
    // Linux bundles remain byte-stable, so keep integrity verification there.
    if (process.platform === "linux") {
      await verifyBinary(bundled, manifest.entries[name]);
    }
    return bundled;
  }
  return null;
}

async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const payload = await readFile(path, "utf8");
    const parsed = JSON.parse(payload) as { version?: string };
    if (typeof parsed.version === "string") return parsed.version;
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveOpenCodeRouterRepoDir(): Promise<string | null> {
  const envPath = process.env.OPENCODE_ROUTER_DIR?.trim();
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const repoRoot = resolve(root, "..", "..");
  const candidates = [envPath, resolve(repoRoot, "packages", "opencode-router")].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const pkgPath = join(candidate, "package.json");
    if (await fileExists(pkgPath)) return candidate;
  }

  return null;
}

async function resolveExpectedVersion(
  manifest: VersionManifest | null,
  name: SidecarName,
): Promise<string | undefined> {
  const manifestVersion = manifest?.entries[name]?.version;
  if (manifestVersion) return manifestVersion;

  try {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    if (name === "veslo-server") {
      const localPath = join(root, "..", "server", "package.json");
      const localVersion = await readPackageVersion(localPath);
      if (localVersion) return localVersion;
    }
    if (name === "veslo-code-router") {
      const repoDir = await resolveOpenCodeRouterRepoDir();
      const localPath = repoDir ? join(repoDir, "package.json") : join(root, "..", "opencode-router", "package.json");
      const localVersion = await readPackageVersion(localPath);
      if (localVersion) return localVersion;
    }
    if (name === "veslo-code") {
      const envVersion = process.env.OPENCODE_VERSION?.trim();
      if (envVersion && envVersion.toLowerCase() !== "latest") {
        return envVersion.startsWith("v") ? envVersion.slice(1) : envVersion;
      }
      const pkgVersion = await readPackageField("opencodeVersion");
      if (pkgVersion && pkgVersion.toLowerCase() !== "latest") {
        return pkgVersion.startsWith("v") ? pkgVersion.slice(1) : pkgVersion;
      }
      const latest = await resolveLatestOpencodeVersion();
      if (latest) return latest;
    }
  } catch {
    // ignore
  }

  const require = createRequire(import.meta.url);
  if (name === "veslo-server") {
    try {
      const pkgPath = require.resolve("veslo-server/package.json");
      const version = await readPackageVersion(pkgPath);
      if (version) return version;
    } catch {
      // ignore
    }
  }
  if (name === "veslo-code-router") {
    try {
      const pkgPath = require.resolve("veslo-code-router/package.json");
      const version = await readPackageVersion(pkgPath);
      if (version) return version;
    } catch {
      // ignore
    }
  }

  return undefined;
}

function parseVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/);
  return match?.[0];
}

async function readCliVersion(bin: string, timeoutMs = 4000): Promise<string | undefined> {
  const resolved = resolveBinCommand(bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, "--version"], {
    // Avoid picking up a local bunfig.toml preload from the caller's cwd.
    // (Notably, packages/orchestrator/bunfig.toml preloads @opentui/solid/preload which
    // breaks running bun-compiled binaries like opencodeRouter during version checks.)
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const result = await Promise.race([
    once(child, "close").then(() => "close"),
    once(child, "error").then(() => "error"),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, "timeout")),
  ]);

  if (result === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    return undefined;
  }

  if (result === "error") {
    return undefined;
  }

  return parseVersion(output.trim());
}

async function captureCommandOutput(
  bin: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const resolved = resolveBinCommand(bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
    env: options?.env ?? process.env,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  type CaptureResult =
    | "timeout"
    | "error"
    | {
        type: "close";
        code: number | null;
        signal: NodeJS.Signals | null;
      };

  const timeoutMs = options?.timeoutMs ?? 30_000;
  const result = await Promise.race<CaptureResult>([
    once(child, "close").then(([code, signal]) => ({
      type: "close" as const,
      code: (code ?? null) as number | null,
      signal: (signal ?? null) as NodeJS.Signals | null,
    })),
    once(child, "error").then(() => "error" as const),
    new Promise<CaptureResult>((resolve) => setTimeout(resolve, timeoutMs, "timeout")),
  ]);

  if (result === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error("Command timed out");
  }

  if (result === "error") {
    throw new Error("Command failed to run");
  }

  const code = result.code;
  if (code !== 0) {
    const suffix = output.trim() ? `\n${output.trim()}` : "";
    throw new Error(`Command failed: ${bin} ${args.join(" ")}${suffix}`);
  }

  return output.trim();
}

function assertVersionMatch(
  name: string,
  expected: string | undefined,
  actual: string | undefined,
  context: string,
): void {
  if (!expected) return;
  if (!actual) {
    throw new Error(`Unable to determine ${name} version from ${context}. Expected ${expected}.`);
  }
  if (expected !== actual) {
    throw new Error(`${name} version mismatch: expected ${expected}, got ${actual}.`);
  }
}

function resolveBinPath(bin: string): string {
  if (bin.includes("/") || bin.startsWith(".")) {
    return resolve(process.cwd(), bin);
  }
  return bin;
}

function isPathLikeBinary(bin: string): boolean {
  return bin.includes("/") || bin.startsWith(".");
}

async function resolveVesloServerBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("veslo-server-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("veslo-server-bin requires --sidecar-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(options.manifest, "veslo-server");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External veslo-server requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`veslo-server-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }

    const require = createRequire(import.meta.url);
    try {
      const pkgPath = require.resolve("veslo-server/package.json");
      const pkgDir = dirname(pkgPath);
      const binaryPath = join(pkgDir, "dist", "bin", "veslo-server");
      if (await isExecutable(binaryPath)) {
        return { bin: binaryPath, source: "external", expectedVersion };
      }
      const cliPath = join(pkgDir, "dist", "cli.js");
      if (await isExecutable(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    } catch {
      // ignore
    }

    return { bin: "veslo-server", source: "external", expectedVersion };
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "veslo-server");
    if (!bundled) {
      throw new Error(
        "Bundled veslo-server binary missing. Build with pnpm --filter veslo-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "veslo-server", sidecar: options.sidecar });
    if (!downloaded) {
      throw new Error("veslo-server download failed. Check sidecar manifest or base URL.");
    }
    return downloaded;
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "veslo-server");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "veslo-server", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  if (!options.allowExternal) {
    throw new Error(
      "Bundled veslo-server binary missing and download failed. Use --allow-external or --sidecar-source external.",
    );
  }

  return resolveExternal();
}

async function resolveOpencodeBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("opencode-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("opencode-bin requires --opencode-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(options.manifest, "veslo-code");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External opencode requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`opencode-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }
    return { bin: "opencode", source: "external", expectedVersion };
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "veslo-code");
    if (!bundled) {
      throw new Error(
        "Bundled opencode binary missing. Build with pnpm --filter veslo-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "veslo-code", sidecar: options.sidecar });
    if (downloaded) return downloaded;
    const opencodeDownloaded = await resolveOpencodeDownload(options.sidecar, expectedVersion);
    if (opencodeDownloaded) {
      return { bin: opencodeDownloaded, source: "downloaded", expectedVersion };
    }
    throw new Error(
      "opencode download failed. Check sidecar manifest/network access, or set OPENCODE_VERSION to pin a version.",
    );
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "veslo-code");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "veslo-code", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  const opencodeDownloaded = await resolveOpencodeDownload(options.sidecar, expectedVersion);
  if (opencodeDownloaded) {
    return { bin: opencodeDownloaded, source: "downloaded", expectedVersion };
  }

  if (!options.allowExternal) {
    throw new Error(
      "Bundled opencode binary missing and download failed. Use --allow-external or --opencode-source external.",
    );
  }

  return resolveExternal();
}

async function resolveOpenCodeRouterBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("veslo-code-router-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("veslo-code-router-bin requires --sidecar-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(options.manifest, "veslo-code-router");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External opencodeRouter requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`veslo-code-router-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }

    const repoDir = await resolveOpenCodeRouterRepoDir();
    if (repoDir) {
      const binPath = join(repoDir, "dist", "bin", "veslo-code-router");
      if (await isExecutable(binPath)) {
        return { bin: binPath, source: "external", expectedVersion };
      }
      const cliPath = join(repoDir, "dist", "cli.js");
      if (await fileExists(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    }

    const require = createRequire(import.meta.url);
    try {
      const pkgPath = require.resolve("veslo-code-router/package.json");
      const pkgDir = dirname(pkgPath);
      const binaryPath = join(pkgDir, "dist", "bin", "veslo-code-router");
      if (await isExecutable(binaryPath)) {
        return { bin: binaryPath, source: "external", expectedVersion };
      }
      const cliPath = join(pkgDir, "dist", "cli.js");
      if (await isExecutable(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    } catch {
      // ignore
    }

    throw new Error(
      "veslo-code-router binary not found. Install the veslo-code-router dependency or pass --veslo-code-router-bin with --allow-external.",
    );
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "veslo-code-router");
    if (!bundled) {
      throw new Error(
        "Bundled opencodeRouter binary missing. Build with pnpm --filter veslo-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "veslo-code-router", sidecar: options.sidecar });
    if (!downloaded) {
      throw new Error("opencodeRouter download failed. Check sidecar manifest or base URL.");
    }
    return downloaded;
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "veslo-code-router");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "veslo-code-router", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  if (!options.allowExternal) {
    throw new Error(
      "Bundled opencodeRouter binary missing and download failed. Use --allow-external or --sidecar-source external.",
    );
  }

  return resolveExternal();
}

function resolveRouterDataDir(flags: Map<string, string | boolean>): string {
  const override = readFlag(flags, "data-dir") ?? process.env.VESLO_DATA_DIR;
  if (override && override.trim()) {
    return resolve(override.trim());
  }
  return join(homedir(), ".veslo", "veslo-orchestrator");
}

function routerStatePath(dataDir: string): string {
  return join(dataDir, "veslo-orchestrator-state.json");
}

function nowMs(): number {
  return Date.now();
}

async function loadRouterState(path: string): Promise<RouterState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as RouterState;
    if (!parsed.workspaces) parsed.workspaces = [];
    if (!parsed.activeId) parsed.activeId = "";
    if (!parsed.version) parsed.version = 1;
    if (!parsed.engines) parsed.engines = {};
    return parsed;
  } catch {
    return {
      version: 1,
      daemon: undefined,
      opencode: undefined,
      engines: {},
      cliVersion: undefined,
      sidecar: undefined,
      binaries: undefined,
      activeId: "",
      workspaces: [],
    };
  }
}

async function saveRouterState(path: string, state: RouterState): Promise<void> {
  await atomicWriteJson(path, state);
}

const routerStatePersister = createDebouncedPersister<RouterState>({
  write: saveRouterState,
});

function persistDebounced(path: string, state: RouterState): void {
  routerStatePersister.schedule(path, state);
}

async function flushPersist(): Promise<void> {
  await routerStatePersister.flush();
}

function normalizeWorkspacePath(input: string): string {
  return resolve(input).replace(/[\\/]+$/, "");
}

function workspaceIdForLocal(path: string): string {
  return `ws-${createHash("sha1").update(path).digest("hex").slice(0, 12)}`;
}

function workspaceIdForRemote(baseUrl: string, directory?: string | null): string {
  const key = directory ? `${baseUrl}::${directory}` : baseUrl;
  return `ws-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

function opencodeRouterSendToolSource(): string {
  return [
    'import { tool } from "@opencode-ai/plugin"',
    "",
    "const redactTarget = (value) => {",
    "  const text = String(value || '').trim()",
    "  if (!text) return ''",
    "  if (text.length <= 6) return 'hidden'",
    "  return `${text.slice(0, 2)}…${text.slice(-2)}`",
    "}",
    "",
    "const buildGuidance = (result) => {",
    "  const sent = Number(result?.sent || 0)",
    "  const attempted = Number(result?.attempted || 0)",
    "  const reason = String(result?.reason || '')",
    "  const failures = Array.isArray(result?.failures) ? result.failures : []",
    "",
    "  if (sent > 0 && failures.length === 0) return 'Delivered successfully.'",
    "  if (sent > 0) return 'Delivered to at least one conversation, but some targets failed.'",
    "",
    "  const chatNotFound = failures.some((item) => /chat not found/i.test(String(item?.error || '')))",
    "  if (chatNotFound) {",
    "    return 'Delivery failed because the recipient has not started a chat with the bot yet. Ask them to send /start, then retry.'",
    "  }",
    "",
    "  if (/No bound conversations/i.test(reason)) {",
    "    return 'No linked conversation found for this workspace yet. Ask the recipient to message the bot first, then retry.'",
    "  }",
    "",
    "  if (attempted === 0) return 'No eligible delivery target found.'",
    "  return 'Delivery failed. Retry after confirming the recipient and bot linkage.'",
    "}",
    "",
    "export default tool({",
    '  description: "Send a message via opencodeRouter (Telegram/Slack) to a peer or directory bindings.",',
    "  args: {",
    '    text: tool.schema.string().describe("Message text to send"),',
    '    channel: tool.schema.enum(["telegram", "slack"]).optional().describe("Channel to send on (default: telegram)"),',
    '    identityId: tool.schema.string().optional().describe("OpenCodeRouter identity id (default: all identities)"),',
    '    directory: tool.schema.string().optional().describe("Directory to target for fan-out (default: current session directory)"),',
    '    peerId: tool.schema.string().optional().describe("Direct destination peer id (chat/thread id)"),',
    '    autoBind: tool.schema.boolean().optional().describe("When direct sending, bind peerId to directory if provided"),',
    "  },",
    "  async execute(args, context) {",
    '    const rawPort = (process.env.OPENCODE_ROUTER_HEALTH_PORT || "3005").trim()',
    "    const port = Number(rawPort)",
    "    if (!Number.isFinite(port) || port <= 0) {",
    '      throw new Error(`Invalid OPENCODE_ROUTER_HEALTH_PORT: ${rawPort}`)',
    "    }",
    '    const channel = (args.channel || "telegram").trim()',
    '    if (channel !== "telegram" && channel !== "slack") {',
    '      throw new Error("channel must be telegram or slack")',
    "    }",
    '    const text = String(args.text || "")',
    '    if (!text.trim()) throw new Error("text is required")',
    '    const directory = (args.directory || context.directory || "").trim()',
    '    const peerId = String(args.peerId || "").trim()',
    '    if (!directory && !peerId) throw new Error("Either directory or peerId is required")',
    "    const payload = {",
    "      channel,",
    "      text,",
    "      ...(args.identityId ? { identityId: String(args.identityId) } : {}),",
    "      ...(directory ? { directory } : {}),",
    "      ...(peerId ? { peerId } : {}),",
    "      ...(args.autoBind === true ? { autoBind: true } : {}),",
    "    }",
    "    const response = await fetch(`http://127.0.0.1:${port}/send`, {",
    "      method: \"POST\",",
    '      headers: { "Content-Type": "application/json" },',
    "      body: JSON.stringify(payload),",
    "    })",
    "    const body = await response.text()",
    "    let json = null",
    "    try {",
    "      json = JSON.parse(body)",
    "    } catch {",
    "      json = null",
    "    }",
    "    if (!response.ok) {",
    '      throw new Error(`opencodeRouter /send failed (${response.status}): ${body}`)',
    "    }",
    "",
    "    const sent = Number(json?.sent || 0)",
    "    const attempted = Number(json?.attempted || 0)",
    "    const reason = typeof json?.reason === 'string' ? json.reason : ''",
    "    const failuresRaw = Array.isArray(json?.failures) ? json.failures : []",
    "    const failures = failuresRaw.map((item) => ({",
    "      identityId: String(item?.identityId || ''),",
    "      error: String(item?.error || 'delivery failed'),",
    "      ...(item?.peerId ? { target: redactTarget(item.peerId) } : {}),",
    "    }))",
    "",
    "    const result = {",
    "      ok: true,",
    "      channel,",
    "      sent,",
    "      attempted,",
    "      guidance: buildGuidance({ sent, attempted, reason, failures }),",
    "      ...(reason ? { reason } : {}),",
    "      ...(failures.length ? { failures } : {}),",
    "    }",
    "    return JSON.stringify(result, null, 2)",
    "  },",
    "})",
    "",
  ].join("\n");
}

function opencodeRouterStatusToolSource(): string {
  return [
    'import { tool } from "@opencode-ai/plugin"',
    "",
    "const redactTarget = (value) => {",
    "  const text = String(value || '').trim()",
    "  if (!text) return ''",
    "  if (text.length <= 6) return 'hidden'",
    "  return `${text.slice(0, 2)}…${text.slice(-2)}`",
    "}",
    "",
    "const isNumericTelegramPeerId = (value) => /^-?\\d+$/.test(String(value || '').trim())",
    "",
    "export default tool({",
    '  description: "Check opencodeRouter messaging readiness (health, identities, bindings).",',
    "  args: {",
    '    channel: tool.schema.enum(["telegram", "slack"]).optional().describe("Channel to inspect (default: telegram)"),',
    '    identityId: tool.schema.string().optional().describe("Identity id to scope checks"),',
    '    directory: tool.schema.string().optional().describe("Directory to inspect bindings for (default: current session directory)"),',
    '    peerId: tool.schema.string().optional().describe("Peer id to inspect bindings for"),',
    '    includeBindings: tool.schema.boolean().optional().describe("Include binding details (default: false)"),',
    "  },",
    "  async execute(args, context) {",
    '    const rawPort = (process.env.OPENCODE_ROUTER_HEALTH_PORT || "3005").trim()',
    "    const port = Number(rawPort)",
    "    if (!Number.isFinite(port) || port <= 0) {",
    '      throw new Error(`Invalid OPENCODE_ROUTER_HEALTH_PORT: ${rawPort}`)',
    "    }",
    '    const channel = (args.channel || "telegram").trim()',
    '    if (channel !== "telegram" && channel !== "slack") {',
    '      throw new Error("channel must be telegram or slack")',
    "    }",
    '    const identityId = String(args.identityId || "").trim()',
    '    const directory = (args.directory || context.directory || "").trim()',
    '    const peerId = String(args.peerId || "").trim()',
    "    const targetValid = channel !== 'telegram' || !peerId || isNumericTelegramPeerId(peerId)",
    '    const includeBindings = args.includeBindings === true',
    "",
    "    const fetchJson = async (path) => {",
    "      const response = await fetch(`http://127.0.0.1:${port}${path}`)",
    "      const body = await response.text()",
    "      let json = null",
    "      try {",
    "        json = JSON.parse(body)",
    "      } catch {",
    "        json = null",
    "      }",
    "      if (!response.ok) {",
    "        return { ok: false, status: response.status, json, error: typeof json?.error === \"string\" ? json.error : body }",
    "      }",
    "      return { ok: true, status: response.status, json }",
    "    }",
    "",
    "    const health = await fetchJson('/health')",
    "    const identities = await fetchJson(`/identities/${channel}`)",
    "    let bindings = null",
    "    if (includeBindings) {",
    "      const search = new URLSearchParams()",
    "      search.set('channel', channel)",
    "      if (identityId) search.set('identityId', identityId)",
    "      bindings = await fetchJson(`/bindings?${search.toString()}`)",
    "    }",
    "",
    "    const identityItems = Array.isArray(identities?.json?.items) ? identities.json.items : []",
    "    const scopedIdentityItems = identityId",
    "      ? identityItems.filter((item) => String(item?.id || '').trim() === identityId)",
    "      : identityItems",
    "    const runningItems = scopedIdentityItems.filter((item) => item && item.enabled === true && item.running === true)",
    "    const enabledItems = scopedIdentityItems.filter((item) => item && item.enabled === true)",
    "",
    "    const bindingItems = Array.isArray(bindings?.json?.items) ? bindings.json.items : []",
    "    const filteredBindings = bindingItems.filter((item) => {",
    "      if (!item || typeof item !== 'object') return false",
    "      if (directory && String(item.directory || '').trim() !== directory) return false",
    "      if (peerId && String(item.peerId || '').trim() !== peerId) return false",
    "      return true",
    "    })",
    "    const publicBindings = filteredBindings.map((item) => ({",
    "      channel: String(item.channel || channel),",
    "      identityId: String(item.identityId || ''),",
    "      directory: String(item.directory || ''),",
    "      ...(item?.peerId ? { target: redactTarget(item.peerId) } : {}),",
    "      updatedAt: item?.updatedAt,",
    "    }))",
    "",
    "    let ready = false",
    "    let guidance = ''",
    "    let nextAction = ''",
    "    if (!health.ok) {",
    "      guidance = 'OpenCode Router health endpoint is unavailable'",
    "      nextAction = 'check_router_health'",
    "    } else if (!identities.ok) {",
    "      guidance = `Identity lookup failed for ${channel}`",
    "      nextAction = 'check_identity_config'",
    "    } else if (runningItems.length === 0) {",
    "      guidance = `No running ${channel} identity`",
    "      nextAction = 'start_identity'",
    "    } else if (!targetValid) {",
    "      guidance = 'Telegram direct targets must be numeric chat IDs. Prefer linked conversations over asking users for raw IDs.'",
    "      nextAction = 'use_linked_conversation'",
    "    } else if (peerId) {",
    "      ready = true",
    "      guidance = 'Ready for direct send'",
    "      nextAction = 'send_direct'",
    "    } else if (directory) {",
    "      ready = filteredBindings.length > 0",
    "      guidance = ready",
    "        ? 'Ready for directory fan-out send'",
    "        : channel === 'telegram'",
    "          ? 'No linked Telegram conversations yet. Ask the recipient to message your bot (for example /start), then retry.'",
    "          : 'No linked conversations found for this directory yet'",
    "      nextAction = ready ? 'send_directory' : channel === 'telegram' ? 'wait_for_recipient_start' : 'link_conversation'",
    "    } else {",
    "      ready = true",
    "      guidance = 'Ready. Provide a message target (peer or directory).'",
    "      nextAction = 'choose_target'",
    "    }",
    "",
    "    const result = {",
    "      ok: health.ok && identities.ok && (!bindings || bindings.ok),",
    "      ready,",
    "      guidance,",
    "      nextAction,",
    "      channel,",
    "      ...(identityId ? { identityId } : {}),",
    "      ...(directory ? { directory } : {}),",
    "      ...(peerId ? { targetProvided: true } : {}),",
    "      ...(peerId ? { targetValid } : {}),",
    "      health: {",
    "        ok: health.ok,",
    "        status: health.status,",
    "        error: health.ok ? undefined : health.error,",
    "        snapshot: health.ok ? health.json : undefined,",
    "      },",
    "      identities: {",
    "        ok: identities.ok,",
    "        status: identities.status,",
    "        error: identities.ok ? undefined : identities.error,",
    "        configured: scopedIdentityItems.length,",
    "        enabled: enabledItems.length,",
    "        running: runningItems.length,",
    "        items: scopedIdentityItems,",
    "      },",
    "      ...(includeBindings",
    "        ? {",
    "            bindings: {",
    "              ok: Boolean(bindings?.ok),",
    "              status: bindings?.status,",
    "              error: bindings?.ok ? undefined : bindings?.error,",
    "              count: filteredBindings.length,",
    "              items: publicBindings,",
    "            },",
    "          }",
    "        : {}),",
    "    }",
    "    return JSON.stringify(result, null, 2)",
    "  },",
    "})",
    "",
  ].join("\n");
}

/**
 * Vendors `@opencode-ai/plugin` (plus its `zod` dependency) into
 * `<configDir>/node_modules/` so managed tool files load cleanly inside the
 * sandboxed opencode engine. Opencode runs Bun with `--no-install`, and
 * opencode's `tool({...})` introspects real zod internals (`_zod.def`), so a
 * pure shim isn't enough — we need the actual published packages.
 *
 * Source is the local Bun install cache (`~/.bun/install/cache/<pkg>@<ver>@@@1/`),
 * which is populated by `bun install` during development and shipped alongside
 * orchestrator builds. If the cache is empty (CI, first run), we fall back to
 * a minimal hand-written shim that lets opencode load the tools but won't pass
 * full zod introspection — the warning is logged so callers can investigate.
 */
const VESLO_MANAGED_PLUGIN_VERSION = "1.15.10";
const VESLO_MANAGED_ZOD_VERSION = "4.1.13";

const MANAGED_PLUGIN_FALLBACK_TOOL = `function makeLeaf(typeName) {
  const leaf = { _veslo_schema_type: typeName, _zod: { def: { type: typeName } } };
  leaf.optional = () => leaf;
  leaf.nullable = () => leaf;
  leaf.describe = () => leaf;
  leaf.default = () => leaf;
  leaf.parse = (value) => value;
  leaf.safeParse = (value) => ({ success: true, data: value });
  return leaf;
}
const schema = {
  string: () => makeLeaf("string"),
  number: () => makeLeaf("number"),
  boolean: () => makeLeaf("boolean"),
  any: () => makeLeaf("any"),
  enum: (values) => Object.assign(makeLeaf("enum"), { options: Array.isArray(values) ? values.slice() : [] }),
  literal: (value) => Object.assign(makeLeaf("literal"), { value }),
  object: (shape) => Object.assign(makeLeaf("object"), { shape: shape || {} }),
  array: (item) => Object.assign(makeLeaf("array"), { element: item }),
  record: (value) => Object.assign(makeLeaf("record"), { valueType: value }),
  union: (options) => Object.assign(makeLeaf("union"), { options: Array.isArray(options) ? options.slice() : [] }),
  optional: (inner) => Object.assign(makeLeaf("optional"), { inner }),
  nullable: (inner) => Object.assign(makeLeaf("nullable"), { inner }),
};
export function tool(input) {
  return input;
}
tool.schema = schema;
`;

const MANAGED_PLUGIN_FALLBACK_INDEX = `export * from "./tool.js";\n`;

const MANAGED_PLUGIN_FALLBACK_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "@opencode-ai/plugin",
    version: "0.0.0-veslo-managed",
    type: "module",
    exports: {
      ".": { import: "./dist/index.js" },
      "./tool": { import: "./dist/tool.js" },
    },
    files: ["dist"],
  },
  null,
  2,
)}\n`;

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  // Prefer fs/promises.cp, but fall back to shell `cp -R` when running inside a
  // Bun-compiled standalone binary, where cp() can silently no-op on macOS.
  try {
    await cp(src, dst, { recursive: true, force: true });
    // Sanity check: cp succeeded but copied nothing? Fall through to shell cp.
    const entries = await readdir(src).catch(() => [] as string[]);
    if (entries.length > 0) {
      const dstEntries = await readdir(dst).catch(() => [] as string[]);
      if (dstEntries.length > 0) return;
    } else {
      return;
    }
  } catch (err) {
    // fall through to shell cp
    void err;
  }
  const result = spawnProcess("cp", ["-R", `${src}/.`, dst], { stdio: "ignore" });
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

function resolveBunCacheEntry(pkg: string, version: string): string {
  return join(
    process.env.HOME ?? "",
    ".bun",
    "install",
    "cache",
    pkg,
    `${version}@@@1`,
  );
}

async function vendorBunCachePackage(
  pkg: string,
  version: string,
  destNodeModules: string,
): Promise<boolean> {
  const cacheRoot = resolveBunCacheEntry(pkg, version);
  if (!(await pathExists(cacheRoot))) return false;
  const destDir = join(destNodeModules, pkg);
  await mkdir(destDir, { recursive: true });
  await copyDirRecursive(cacheRoot, destDir);
  return true;
}

async function writeManagedPluginFallback(pluginDir: string): Promise<void> {
  const distDir = join(pluginDir, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(pluginDir, "package.json"), MANAGED_PLUGIN_FALLBACK_PACKAGE_JSON, "utf8");
  await writeFile(join(distDir, "index.js"), MANAGED_PLUGIN_FALLBACK_INDEX, "utf8");
  await writeFile(join(distDir, "tool.js"), MANAGED_PLUGIN_FALLBACK_TOOL, "utf8");
}

async function ensureOpencodeManagedTools(configDir: string): Promise<void> {
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

  // Vendor @opencode-ai/plugin (preferred: from Bun cache; fallback: hand-rolled shim).
  const pluginDir = join(nodeModulesDir, "@opencode-ai", "plugin");
  if (!(await pathExists(join(pluginDir, "package.json")))) {
    await mkdir(join(nodeModulesDir, "@opencode-ai"), { recursive: true });
    const ok = await vendorBunCachePackage(
      "@opencode-ai/plugin",
      VESLO_MANAGED_PLUGIN_VERSION,
      nodeModulesDir,
    );
    if (!ok) {
      console.warn(
        `[veslo-orchestrator] Bun cache miss for @opencode-ai/plugin@${VESLO_MANAGED_PLUGIN_VERSION}; using hand-rolled shim (tools may not pass full zod introspection).`,
      );
      await writeManagedPluginFallback(pluginDir);
    }
  }

  // Vendor zod (only used when the real plugin from cache is in place; cheap to
  // skip the copy if the destination already exists).
  const zodDir = join(nodeModulesDir, "zod");
  if (!(await pathExists(join(zodDir, "package.json")))) {
    const ok = await vendorBunCachePackage("zod", VESLO_MANAGED_ZOD_VERSION, nodeModulesDir);
    if (!ok) {
      console.warn(
        `[veslo-orchestrator] Bun cache miss for zod@${VESLO_MANAGED_ZOD_VERSION}; the @opencode-ai/plugin shim will be used instead.`,
      );
    }
  }

  await writeManagedTool("opencode_router_send.ts", opencodeRouterSendToolSource());
  await writeManagedTool("opencode_router_status.ts", opencodeRouterStatusToolSource());
}

function findWorkspace(state: RouterState, input: string): RouterWorkspace | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const direct = state.workspaces.find((entry) => entry.id === trimmed || entry.name === trimmed);
  if (direct) return direct;
  const normalized = normalizeWorkspacePath(trimmed);
  return state.workspaces.find((entry) => entry.path && normalizeWorkspacePath(entry.path) === normalized);
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveSelfCommand(): { command: string; prefixArgs: string[] } {
  const arg1 = process.argv[1];
  if (!arg1) return { command: process.argv[0], prefixArgs: [] };
  if (arg1.endsWith(".js") || arg1.endsWith(".ts")) {
    return { command: process.argv[0], prefixArgs: [arg1] };
  }
  return { command: process.argv[0], prefixArgs: [] };
}

async function waitForHealthy(url: string, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for health check");
}

async function fetchOpenCodeRouterHealth(baseUrl: string): Promise<OpenCodeRouterHealthSnapshot> {
  return (await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`)) as OpenCodeRouterHealthSnapshot;
}

async function fetchOpenCodeRouterHealthViaVeslo(vesloUrl: string, token: string): Promise<OpenCodeRouterHealthSnapshot> {
  const url = `${vesloUrl.replace(/\/$/, "")}/veslo-code-router/health`;
  return (await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })) as OpenCodeRouterHealthSnapshot;
}

async function waitForOpenCodeRouterHealthy(baseUrl: string, timeoutMs = 10_000, pollMs = 500) {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
      if (response.ok) {
        return (await response.json()) as OpenCodeRouterHealthSnapshot;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for opencodeRouter health");
}

async function waitForOpencodeHealthy(client: ReturnType<typeof createOpencodeClient>, timeoutMs = 10_000, pollMs = 250) {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const health = unwrap(await client.global.health());
      if (health?.healthy) return health;
      lastError = "Server reported unhealthy";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for OpenCode health");
}

/**
 * In sandbox mode the released veslo-server binary may not have our latest
 * token/proxy changes.  Instead of relying on the OpenCode SDK client (which
 * sends Bearer auth that the proxy may not understand yet), we do a simple
 * HTTP fetch through the proxy path.  The server's /opencode/* proxy already
 * forwards to the internal opencode port; we just need to check that it
 * returns a 2xx from /opencode/health (or falls through to opencode's own
 * /health endpoint).
 *
 * We try multiple path patterns because:
 * - `/opencode/health` — most common OpenCode health endpoint proxied by the
 *   server's catch-all /opencode/* route.
 * - `/health` on the veslo-server itself — already verified by the caller,
 *   but serves as a fallback signal.
 */
async function waitForHealthyViaProxy(
  proxyBaseUrl: string,
  token: string,
  timeoutMs = 10_000,
  pollMs = 250,
): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  while (Date.now() - start < timeoutMs) {
    try {
      // Try the proxied opencode health endpoint.
      const res = await fetch(`${proxyBaseUrl}/health`, { headers, signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      // Some older server versions may return 401/403 on the proxy but that
      // still proves the server is up and proxying.  Accept any non-5xx as
      // "alive" — the real auth validation happens in verifyVesloServer.
      if (res.status < 500) return;
      lastError = `Proxy returned ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for OpenCode health via proxy");
}

function printHelp(): void {
  const message = [
    "veslo",
    "",
    "Usage:",
    "  veslo start [--workspace <path>] [options]",
    "  veslo serve [--workspace <path>] [options]",
    "  veslo daemon [run|start|stop|status] [options]",
    "  veslo workspace <action> [options]",
    "  veslo instance dispose <id> [options]",
    "  veslo approvals list --veslo-url <url> --host-token <token>",
    "  veslo approvals reply <id> --allow|--deny --veslo-url <url> --host-token <token>",
    "  veslo files <action> [options]",
    "  veslo status [--veslo-url <url>] [--opencode-url <url>]",
    "",
    "Commands:",
    "  start                   Start OpenCode + Veslo server + OpenCodeRouter",
    "  serve                   Start services and stream logs (no TUI)",
    "  daemon                  Run orchestrator router daemon (multi-workspace)",
    "  workspace               Manage workspaces (add/list/switch/path)",
    "  instance                Manage workspace instances (dispose)",
    "  approvals list           List pending approval requests",
    "  approvals reply <id>     Approve or deny a request",
    "  files                   Manage file sessions and batch file sync",
    "  status                  Check OpenCode/Veslo health",
    "",
    "Options:",
    "  --workspace <path>        Workspace directory (default: cwd)",
    "  --data-dir <path>         Data dir for orchestrator router state",
    "  --daemon-host <host>      Host for orchestrator router daemon (default: 127.0.0.1)",
    "  --daemon-port <port>      Port for orchestrator router daemon (default: random)",
    "  --opencode-bin <path>     Path to opencode binary (requires --allow-external)",
    "  --opencode-host <host>    Bind host for opencode serve (default: 0.0.0.0)",
    "  --opencode-port <port>    Port for opencode serve (default: random)",
    "  --opencode-workdir <p>    Workdir for router-managed opencode serve",
    "  --opencode-auth           Enable OpenCode basic auth (default: true)",
    "  --no-opencode-auth        Disable OpenCode basic auth",
    "  --opencode-hot-reload     Enable OpenCode hot reload (default: true)",
    "  --opencode-hot-reload-debounce-ms <ms>  Debounce window for hot reload triggers (default: 700)",
    "  --opencode-hot-reload-cooldown-ms <ms>  Minimum interval between hot reloads (default: 1500)",
    "  --max-engines <N>         Max concurrent engines in pool (1-64, default: 8) [VSLO-171]",
    "  --idle-suspend-ms <ms>    Idle threshold for engine suspend (default: 900000 = 15 min)",
    "  --opencode-username <u>   OpenCode basic auth username",
    "  --opencode-password <p>   OpenCode basic auth password",
    "  --veslo-host <host>    Bind host for veslo-server (default: 0.0.0.0)",
    "  --veslo-port <port>    Port for veslo-server (default: 8787)",
    "  --veslo-token <token>  Client token for veslo-server",
    "  --veslo-host-token <t> Host token for approvals",
    "  --workspace-id <id>       Workspace id for file session commands",
    "  --session-id <id>         File session id for file session commands",
    "  --path <path>             Workspace-relative file path",
    "  --paths <list>            Comma-separated list of workspace-relative file paths",
    "  --ttl-seconds <n>         File session TTL in seconds",
    "  --content <text>          Inline content for file writes",
    "  --content-base64 <b64>    Base64 content for file writes",
    "  --file <path>             Local file path for file writes",
    "  --if-match <revision>     Revision precondition for file writes",
    "  --from <path>             Source path for rename",
    "  --to <path>               Destination path for rename",
    "  --write                   Request writable file session",
    "  --force                   Force write despite revision mismatch",
    "  --recursive               Recursive delete for files delete",
    "  --approval <mode>         manual | auto (default: manual)",
    "  --approval-timeout <ms>   Approval timeout in ms",
    "  --read-only               Start Veslo server in read-only mode",
    "  --cors <origins>          Comma-separated CORS origins or *",
    "  --connect-host <host>     Override LAN host used for pairing URLs",
    "  --veslo-server-bin <p> Path to veslo-server binary (requires --allow-external)",
    "  --veslo-code-router-bin <path>     Path to opencodeRouter binary (requires --allow-external)",
    "  --veslo-code-router-health-port <p> Health server port for opencodeRouter (default: random)",
    "  --no-veslo-code-router             Disable opencodeRouter sidecar",
    "  --veslo-code-router-required       Exit if opencodeRouter stops",
    "  --allow-external          Allow external sidecar binaries (dev only, required for custom bins)",
    "  --sidecar-dir <path>      Cache directory for downloaded sidecars",
    "  --sidecar-base-url <url>  Base URL for sidecar downloads",
    "  --sidecar-manifest <url>  Override sidecar manifest URL",
    "  --sidecar-source <mode>   auto | bundled | downloaded | external",
    "  --opencode-source <mode>  auto | bundled | downloaded | external",
    "  --check                   Run health checks then exit",
    "  --check-events            Verify SSE events during check",
    "  --tui                     Force interactive dashboard (TTY only)",
    "  --no-tui                  Disable interactive dashboard",
    "  --detach                  Detach after start and keep services running",
    "  --json                    Output JSON when applicable",
    "  --verbose                 Print additional diagnostics",
    "  --log-format <format>     Log output format: pretty | json",
    "  --color                   Force ANSI color output",
    "  --no-color                Disable ANSI color output",
    "  --run-id <id>             Correlation id for logs (default: random UUID)",
    "  --help                    Show help",
    "  --version                 Show version",
  ].join("\n");
  console.log(message);
}

async function stopChild(child: ReturnType<typeof spawn>, timeoutMs = 2500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
  if (exited) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

/**
 * F4Ú4 — shell-quote a single argument (bash-safe single-quoting).
 * Used to compose a shell command string for sandbox wrapping.
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

async function startOpencode(options: {
  bin: string;
  workspace: string;
  configDir?: string;
  hotReload: OpencodeHotReload;
  bindHost: string;
  port: number;
  username?: string;
  password?: string;
  corsOrigins: string[];
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
  opencodeRouterHealthPort?: number;
  /** F4Ú4 — wrap engine spawn in OS-level sandbox. When omitted, sandbox is
   *  resolved automatically per platform unless `VESLO_DISABLE_SANDBOX=1`. */
  sandbox?: WorkerSandbox | null;
}) {
  const args = ["serve", "--hostname", options.bindHost, "--port", String(options.port)];
  for (const origin of options.corsOrigins) {
    args.push("--cors", origin);
  }

  const env = {
    ...process.env,
    OPENCODE_CLIENT: "veslo-orchestrator",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    VESLO: "1",
    VESLO_RUN_ID: options.runId,
    VESLO_LOG_FORMAT: options.logFormat,
    OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
      {
        "service.name": "opencode",
        "service.instance.id": options.runId,
      },
      process.env.OTEL_RESOURCE_ATTRIBUTES,
    ),
    ...(options.username ? { OPENCODE_SERVER_USERNAME: options.username } : {}),
    ...(options.password ? { OPENCODE_SERVER_PASSWORD: options.password } : {}),
    ...(options.configDir ? { OPENCODE_CONFIG_DIR: options.configDir } : {}),
    OPENCODE_HOT_RELOAD: options.hotReload.enabled ? "1" : "0",
    OPENCODE_HOT_RELOAD_DEBOUNCE_MS: String(options.hotReload.debounceMs),
    OPENCODE_HOT_RELOAD_COOLDOWN_MS: String(options.hotReload.cooldownMs),
    ...(options.opencodeRouterHealthPort
      ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) }
      : {}),
  };

  // F4Ú4 — resolve sandbox: explicit `null` disables; explicit object wraps;
  // omitted -> platform default unless VESLO_DISABLE_SANDBOX=1 (escape hatch
  // for headless tests, never for prod).
  let sandbox: WorkerSandbox | null;
  if (options.sandbox === null) {
    sandbox = null;
  } else if (options.sandbox) {
    sandbox = options.sandbox;
  } else if (process.env.VESLO_DISABLE_SANDBOX === "1") {
    sandbox = null;
    options.logger.warn(
      "engine spawn unsandboxed (VESLO_DISABLE_SANDBOX=1)",
      { workspace: options.workspace },
      "sandbox",
    );
  } else {
    try {
      sandbox = resolveSandbox();
    } catch (err) {
      options.logger.warn(
        "sandbox unavailable, spawning unsandboxed",
        { workspace: options.workspace, error: err instanceof Error ? err.message : String(err) },
        "sandbox",
      );
      sandbox = null;
    }
  }

  let child: ChildProcess;
  if (sandbox && sandbox.isAvailable()) {
    const baseCommand = [options.bin, ...args].map(shellQuote).join(" ");
    // F4Ú4 — engine needs write access beyond workspace:
    //   - OPENCODE_CONFIG_DIR (SQLite migrations, logs, telemetry, auth cache)
    //   - /tmp + /private/tmp + /var/folders (SQLite WAL/SHM, scratch files)
    //   - XDG dirs opencode uses: ~/.local/state/opencode, ~/.local/share/opencode,
    //     ~/.cache/opencode, ~/.config/opencode (sessions DB, model cache, settings)
    //   VSLO-86: `@opencode-ai/plugin` + zod are vendored into
    //   `<workspace>/.opencode/node_modules/` and `<configDir>/node_modules/`
    //   at provisioning time, so the engine no longer needs to walk into
    //   `~/.bun/install/cache` at runtime. Keeping that path out of the
    //   sandbox allow-list avoids a regression where the sandbox-runtime
    //   appears to abort fresh spawns when the path is added.
    //   These will move to per-workspace dirs in a later fáze.
    const home = process.env.HOME ?? "";
    const extraWrites: string[] = [
      "/tmp",
      "/private/tmp",
      "/var/folders",
    ];
    if (options.configDir) extraWrites.push(options.configDir);
    if (home) {
      extraWrites.push(
        `${home}/.local/state/opencode`,
        `${home}/.local/share/opencode`,
        `${home}/.cache/opencode`,
        `${home}/.config/opencode`,
      );
    }
    const wrapped = await sandbox.wrap({
      command: baseCommand,
      workspacePath: options.workspace,
      additionalWritePaths: extraWrites,
    });
    options.logger.info(
      "engine spawn (sandboxed)",
      { workspace: options.workspace, backend: sandbox.name },
      "sandbox",
    );
    child = spawnProcess("/bin/sh", ["-c", wrapped], {
      cwd: options.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } else {
    child = spawnProcess(options.bin, args, {
      cwd: options.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  }

  prefixStream(child.stdout, "opencode", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "opencode", "stderr", options.logger, child.pid ?? undefined);

  // Surface spawn-level failures eagerly. Without these listeners an opencode
  // crash before its first stdout write was invisible — callers blocked on
  // waitForHealthy for up to 60s with no log explaining what went wrong.
  child.once("error", (err) => {
    options.logger.error(
      "engine spawn failed (process error)",
      { workspace: options.workspace, pid: child.pid, error: err.message },
      "opencode",
    );
  });
  child.once("exit", (code, signal) => {
    if (code === 0) return; // clean shutdown
    options.logger.warn(
      "engine process exited",
      {
        workspace: options.workspace,
        pid: child.pid,
        code,
        signal,
      },
      "opencode",
    );
  });

  return child;
}

async function startVesloServer(options: {
  bin: string;
  host: string;
  port: number;
  workspace: string;
  token: string;
  hostToken: string;
  approvalMode: ApprovalMode;
  approvalTimeoutMs: number;
  readOnly: boolean;
  corsOrigins: string[];
  opencodeBaseUrl?: string;
  opencodeDirectory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencodeRouterHealthPort?: number;
  opencodeRouterDataDir?: string;
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
}) {
  const managedAiBaseUrl = (
    process.env.VESLO_MANAGED_AI_BASE_URL?.trim() ||
    process.env.VESLO_AI_GATEWAY_BASE_URL?.trim() ||
    DEFAULT_MANAGED_AI_BASE_URL
  ).replace(/\/+$/, "");

  const args = [
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--token",
    options.token,
    "--host-token",
    options.hostToken,
    "--workspace",
    options.workspace,
    "--approval",
    options.approvalMode,
    "--approval-timeout",
    String(options.approvalTimeoutMs),
  ];

  if (options.readOnly) {
    args.push("--read-only");
  }

  if (options.corsOrigins.length) {
    args.push("--cors", options.corsOrigins.join(","));
  }

  if (options.opencodeBaseUrl) {
    args.push("--opencode-base-url", options.opencodeBaseUrl);
  }
  if (options.opencodeDirectory) {
    args.push("--opencode-directory", options.opencodeDirectory);
  }
  if (options.opencodeUsername) {
    args.push("--opencode-username", options.opencodeUsername);
  }
  if (options.opencodePassword) {
    args.push("--opencode-password", options.opencodePassword);
  }
  if (options.logFormat) {
    args.push("--log-format", options.logFormat);
  }

  const resolved = resolveBinCommand(options.bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      VESLO_TOKEN: options.token,
      VESLO_HOST_TOKEN: options.hostToken,
      VESLO_RUN_ID: options.runId,
      VESLO_LOG_FORMAT: options.logFormat,
      OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
        {
          "service.name": "veslo-server",
          "service.instance.id": options.runId,
        },
        process.env.OTEL_RESOURCE_ATTRIBUTES,
      ),
      ...(options.opencodeRouterHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) } : {}),
      ...(options.opencodeRouterDataDir ? { OPENCODE_ROUTER_DATA_DIR: options.opencodeRouterDataDir } : {}),
      VESLO_MANAGED_AI_BASE_URL: managedAiBaseUrl,
      ...(options.opencodeBaseUrl ? { VESLO_OPENCODE_BASE_URL: options.opencodeBaseUrl } : {}),
      ...(options.opencodeDirectory ? { VESLO_OPENCODE_DIRECTORY: options.opencodeDirectory } : {}),
      ...(options.opencodeUsername ? { VESLO_OPENCODE_USERNAME: options.opencodeUsername } : {}),
      ...(options.opencodePassword ? { VESLO_OPENCODE_PASSWORD: options.opencodePassword } : {}),
    },
  });

  prefixStream(child.stdout, "veslo-server", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "veslo-server", "stderr", options.logger, child.pid ?? undefined);

  child.once("error", (err) => {
    options.logger.error(
      "veslo-server spawn failed (process error)",
      { workspace: options.workspace, pid: child.pid, error: err.message },
      "veslo-server",
    );
  });
  child.once("exit", (code, signal) => {
    if (code === 0) return;
    options.logger.warn(
      "veslo-server process exited",
      { workspace: options.workspace, pid: child.pid, code, signal },
      "veslo-server",
    );
  });

  return child;
}

async function startOpenCodeRouter(options: {
  bin: string;
  workspace: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencodeRouterHealthPort?: number;
  opencodeRouterDataDir?: string;
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
}) {
  const args = ["serve", options.workspace];
  if (options.opencodeUrl) {
    const supports = await opencodeRouterSupportsOpencodeUrl(options.bin);
    if (supports) {
      args.push("--opencode-url", options.opencodeUrl);
    }
  }

  const resolved = resolveBinCommand(options.bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      VESLO_RUN_ID: options.runId,
      VESLO_LOG_FORMAT: options.logFormat,
      OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
        {
          "service.name": "veslo-code-router",
          "service.instance.id": options.runId,
        },
        process.env.OTEL_RESOURCE_ATTRIBUTES,
      ),
      ...(options.opencodeUrl ? { OPENCODE_URL: options.opencodeUrl } : {}),
      OPENCODE_DIRECTORY: options.workspace,
      ...(options.opencodeRouterHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) } : {}),
      ...(options.opencodeRouterDataDir ? { OPENCODE_ROUTER_DATA_DIR: options.opencodeRouterDataDir } : {}),
      ...(options.opencodeUsername ? { OPENCODE_SERVER_USERNAME: options.opencodeUsername } : {}),
      ...(options.opencodePassword ? { OPENCODE_SERVER_PASSWORD: options.opencodePassword } : {}),
    },
  });

  prefixStream(child.stdout, "veslo-code-router", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "veslo-code-router", "stderr", options.logger, child.pid ?? undefined);

  child.once("error", (err) => {
    options.logger.error(
      "veslo-code-router spawn failed (process error)",
      { workspace: options.workspace, pid: child.pid, error: err.message },
      "veslo-code-router",
    );
  });
  child.once("exit", (code, signal) => {
    if (code === 0) return;
    options.logger.warn(
      "veslo-code-router process exited",
      { workspace: options.workspace, pid: child.pid, code, signal },
      "veslo-code-router",
    );
  });

  return child;
}

async function opencodeRouterSupportsOpencodeUrl(bin: string): Promise<boolean> {
  const resolved = resolveBinCommand(bin);
  return new Promise((resolve) => {
    const child = spawnProcess(resolved.command, [...resolved.prefixArgs, "--help"], {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(output.includes("--opencode-url"));
    }, 1500);

    const onChunk = (chunk: unknown) => {
      output += String(chunk ?? "");
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("exit", () => {
      clearTimeout(timeout);
      resolve(output.includes("--opencode-url"));
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function verifyOpenCodeRouterVersion(binary: ResolvedBinary): Promise<string | undefined> {
  if (binary.source !== "external") {
    return binary.expectedVersion;
  }
  const actual = await readCliVersion(binary.bin);
  assertVersionMatch("veslo-code-router", binary.expectedVersion, actual, binary.bin);
  return actual;
}

async function verifyOpencodeVersion(binary: ResolvedBinary): Promise<string | undefined> {
  const actual = await readCliVersion(binary.bin);
  if (!actual) {
    process.stderr.write(
      `[veslo-orchestrator] Warning: unable to determine opencode version from ${binary.bin}. Proceeding without a version check.\n`,
    );
  }
  return reconcileOpencodeVersion(binary, actual);
}

async function verifyVesloServer(input: {
  baseUrl: string;
  token: string;
  hostToken: string;
  expectedVersion?: string;
  expectedWorkspace: string;
  expectedOpencodeBaseUrl?: string;
  expectedOpencodeDirectory?: string;
  expectedOpencodeUsername?: string;
  expectedOpencodePassword?: string;
}): Promise<string | undefined> {
  const health = await fetchJson(`${input.baseUrl}/health`);
  const actualVersion = typeof health?.version === "string" ? health.version : undefined;
  assertVersionMatch("veslo-server", input.expectedVersion, actualVersion, `${input.baseUrl}/health`);

  const headers = { Authorization: `Bearer ${input.token}` };
  const workspaces = await fetchJson(`${input.baseUrl}/workspaces`, { headers });
  const items = Array.isArray(workspaces?.items) ? (workspaces.items as Array<Record<string, unknown>>) : [];
  if (!items.length) {
    throw new Error("Veslo server returned no workspaces");
  }

  const expectedPath = normalizeWorkspacePath(input.expectedWorkspace);
  const matched = items.find((item) => {
    const candidate = item as { path?: string };
    const path = typeof candidate.path === "string" ? candidate.path : "";
    return path && normalizeWorkspacePath(path) === expectedPath;
  }) as
    | {
        id?: string;
        path?: string;
        opencode?: { baseUrl?: string; directory?: string; username?: string; password?: string };
      }
    | undefined;

  if (!matched) {
    throw new Error(`Veslo server workspace mismatch. Expected ${expectedPath}.`);
  }

  const opencode = matched.opencode;
  if (input.expectedOpencodeBaseUrl && opencode?.baseUrl !== input.expectedOpencodeBaseUrl) {
    throw new Error(
      `Veslo server OpenCode base URL mismatch: expected ${input.expectedOpencodeBaseUrl}, got ${opencode?.baseUrl ?? "<missing>"}.`,
    );
  }
  if (input.expectedOpencodeDirectory && opencode?.directory !== input.expectedOpencodeDirectory) {
    throw new Error(
      `Veslo server OpenCode directory mismatch: expected ${input.expectedOpencodeDirectory}, got ${opencode?.directory ?? "<missing>"}.`,
    );
  }
  if (input.expectedOpencodeUsername && opencode?.username !== input.expectedOpencodeUsername) {
    throw new Error("Veslo server OpenCode username mismatch.");
  }
  if (input.expectedOpencodePassword && opencode?.password !== input.expectedOpencodePassword) {
    throw new Error("Veslo server OpenCode password mismatch.");
  }

  const hostHeaders = { "X-Veslo-Host-Token": input.hostToken };
  await fetchJson(`${input.baseUrl}/approvals`, { headers: hostHeaders });

  return actualVersion;
}

async function runChecks(input: {
  opencodeClient: ReturnType<typeof createOpencodeClient>;
  vesloUrl: string;
  vesloToken: string;
  hostToken: string;
  checkEvents: boolean;
}) {
  const baseUrl = input.vesloUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${input.vesloToken}` };
  const hostHeaders = { "X-Veslo-Host-Token": input.hostToken };
  const workspaces = await fetchJson(`${baseUrl}/workspaces`, { headers });
  if (!workspaces?.items?.length) {
    throw new Error("Veslo server returned no workspaces");
  }

  const workspaceId = workspaces.items[0].id as string;
  await fetchJson(`${baseUrl}/workspace/${workspaceId}/config`, { headers });

  // Smoke test: mounted opencodeRouter proxy and auth behavior.
  // - /w/:id/veslo-code-router/health is client-readable
  // - other /w/:id/veslo-code-router/* requires host/owner auth
  const owMountBase = `${baseUrl}/w/${encodeURIComponent(workspaceId)}/veslo-code-router`;
  const owHealthRes = await fetch(`${owMountBase}/health`, {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  if (owHealthRes.status >= 500) {
    throw new Error(`opencodeRouter mount proxy returned ${owHealthRes.status}`);
  }
  const owConfigured = owHealthRes.status !== 404;
  if (owConfigured) {
    const clientRes = await fetch(`${owMountBase}/config/groups`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (clientRes.status === 200) {
      throw new Error("opencodeRouter mount proxy /config/groups should require host auth");
    }
    if (clientRes.status !== 401 && clientRes.status !== 403) {
      throw new Error(`opencodeRouter mount proxy /config/groups unexpected status: ${clientRes.status}`);
    }

    const hostRes = await fetch(`${owMountBase}/config/groups`, {
      headers: hostHeaders,
      signal: AbortSignal.timeout(3000),
    });
    if (hostRes.status >= 500) {
      throw new Error(`opencodeRouter mount proxy (host auth) returned ${hostRes.status}`);
    }
    if (hostRes.status === 401 || hostRes.status === 403) {
      throw new Error("opencodeRouter mount proxy /config/groups rejected host auth");
    }
  }

  const created = await input.opencodeClient.session.create({ title: "Veslo headless check" });
  const createdSession = unwrap(created);
  unwrap(await input.opencodeClient.session.messages({ sessionID: createdSession.id, limit: 10 }));

  if (input.checkEvents) {
    const events: { type: string }[] = [];
    const controller = new AbortController();
    const subscription = await input.opencodeClient.event.subscribe(undefined, { signal: controller.signal });
    const reader = (async () => {
      try {
        for await (const raw of subscription.stream) {
          const normalized = normalizeEvent(raw);
          if (!normalized) continue;
          events.push(normalized);
          if (events.length >= 10) break;
        }
      } catch {
        // ignore
      }
    })();

    unwrap(await input.opencodeClient.session.create({ title: "Veslo headless check events" }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.abort();
    await Promise.race([reader, new Promise((resolve) => setTimeout(resolve, 500))]);

    if (!events.length) {
      throw new Error("No SSE events observed during check");
    }
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.message ? ` ${payload.message}` : "";
    throw new Error(`HTTP ${response.status}${message}`);
  }
  return payload;
}

function normalizeEvent(raw: unknown): { type: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type === "string") return { type: record.type };
  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.type === "string") return { type: payload.type };
  return null;
}

async function waitForRouterHealthy(baseUrl: string, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  const url = baseUrl.replace(/\/$/, "");
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for daemon health");
}

function outputResult(payload: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (typeof payload === "string") {
    console.log(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function outputError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    return;
  }
  console.error(message);
}

function createVerboseLogger(enabled: boolean, logger?: Logger, component = "veslo-orchestrator") {
  return (message: string) => {
    if (!enabled) return;
    if (logger) {
      logger.debug(message, undefined, component);
      return;
    }
    console.log(`[${component}] ${message}`);
  };
}

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function colorize(input: string, color: string, enabled: boolean): string {
  if (!enabled) return input;
  return `${color}${input}${ANSI.reset}`;
}

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function mergeResourceAttributes(additional: Record<string, string>, existing?: string): string {
  const entries = new Map<string, string>();
  if (existing) {
    for (const part of existing.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [key, ...rest] = trimmed.split("=");
      if (!key || rest.length === 0) continue;
      entries.set(key, rest.join("=").replace(/,/g, ";"));
    }
  }
  for (const [key, value] of Object.entries(additional)) {
    if (!key) continue;
    if (value === undefined || value === null) continue;
    entries.set(key, String(value).replace(/,/g, ";"));
  }
  return Array.from(entries.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function createLogger(options: {
  format: LogFormat;
  runId: string;
  serviceName: string;
  serviceVersion?: string;
  output?: "stdout" | "silent";
  color?: boolean;
  onLog?: (event: LogEvent) => void;
}): Logger {
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": options.serviceName,
    "service.instance.id": options.runId,
  };
  if (options.serviceVersion) {
    resource["service.version"] = options.serviceVersion;
  }
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": options.runId,
    "process.pid": process.pid,
  };
  const output = options.output ?? "stdout";
  const colorEnabled = options.color ?? false;
  const componentColors: Record<string, string> = {
    "veslo-orchestrator": ANSI.gray,
    opencode: ANSI.cyan,
    "veslo-server": ANSI.green,
    opencodeRouter: ANSI.magenta,
    "veslo-orchestrator-router": ANSI.cyan,
  };
  const levelColors: Record<LogLevel, string> = {
    debug: ANSI.gray,
    info: ANSI.gray,
    warn: ANSI.yellow,
    error: ANSI.red,
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes, component?: string) => {
    const mergedAttributes: LogAttributes = {
      ...baseAttributes,
      ...(component ? { "service.component": component } : {}),
      ...(attributes ?? {}),
    };
    options.onLog?.({
      time: Date.now(),
      level,
      message,
      component,
      attributes: mergedAttributes,
    });
    if (output === "silent") return;
    if (options.format === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: mergedAttributes,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const label = component ?? options.serviceName;
    const tagLabel = label ? `[${label}]` : "";
    const levelTag = level === "info" ? "" : level.toUpperCase();
    const coloredLabel = tagLabel
      ? colorize(tagLabel, componentColors[label] ?? ANSI.gray, colorEnabled)
      : "";
    const coloredLevel = levelTag
      ? colorize(levelTag, levelColors[level] ?? ANSI.gray, colorEnabled)
      : "";
    const tag = [coloredLabel, coloredLevel].filter(Boolean).join(" ");
    // Append caller-supplied attributes inline for warn/error so spawn /
    // proxy / connect failures surface their real cause in plain-text logs.
    // Without this, `logger.warn("X failed", { error: e.message })` shows
    // only "X failed" — the actual message gets dropped on the floor in
    // text format, leaving debugging to crash-dump archaeology.
    let attrsSuffix = "";
    if ((level === "warn" || level === "error") && attributes) {
      const omitKeys = new Set(["run.id", "process.pid", "service.component"]);
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(attributes)) {
        if (omitKeys.has(k)) continue;
        if (v === undefined || v === null) continue;
        filtered[k] = v;
      }
      if (Object.keys(filtered).length > 0) {
        try {
          attrsSuffix = ` ${JSON.stringify(filtered)}`;
        } catch {
          // ignore stringify failure
        }
      }
    }
    const line = tag ? `${tag} ${message}${attrsSuffix}` : `${message}${attrsSuffix}`;
    process.stdout.write(`${line}\n`);
  };

  const child = (component: string, attributes?: LogAttributes): LoggerChild => ({
    log: (level, message, attrs) => emit(level, message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    debug: (message, attrs) => emit("debug", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    info: (message, attrs) => emit("info", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    warn: (message, attrs) => emit("warn", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    error: (message, attrs) => emit("error", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
  });

  return {
    format: options.format,
    output,
    log: emit,
    debug: (message, attrs, component) => emit("debug", message, attrs, component),
    info: (message, attrs, component) => emit("info", message, attrs, component),
    warn: (message, attrs, component) => emit("warn", message, attrs, component),
    error: (message, attrs, component) => emit("error", message, attrs, component),
    child,
  };
}

function looksLikeOtelLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return false;
    return typeof parsed.timeUnixNano === "string" && typeof parsed.severityText === "string";
  } catch {
    return false;
  }
}

function buildAttachCommand(input: {
  url: string;
  workspace: string;
  username?: string;
  password?: string;
}): string {
  const parts: string[] = [];
  if (input.username && input.password && input.username !== DEFAULT_OPENCODE_USERNAME) {
    parts.push(`OPENCODE_SERVER_USERNAME=${input.username}`);
  }
  if (input.password) {
    parts.push(`OPENCODE_SERVER_PASSWORD=${input.password}`);
  }
  parts.push("opencode", "attach", input.url, "--dir", input.workspace);
  return parts.join(" ");
}

async function runClipboardCommand(command: string, args: string[], text: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawnProcess(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.stdin?.write(text);
    child.stdin?.end();
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function copyToClipboard(text: string): Promise<{ copied: boolean; error?: string }> {
  const platform = process.platform;
  const commands: Array<{ command: string; args: string[] }> = [];
  if (platform === "darwin") {
    commands.push({ command: "pbcopy", args: [] });
  } else if (platform === "win32") {
    commands.push({ command: "clip", args: [] });
  } else {
    commands.push({ command: "wl-copy", args: [] });
    commands.push({ command: "xclip", args: ["-selection", "clipboard"] });
    commands.push({ command: "xsel", args: ["--clipboard", "--input"] });
  }
  for (const entry of commands) {
    try {
      const ok = await runClipboardCommand(entry.command, entry.args, text);
      if (ok) return { copied: true };
    } catch {
      // ignore
    }
  }
  return { copied: false, error: "Clipboard unavailable" };
}

async function spawnRouterDaemon(args: ParsedArgs, dataDir: string, host: string, port: number) {
  const self = resolveSelfCommand();
  const commandArgs = [
    ...self.prefixArgs,
    "daemon",
    "run",
    "--data-dir",
    dataDir,
    "--daemon-host",
    host,
    "--daemon-port",
    String(port),
  ];

  const opencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.VESLO_OPENCODE_BIN;
  const opencodeHost = readFlag(args.flags, "opencode-host") ?? process.env.VESLO_OPENCODE_HOST;
  const opencodePort = readFlag(args.flags, "opencode-port") ?? process.env.VESLO_OPENCODE_PORT;
  const opencodeWorkdir = readFlag(args.flags, "opencode-workdir") ?? process.env.VESLO_OPENCODE_WORKDIR;
  const opencodeHotReload =
    readFlag(args.flags, "opencode-hot-reload") ??
    process.env.VESLO_OPENCODE_HOT_RELOAD;
  const opencodeHotReloadDebounceMs =
    readFlag(args.flags, "opencode-hot-reload-debounce-ms") ??
    process.env.VESLO_OPENCODE_HOT_RELOAD_DEBOUNCE_MS;
  const opencodeHotReloadCooldownMs =
    readFlag(args.flags, "opencode-hot-reload-cooldown-ms") ??
    process.env.VESLO_OPENCODE_HOT_RELOAD_COOLDOWN_MS;
  const opencodeUsername = readFlag(args.flags, "opencode-username") ?? process.env.VESLO_OPENCODE_USERNAME;
  const opencodePassword = readFlag(args.flags, "opencode-password") ?? process.env.VESLO_OPENCODE_PASSWORD;
  const corsValue = readFlag(args.flags, "cors") ?? process.env.VESLO_OPENCODE_CORS;
  const allowExternal = readBool(args.flags, "allow-external", false, "VESLO_ALLOW_EXTERNAL");
  const sidecarSource = readFlag(args.flags, "sidecar-source") ?? process.env.VESLO_SIDECAR_SOURCE;
  const opencodeSource = readFlag(args.flags, "opencode-source") ?? process.env.VESLO_OPENCODE_SOURCE;
  const verbose = readBool(args.flags, "verbose", false, "VESLO_VERBOSE");
  const logFormat = readFlag(args.flags, "log-format") ?? process.env.VESLO_LOG_FORMAT;
  const runId = readFlag(args.flags, "run-id") ?? process.env.VESLO_RUN_ID;

  if (opencodeBin) commandArgs.push("--opencode-bin", opencodeBin);
  if (opencodeHost) commandArgs.push("--opencode-host", opencodeHost);
  if (opencodePort) commandArgs.push("--opencode-port", String(opencodePort));
  if (opencodeWorkdir) commandArgs.push("--opencode-workdir", opencodeWorkdir);
  if (opencodeHotReload) commandArgs.push("--opencode-hot-reload", opencodeHotReload);
  if (opencodeHotReloadDebounceMs) commandArgs.push("--opencode-hot-reload-debounce-ms", String(opencodeHotReloadDebounceMs));
  if (opencodeHotReloadCooldownMs) commandArgs.push("--opencode-hot-reload-cooldown-ms", String(opencodeHotReloadCooldownMs));
  if (opencodeUsername) commandArgs.push("--opencode-username", opencodeUsername);
  if (opencodePassword) commandArgs.push("--opencode-password", opencodePassword);
  if (corsValue) commandArgs.push("--cors", corsValue);
  if (allowExternal) commandArgs.push("--allow-external");
  if (sidecarSource) commandArgs.push("--sidecar-source", sidecarSource);
  if (opencodeSource) commandArgs.push("--opencode-source", opencodeSource);
  if (verbose) commandArgs.push("--verbose");
  if (logFormat) commandArgs.push("--log-format", String(logFormat));
  if (runId) commandArgs.push("--run-id", String(runId));

  const child = spawnProcess(self.command, commandArgs, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
    },
  });
  child.unref();
}

async function ensureRouterDaemon(args: ParsedArgs, autoStart = true): Promise<{ baseUrl: string; dataDir: string }> {
  const dataDir = resolveRouterDataDir(args.flags);
  const statePath = routerStatePath(dataDir);
  const state = await loadRouterState(statePath);
  const existing = state.daemon;
  if (existing && existing.baseUrl && isProcessAlive(existing.pid)) {
    try {
      await waitForRouterHealthy(existing.baseUrl, 1500, 150);
      return { baseUrl: existing.baseUrl, dataDir };
    } catch {
      // fallthrough
    }
  }

  if (!autoStart) {
    throw new Error("orchestrator daemon is not running");
  }

  const host = readFlag(args.flags, "daemon-host") ?? "127.0.0.1";
  const port = await resolvePort(
    readNumber(args.flags, "daemon-port", undefined, "VESLO_DAEMON_PORT"),
    "127.0.0.1",
  );
  const baseUrl = `http://${host}:${port}`;
  await spawnRouterDaemon(args, dataDir, host, port);
  await waitForRouterHealthy(baseUrl, 10_000, 250);
  return { baseUrl, dataDir };
}

async function requestRouter(args: ParsedArgs, method: string, path: string, body?: unknown, autoStart = true) {
  const { baseUrl } = await ensureRouterDaemon(args, autoStart);
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  return fetchJson(url, {
    method,
    headers,
    body: payload,
  });
}

async function runDaemonCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1] ?? "run";

  try {
    if (subcommand === "run" || subcommand === "foreground") {
      await runRouterDaemon(args);
      return;
    }
    if (subcommand === "start") {
      const { baseUrl } = await ensureRouterDaemon(args, true);
      const status = await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`);
      outputResult({ ok: true, baseUrl, ...status }, outputJson);
      return;
    }
    if (subcommand === "status") {
      const { baseUrl } = await ensureRouterDaemon(args, false);
      const status = await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`);
      outputResult({ ok: true, baseUrl, ...status }, outputJson);
      return;
    }
    if (subcommand === "stop") {
      const { baseUrl } = await ensureRouterDaemon(args, false);
      await fetchJson(`${baseUrl.replace(/\/$/, "")}/shutdown`, { method: "POST" });
      outputResult({ ok: true }, outputJson);
      return;
    }
    throw new Error("daemon requires start|stop|status|run");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runWorkspaceCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1];
  const id = args.positionals[2];

  try {
    if (subcommand === "add") {
      if (!id) throw new Error("workspace path is required");
      const name = readFlag(args.flags, "name");
      const result = await requestRouter(args, "POST", "/workspaces", {
        path: id,
        name: name ?? null,
      });
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "add-remote") {
      if (!id) throw new Error("baseUrl is required");
      const directory = readFlag(args.flags, "directory");
      const name = readFlag(args.flags, "name");
      const result = await requestRouter(args, "POST", "/workspaces/remote", {
        baseUrl: id,
        directory: directory ?? null,
        name: name ?? null,
      });
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "list") {
      const result = await requestRouter(args, "GET", "/workspaces");
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "switch") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "POST", `/workspaces/${encodeURIComponent(id)}/activate`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "info") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "GET", `/workspaces/${encodeURIComponent(id)}`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "path") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "GET", `/workspaces/${encodeURIComponent(id)}/path`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    throw new Error("workspace requires add|add-remote|list|switch|info|path");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runInstanceCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1];
  const id = args.positionals[2];

  try {
    if (subcommand === "dispose") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "POST", `/instances/${encodeURIComponent(id)}/dispose`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    throw new Error("instance requires dispose");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runRouterDaemon(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const verbose = readBool(args.flags, "verbose", false, "VESLO_VERBOSE");
  const logFormat = readLogFormat(args.flags, "log-format", "pretty", "VESLO_LOG_FORMAT");
  const colorEnabled =
    readBool(args.flags, "color", process.stdout.isTTY, "VESLO_COLOR") && !process.env.NO_COLOR;
  const runId = readFlag(args.flags, "run-id") ?? process.env.VESLO_RUN_ID ?? randomUUID();
  const cliVersion = await resolveCliVersion();
  const logger = createLogger({
    format: logFormat,
    runId,
    serviceName: "veslo-orchestrator",
    serviceVersion: cliVersion,
    output: "stdout",
    color: colorEnabled,
  });
  const logVerbose = createVerboseLogger(verbose && !outputJson, logger, "veslo-orchestrator");
  const sidecarSourceInput = readBinarySource(args.flags, "sidecar-source", "auto", "VESLO_SIDECAR_SOURCE");
  const opencodeSourceInput = readBinarySource(args.flags, "opencode-source", "auto", "VESLO_OPENCODE_SOURCE");
  const sidecarSource = sidecarSourceInput;
  const opencodeSource = opencodeSourceInput;
  const dataDir = resolveRouterDataDir(args.flags);
  const statePath = routerStatePath(dataDir);
  // Clear stale `.tmp.*` files left behind by previous crashes between
  // writeFile and rename inside atomicWriteJson. Without this, the data dir
  // can accumulate orphan tmp files that confuse later debugging.
  const cleanedTmps = await cleanupStaleTmpFiles(statePath);
  if (cleanedTmps > 0) {
    logger.info(
      "cleaned stale state tmp files",
      { count: cleanedTmps, statePath },
      "veslo-orchestrator",
    );
  }
  let state = await loadRouterState(statePath);

  const host = readFlag(args.flags, "daemon-host") ?? "127.0.0.1";
  const port = await resolvePort(
    readNumber(args.flags, "daemon-port", undefined, "VESLO_DAEMON_PORT"),
    "127.0.0.1",
  );

  // VSLO-171 fáze 2 F2Ú4 — engine pool capacity + idle suspend.
  const maxEngines = readNumber(args.flags, "max-engines", 8, "VESLO_MAX_ENGINES") ?? 8;
  if (!Number.isFinite(maxEngines) || maxEngines < 1 || maxEngines > 64) {
    throw new Error("--max-engines must be between 1 and 64");
  }
  const idleSuspendMs =
    readNumber(args.flags, "idle-suspend-ms", 15 * 60_000, "VESLO_IDLE_SUSPEND_MS") ??
    15 * 60_000;
  if (!Number.isFinite(idleSuspendMs) || idleSuspendMs < 0) {
    throw new Error("--idle-suspend-ms must be >= 0");
  }

  const opencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.VESLO_OPENCODE_BIN;
  const opencodeHost =
    readFlag(args.flags, "opencode-host") ?? process.env.VESLO_OPENCODE_HOST ?? "127.0.0.1";
  const opencodePassword =
    readFlag(args.flags, "opencode-password") ??
    process.env.VESLO_OPENCODE_PASSWORD ??
    process.env.OPENCODE_SERVER_PASSWORD;
  const opencodeUsername =
    readFlag(args.flags, "opencode-username") ??
    process.env.VESLO_OPENCODE_USERNAME ??
    process.env.OPENCODE_SERVER_USERNAME ??
    DEFAULT_OPENCODE_USERNAME;
  const authHeaders = opencodePassword
    ? { Authorization: `Basic ${encodeBasicAuth(opencodeUsername, opencodePassword)}` }
    : undefined;
  // VSLO-171 fáze 2 F2Ú3: singleton engine smazán. Tento port byl pro legacy
  // singleton; pool si spawne engines na vlastních volných portech přes findFreePort.
  // Necháváme proměnnou pro CLI flag kompat (--opencode-port), ale fallback na
  // state.opencode (deprecated field) je pryč.
  const opencodePort = await resolvePort(
    readNumber(args.flags, "opencode-port", undefined, "VESLO_OPENCODE_PORT"),
    "127.0.0.1",
  );
  const opencodeHotReload = readOpencodeHotReload(
    args.flags,
    {
      enabled: true,
      debounceMs: DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
      cooldownMs: DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    },
    {
      enabled: "VESLO_OPENCODE_HOT_RELOAD",
      debounceMs: "VESLO_OPENCODE_HOT_RELOAD_DEBOUNCE_MS",
      cooldownMs: "VESLO_OPENCODE_HOT_RELOAD_COOLDOWN_MS",
    },
  );
  const corsValue =
    readFlag(args.flags, "cors") ??
    process.env.VESLO_OPENCODE_CORS ??
    "http://localhost:5173,tauri://localhost,http://tauri.localhost";
  const corsOrigins = parseList(corsValue);
  logger.info("Daemon starting", { runId, logFormat, host, port }, "veslo-orchestrator");

  const sidecar = resolveSidecarConfig(args.flags, cliVersion);
  const allowExternal = readBool(args.flags, "allow-external", false, "VESLO_ALLOW_EXTERNAL");
  const manifest = await readVersionManifest();
  logVerbose(`cli version: ${cliVersion}`);
  logVerbose(`sidecar target: ${sidecar.target ?? "unknown"}`);
  logVerbose(`sidecar dir: ${sidecar.dir}`);
  logVerbose(`sidecar base URL: ${sidecar.baseUrl}`);
  logVerbose(`sidecar manifest: ${sidecar.manifestUrl}`);
  logVerbose(`sidecar source: ${sidecarSource}`);
  logVerbose(`opencode source: ${opencodeSource}`);
  logVerbose(
    `opencode hot reload: ${opencodeHotReload.enabled ? "on" : "off"} (debounce=${opencodeHotReload.debounceMs}ms cooldown=${opencodeHotReload.cooldownMs}ms)`,
  );
  logVerbose(`allow external: ${allowExternal ? "true" : "false"}`);
  const opencodeBinary = await resolveOpencodeBin({
    explicit: opencodeBin,
    manifest,
    allowExternal,
    sidecar,
    source: opencodeSource,
  });
  logVerbose(`opencode bin: ${opencodeBinary.bin} (${opencodeBinary.source})`);

  const updateDiagnostics = (actualVersion?: string) => {
    state.cliVersion = cliVersion;
    state.sidecar = {
      dir: sidecar.dir,
      baseUrl: sidecar.baseUrl,
      manifestUrl: sidecar.manifestUrl,
      target: sidecar.target,
      source: sidecarSource,
      opencodeSource,
      allowExternal,
    };
    state.binaries = {
      opencode: {
        path: opencodeBinary.bin,
        source: opencodeBinary.source,
        expectedVersion: opencodeBinary.expectedVersion,
        actualVersion,
      },
    };
  };

  // VSLO-171 fáze 2 F2Ú3: opencode version je dnes diagnostika-only; pool si
  // verzi neověřuje, OpenCode binary stačí spawnnout per workspace lazy.
  // updateDiagnostics() se volá při prvním pool.ensure (nebo přes /health
  // poll), ale tady ji už neaktualizujeme z initial check.
  try {
    const initialOpencodeVersion = await verifyOpencodeVersion(opencodeBinary);
    logVerbose(`opencode version: ${initialOpencodeVersion ?? "unknown"}`);
    updateDiagnostics(initialOpencodeVersion);
    await saveRouterState(statePath, state);
  } catch (err) {
    logger.warn("opencode version probe failed", { error: String(err) }, "veslo-orchestrator");
  }

  // F2Ú5 — 2-stage closure: `pool` references `persistEngines`, which itself
  // references `pool`. Mutable placeholder breaks the cycle; assigned right
  // after `pool` is constructed.
  let persistEngines: () => void = () => {};

  const pool = new EnginePool({
    deps: {
      resolveWorkspace: async (ws) => {
        const workdir = await ensureWorkspace(ws.path ?? "");
        const configDir = join(dataDir, "opencode-config", workspaceIdForLocal(workdir));
        await ensureOpencodeManagedTools(configDir);
        return { workdir, configDir };
      },
      spawnEngine: async ({ workspaceId, workdir, configDir, port }) => {
        const child = await startOpencode({
          bin: opencodeBinary.bin,
          workspace: workdir,
          configDir,
          hotReload: opencodeHotReload,
          bindHost: opencodeHost,
          port,
          username: opencodePassword ? opencodeUsername : undefined,
          password: opencodePassword,
          corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
          logger,
          runId: `${runId}-${workspaceId.slice(-8)}`,
          logFormat,
        });
        // opencodeHost is the *bind* address (often 0.0.0.0 so the engine is
        // reachable from the host machine + LAN). The pool/proxy fetches this
        // baseUrl as a client, where 0.0.0.0 is meaningless — Node's fetch
        // resolves it to a routable address only on some platforms and refuses
        // on others, producing "Unable to connect" engine proxy errors. Map
        // wildcard binds to loopback so the local client always has a valid
        // target.
        const clientHost = opencodeHost === "0.0.0.0" || opencodeHost === "::" ? "127.0.0.1" : opencodeHost;
        return { child, baseUrl: `http://${clientHost}:${port}` };
      },
      waitForHealthy: async (baseUrl) => {
        const client = createOpencodeClient({ baseUrl, headers: authHeaders });
        // Opencode cold-start (Bun JIT + SQLite migration + sandbox-runtime
        // init) routinely exceeds 30s in dev builds. Pool returns 502 to the
        // SDK if we time out, even though the engine reaches ready shortly
        // after — the user then sees Error badges and a stuck UI. 60s gives
        // cold paths room without blocking interactive switches.
        const timeoutMs = (() => {
          const raw = process.env.VESLO_OPENCODE_HEALTH_TIMEOUT_MS;
          const parsed = raw ? Number.parseInt(raw, 10) : NaN;
          return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 60_000;
        })();
        await waitForOpencodeHealthy(client, timeoutMs);
      },
      stopChild,
      findFreePort: () => findFreePort(opencodeHost),
      isProcessAlive,
      log: (msg, attrs) => logger.info(msg, attrs, "engine-pool"),
      // F2Ú5 — per-engine health probe (2s timeout, 250ms retry). Pool
      // strikes 3× before treating as crashed.
      healthCheck: async (baseUrl) => {
        const client = createOpencodeClient({ baseUrl, headers: authHeaders });
        await waitForOpencodeHealthy(client, 2000, 250);
      },
      // F2Ú5 — state transition events. Log + trigger debounced persist.
      onEngineChange: (workspaceId, event) => {
        logger.info("engine event", { workspaceId, event }, "engine-pool");
        persistEngines();
      },
    },
    config: { maxEngines, idleSuspendMs },
  });

  persistEngines = (): void => {
    state.engines = Object.fromEntries(
      pool.snapshot().map((entry) => [entry.workspaceId, entry]),
    );
    persistDebounced(statePath, state);
  };

  const persistEnginesSnapshot = persistEngines;

  const server = createHttpServer(async (req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    res.on("finish", () => {
      logger.info(
        "Router request",
        {
          method,
          path: url.pathname,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          activeId: state.activeId,
        },
        "veslo-orchestrator-router",
      );
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);

    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    };

    const readBody = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (!chunks.length) return null;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    };

    try {
        if (req.method === "GET" && url.pathname === "/health") {
          // VSLO-171 fáze 2 F2Ú3: `opencode` field (legacy singleton) smazán
          // z /health. Tauri Rust `OrchestratorHealth.opencode: Option<...>`
          // deserializuje missing field jako None — backward-safe.
          send(200, {
            ok: true,
            daemon: state.daemon ?? null,
            engines: pool.snapshot(),
            activeId: state.activeId,
            workspaceCount: state.workspaces.length,
            cliVersion: state.cliVersion ?? null,
            sidecar: state.sidecar ?? null,
            binaries: state.binaries ?? null,
          });
          return;
        }

      if (req.method === "GET" && url.pathname === "/workspaces") {
        send(200, { activeId: state.activeId, workspaces: state.workspaces });
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces") {
        const body = await readBody();
        const pathInput = typeof body?.path === "string" ? body.path.trim() : "";
        if (!pathInput) {
          send(400, { error: "path is required" });
          return;
        }
        const resolved = await ensureWorkspace(pathInput);
        const id = workspaceIdForLocal(resolved);
        const name = typeof body?.name === "string" && body.name.trim()
          ? body.name.trim()
          : resolved.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
        const existing = state.workspaces.find((entry) => entry.id === id);
        const entry: RouterWorkspace = {
          id,
          name,
          path: resolved,
          workspaceType: "local",
          createdAt: existing?.createdAt ?? nowMs(),
          lastUsedAt: nowMs(),
        };
        state.workspaces = state.workspaces.filter((item) => item.id !== id);
        state.workspaces.push(entry);
        if (!state.activeId) state.activeId = id;
        await saveRouterState(statePath, state);
        send(200, { activeId: state.activeId, workspace: entry });
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/remote") {
        const body = await readBody();
        const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
        if (!baseUrl || (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://"))) {
          send(400, { error: "baseUrl must start with http:// or https://" });
          return;
        }
        const directory = typeof body?.directory === "string" ? body.directory.trim() : "";
        const id = workspaceIdForRemote(baseUrl, directory || undefined);
        const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : baseUrl;
        const existing = state.workspaces.find((entry) => entry.id === id);
        const entry: RouterWorkspace = {
          id,
          name,
          path: directory,
          workspaceType: "remote",
          baseUrl,
          directory: directory || undefined,
          createdAt: existing?.createdAt ?? nowMs(),
          lastUsedAt: nowMs(),
        };
        state.workspaces = state.workspaces.filter((item) => item.id !== id);
        state.workspaces.push(entry);
        if (!state.activeId) state.activeId = id;
        await saveRouterState(statePath, state);
        send(200, { activeId: state.activeId, workspace: entry });
        return;
      }

      if (parts[0] === "workspaces" && parts.length === 2 && req.method === "GET") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        send(200, { workspace });
        return;
      }

      if (parts[0] === "workspaces" && parts.length === 3 && parts[2] === "activate" && req.method === "POST") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        // Activate updates activeId immediately and waits for the engine to
        // become ready before responding. The previous fire-and-forget pattern
        // produced a race: callers (UI restartWorkspaceRuntime → loadSessions →
        // sidebar session listing) issued proxy requests with a 10s client
        // timeout, while opencode cold-start (Bun JIT + SQLite migration +
        // sandbox init) routinely needs 30-60s. Result: "Request timed out."
        // errors and Error badges in the sidebar even though the engine came
        // up shortly after. Synchronous ensure here means activate returns
        // only when the engine is ready (or the per-engine health timeout
        // fires, which the pool surfaces as a thrown error).
        state.activeId = workspace.id;
        workspace.lastUsedAt = nowMs();
        await saveRouterState(statePath, state);
        if (workspace.workspaceType === "local" && workspace.path) {
          try {
            await pool.ensure({ id: workspace.id, path: workspace.path });
            persistEnginesSnapshot();
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            logger.warn(
              "eager engine spawn failed",
              { workspaceId: workspace.id, error: detail },
              "engine-pool",
            );
            send(502, { error: "engine spawn failed", detail });
            return;
          }
        }
        send(200, { activeId: state.activeId, workspace });
        return;
      }

      // VSLO-171 fáze 2 F2Ú3: GET /workspaces/:id/path endpoint smazán.
      // Tauri Rust orchestrator_workspace_activate dnes response ignoruje
      // (`let _ = ureq::get(...)`), jiný callsite není.

      if (parts[0] === "instances" && parts.length === 3 && parts[2] === "dispose" && req.method === "POST") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        // VSLO-171 fáze 2 F2Ú3: dispose mapuje na pool.suspend. Engine je
        // killnut, lazy respawn na další proxy request. Pro remote workspaces
        // dispose je no-op (vzdálený server si engine spravuje sám).
        if (workspace.workspaceType === "local") {
          await pool.suspend(workspace.id);
          persistEnginesSnapshot();
        }
        workspace.lastUsedAt = nowMs();
        await saveRouterState(statePath, state);
        send(200, { disposed: true });
        return;
      }

      if (parts[0] === "workspace" && parts.length >= 3 && parts[2] === "opencode") {
        const ws = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!ws) {
          send(404, { error: "workspace not found" });
          return;
        }
        if (ws.workspaceType === "remote") {
          send(501, {
            error: "remote engines are proxied by veslo-server, not orchestrator pool",
          });
          return;
        }
        if (!ws.path) {
          send(400, { error: "local workspace missing path" });
          return;
        }

        let engine: EngineProcess;
        try {
          engine = await pool.ensure({ id: ws.id, path: ws.path });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          // F2Ú4 — capacity exceeded je 503 (retry-able), spawn/health fail je 502.
          const status = detail.includes("capacity exceeded") ? 503 : 502;
          send(status, { error: "engine spawn failed", detail });
          return;
        }

        const restPath = "/" + parts.slice(3).join("/");
        const injectHeaders: Record<string, string> = {
          "x-opencode-directory": ws.path,
          "x-veslo-workspace-id": ws.id,
        };
        if (opencodePassword) {
          injectHeaders["authorization"] = `Basic ${encodeBasicAuth(
            opencodeUsername,
            opencodePassword,
          )}`;
        }

        ws.lastUsedAt = nowMs();
        persistEnginesSnapshot();

        proxyToEngine({
          clientReq: req,
          clientRes: res,
          targetBaseUrl: engine.baseUrl,
          targetPath: restPath,
          targetSearch: url.search,
          injectHeaders,
          stripIncomingHeaders: [
            "authorization",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
          ],
          onSuccess: () => {
            pool.touch(ws.id);
            persistEnginesSnapshot();
          },
          onError: (err) => {
            logger.warn(
              "engine proxy error",
              { workspaceId: ws.id, error: err.message },
              "engine-pool",
            );
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        send(200, { ok: true });
        await shutdown();
        return;
      }

      send(404, { error: "not found" });
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const shutdown = async () => {
    logger.info("Daemon shutting down", { host, port }, "veslo-orchestrator-router");
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // ignore
    }

    await pool.killAll();

    state.daemon = undefined;
    state.engines = {};
    await flushPersist();
    await saveRouterState(statePath, state);
    process.exit(0);
  };

  server.listen(port, host, async () => {
    state.daemon = {
      pid: process.pid,
      port,
      baseUrl: `http://${host}:${port}`,
      startedAt: nowMs(),
    };
    await saveRouterState(statePath, state);
    if (outputJson) {
      outputResult({ ok: true, daemon: state.daemon }, true);
    } else {
      if (logFormat === "json") {
        logger.info("Daemon running", { host, port }, "veslo-orchestrator-router");
      } else {
        console.log(`orchestrator daemon running on ${host}:${port}`);
      }
    }
  });

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  await new Promise(() => undefined);
}

function readVesloClientAuth(args: ParsedArgs): { vesloUrl: string; token: string } {
  const vesloUrl =
    readFlag(args.flags, "veslo-url") ??
    process.env.VESLO_URL ??
    process.env.VESLO_SERVER_URL ??
    "";
  const token =
    readFlag(args.flags, "token") ??
    readFlag(args.flags, "veslo-token") ??
    process.env.VESLO_TOKEN ??
    "";

  if (!vesloUrl || !token) {
    throw new Error("veslo-url and token are required");
  }

  return { vesloUrl, token };
}

function readSessionId(args: ParsedArgs, fallbackIndex: number): string {
  const sessionId = readFlag(args.flags, "session-id") ?? args.positionals[fallbackIndex] ?? "";
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error("session-id is required");
  }
  return trimmed;
}

async function runFiles(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1] ?? "";
  const { vesloUrl, token } = readVesloClientAuth(args);
  const baseUrl = vesloUrl.replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  try {
    if (subcommand === "session") {
      const action = args.positionals[2] ?? "create";
      if (action === "create") {
        const workspaceId = readFlag(args.flags, "workspace-id") ?? args.positionals[3] ?? "";
        if (!workspaceId.trim()) {
          throw new Error("workspace-id is required for files session create");
        }
        const ttlSeconds = readNumber(args.flags, "ttl-seconds", undefined);
        const writeRequested = readBool(args.flags, "write", true);
        const result = await fetchJson(
          `${baseUrl}/workspace/${encodeURIComponent(workspaceId.trim())}/files/sessions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...(typeof ttlSeconds === "number" ? { ttlSeconds } : {}),
              write: writeRequested,
            }),
          },
        );
        outputResult(result, outputJson);
        return;
      }
      if (action === "renew") {
        const sessionId = readSessionId(args, 3);
        const ttlSeconds = readNumber(args.flags, "ttl-seconds", undefined);
        const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/renew`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...(typeof ttlSeconds === "number" ? { ttlSeconds } : {}),
          }),
        });
        outputResult(result, outputJson);
        return;
      }
      if (action === "close" || action === "delete") {
        const sessionId = readSessionId(args, 3);
        const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          headers,
        });
        outputResult(result, outputJson);
        return;
      }
      throw new Error("files session requires create|renew|close");
    }

    if (subcommand === "catalog") {
      const sessionId = readSessionId(args, 2);
      const params = new URLSearchParams();
      const prefix = readFlag(args.flags, "prefix");
      const after = readFlag(args.flags, "after");
      const limit = readNumber(args.flags, "limit", undefined);
      const includeDirs = readBool(args.flags, "include-dirs", true);
      if (prefix?.trim()) params.set("prefix", prefix.trim());
      if (after?.trim()) params.set("after", after.trim());
      if (typeof limit === "number") params.set("limit", String(limit));
      if (!includeDirs) params.set("includeDirs", "false");
      const query = params.toString();
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot${query ? `?${query}` : ""}`,
        {
          headers,
        },
      );
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "events") {
      const sessionId = readSessionId(args, 2);
      const since = readNumber(args.flags, "since", undefined);
      const query = typeof since === "number" ? `?since=${encodeURIComponent(String(since))}` : "";
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/catalog/events${query}`, {
        headers,
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "read") {
      const sessionId = readSessionId(args, 2);
      const pathsRaw = readFlag(args.flags, "paths");
      const singlePath = readFlag(args.flags, "path") ?? args.positionals[3];
      const paths = pathsRaw ? parseList(pathsRaw) : singlePath ? [singlePath] : [];
      if (!paths.length) {
        throw new Error("path or paths is required for files read");
      }
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/read-batch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ paths }),
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "write") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) {
        throw new Error("path is required for files write");
      }

      let contentBase64 = readFlag(args.flags, "content-base64") ?? "";
      if (!contentBase64) {
        const inlineContent = readFlag(args.flags, "content");
        if (inlineContent !== undefined) {
          contentBase64 = Buffer.from(inlineContent, "utf8").toString("base64");
        }
      }
      if (!contentBase64) {
        const filePath = readFlag(args.flags, "file");
        if (filePath?.trim()) {
          const fileBytes = await readFile(resolve(filePath.trim()));
          contentBase64 = Buffer.from(fileBytes).toString("base64");
        }
      }
      if (!contentBase64) {
        throw new Error("provide one of --content, --content-base64, or --file");
      }

      const ifMatchRevision = readFlag(args.flags, "if-match");
      const force = readBool(args.flags, "force", false);
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/write-batch`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          writes: [
            {
              path: path.trim(),
              contentBase64,
              ...(ifMatchRevision?.trim() ? { ifMatchRevision: ifMatchRevision.trim() } : {}),
              ...(force ? { force: true } : {}),
            },
          ],
        }),
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "mkdir") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) throw new Error("path is required for files mkdir");
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operations: [{ type: "mkdir", path: path.trim() }] }),
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "delete") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) throw new Error("path is required for files delete");
      const recursive = readBool(args.flags, "recursive", false);
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operations: [{ type: "delete", path: path.trim(), ...(recursive ? { recursive: true } : {}) }] }),
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "rename") {
      const sessionId = readSessionId(args, 2);
      const from = readFlag(args.flags, "from") ?? args.positionals[3] ?? "";
      const to = readFlag(args.flags, "to") ?? args.positionals[4] ?? "";
      if (!from.trim() || !to.trim()) {
        throw new Error("from and to are required for files rename");
      }
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operations: [{ type: "rename", from: from.trim(), to: to.trim() }] }),
      });
      outputResult(result, outputJson);
      return;
    }

    throw new Error("files requires session|catalog|events|read|write|mkdir|delete|rename");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runApprovals(args: ParsedArgs) {
  const subcommand = args.positionals[1];
  if (!subcommand || (subcommand !== "list" && subcommand !== "reply")) {
    throw new Error("approvals requires 'list' or 'reply'");
  }

  const vesloUrl =
    readFlag(args.flags, "veslo-url") ??
    process.env.VESLO_URL ??
    process.env.VESLO_SERVER_URL ??
    "";
  const hostToken = readFlag(args.flags, "host-token") ?? process.env.VESLO_HOST_TOKEN ?? "";

  if (!vesloUrl || !hostToken) {
    throw new Error("veslo-url and host-token are required for approvals");
  }

  const headers = {
    "Content-Type": "application/json",
    "X-Veslo-Host-Token": hostToken,
  };

  if (subcommand === "list") {
    const response = await fetch(`${vesloUrl.replace(/\/$/, "")}/approvals`, { headers });
    if (!response.ok) {
      throw new Error(`Failed to list approvals: ${response.status}`);
    }
    const body = await response.json();
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const approvalId = args.positionals[2];
  if (!approvalId) {
    throw new Error("approval id is required for approvals reply");
  }

  const allow = readBool(args.flags, "allow", false);
  const deny = readBool(args.flags, "deny", false);
  if (allow === deny) {
    throw new Error("use --allow or --deny");
  }

  const payload = { reply: allow ? "allow" : "deny" };
  const response = await fetch(`${vesloUrl.replace(/\/$/, "")}/approvals/${approvalId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to reply to approval: ${response.status}`);
  }
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
}

async function runStatus(args: ParsedArgs) {
  const vesloUrl = readFlag(args.flags, "veslo-url") ?? process.env.VESLO_URL ?? "";
  const opencodeUrl = readFlag(args.flags, "opencode-url") ?? process.env.OPENCODE_URL ?? "";
  const username = readFlag(args.flags, "opencode-username") ?? process.env.OPENCODE_SERVER_USERNAME;
  const password = readFlag(args.flags, "opencode-password") ?? process.env.OPENCODE_SERVER_PASSWORD;
  const outputJson = readBool(args.flags, "json", false);

  const status: Record<string, unknown> = {};

  if (vesloUrl) {
    try {
      await waitForHealthy(vesloUrl, 5000, 400);
      status.veslo = { ok: true, url: vesloUrl };
    } catch (error) {
      status.veslo = { ok: false, url: vesloUrl, error: String(error) };
    }
  }

  if (opencodeUrl) {
    try {
      const headers: Record<string, string> = {};
      if (username && password) {
        headers.Authorization = `Basic ${encodeBasicAuth(username, password)}`;
      }
      const client = createOpencodeClient({
        baseUrl: opencodeUrl,
        headers,
      });
      const health = await waitForOpencodeHealthy(client, 5000, 400);
      status.opencode = { ok: true, url: opencodeUrl, health };
    } catch (error) {
      status.opencode = { ok: false, url: opencodeUrl, error: String(error) };
    }
  }

  if (outputJson) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    if (status.veslo) {
      const vesloStatus = status.veslo as { ok: boolean; url: string; error?: string };
      console.log(`Veslo server: ${vesloStatus.ok ? "ok" : "error"} (${vesloStatus.url})`);
      if (vesloStatus.error) console.log(`  ${vesloStatus.error}`);
    }
    if (status.opencode) {
      const opencode = status.opencode as { ok: boolean; url: string; error?: string };
      console.log(`OpenCode server: ${opencode.ok ? "ok" : "error"} (${opencode.url})`);
      if (opencode.error) console.log(`  ${opencode.error}`);
    }
  }
}

async function runStart(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const checkOnly = readBool(args.flags, "check", false);
  const checkEvents = readBool(args.flags, "check-events", false);
  const verbose = readBool(args.flags, "verbose", false, "VESLO_VERBOSE");
  const logFormat = readLogFormat(args.flags, "log-format", "pretty", "VESLO_LOG_FORMAT");
  const detachRequested = readBool(args.flags, "detach", false, "VESLO_DETACH");
  const defaultTui = process.stdout.isTTY && !outputJson && !checkOnly && !checkEvents;
  const tuiRequested = readBool(args.flags, "tui", defaultTui);
  let useTui = tuiRequested && !detachRequested && !outputJson && !checkOnly && !checkEvents && logFormat === "pretty";
  const colorPreferred =
    readBool(args.flags, "color", process.stdout.isTTY, "VESLO_COLOR") && !process.env.NO_COLOR;
  const runId = readFlag(args.flags, "run-id") ?? process.env.VESLO_RUN_ID ?? randomUUID();
  const cliVersion = await resolveCliVersion();
  const compiledBinary = isCompiledBunBinary();
  let tui: TuiHandle | undefined;
  let restoreConsoleError: (() => void) | undefined;
  const baseLoggerOptions = {
    format: logFormat,
    runId,
    serviceName: "veslo-orchestrator",
    serviceVersion: cliVersion,
    onLog: (event: LogEvent) => {
      if (!tui) return;
      const component = event.component ?? "veslo-orchestrator";
      const tuiComponent = component === "veslo-code-router" ? "router" : component;
      tui.pushLog({
        time: event.time,
        level: event.level,
        component: tuiComponent,
        message: event.message,
      });
    },
  };
  let logger = createLogger({
    ...baseLoggerOptions,
    output: useTui ? "silent" : "stdout",
    color: useTui ? false : colorPreferred,
  });
  let logVerbose = createVerboseLogger(verbose && !outputJson, logger, "veslo-orchestrator");
  const switchToPlainOutput = (error: string) => {
    if (!useTui) return;
    useTui = false;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    tui?.stop();
    tui = undefined;
    logger = createLogger({
      ...baseLoggerOptions,
      output: "stdout",
      color: colorPreferred,
    });
    logVerbose = createVerboseLogger(verbose && !outputJson, logger, "veslo-orchestrator");
    logger.warn(
      "TUI failed to start; falling back to plain output. Use `veslo serve` for explicit non-TUI mode.",
      { error },
      "veslo-orchestrator",
    );
  };
  const sidecarSourceInput = readBinarySource(args.flags, "sidecar-source", "auto", "VESLO_SIDECAR_SOURCE");
  const opencodeSourceInput = readBinarySource(args.flags, "opencode-source", "auto", "VESLO_OPENCODE_SOURCE");

  const workspace = readFlag(args.flags, "workspace") ?? process.env.VESLO_WORKSPACE ?? process.cwd();
  const resolvedWorkspace = await ensureWorkspace(workspace);
  logger.info("Run starting", { workspace: resolvedWorkspace, logFormat, runId }, "veslo-orchestrator");

  const dataDir = resolveRouterDataDir(args.flags);
  const opencodeConfigDir = join(dataDir, "opencode-config", workspaceIdForLocal(resolvedWorkspace));
  await ensureOpencodeManagedTools(opencodeConfigDir);
  const opencodeRouterDataDir = join(dataDir, "veslo-code-router", workspaceIdForLocal(resolvedWorkspace));
  await mkdir(opencodeRouterDataDir, { recursive: true });

  const explicitOpencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.VESLO_OPENCODE_BIN;
  const explicitVesloServerBin = readFlag(args.flags, "veslo-server-bin") ?? process.env.VESLO_SERVER_BIN;
  const explicitOpenCodeRouterBin = readFlag(args.flags, "veslo-code-router-bin") ?? process.env.OPENCODE_ROUTER_BIN;
  const opencodeBindHost = readFlag(args.flags, "opencode-host") ?? process.env.VESLO_OPENCODE_BIND_HOST ?? "0.0.0.0";
  const opencodePort = await resolvePort(
    readNumber(args.flags, "opencode-port", undefined, "VESLO_OPENCODE_PORT"),
    "127.0.0.1",
  );
  const opencodeHotReload = readOpencodeHotReload(
    args.flags,
    {
      enabled: true,
      debounceMs: DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
      cooldownMs: DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    },
    {
      enabled: "VESLO_OPENCODE_HOT_RELOAD",
      debounceMs: "VESLO_OPENCODE_HOT_RELOAD_DEBOUNCE_MS",
      cooldownMs: "VESLO_OPENCODE_HOT_RELOAD_COOLDOWN_MS",
    },
  );
  const opencodeAuth = readBool(args.flags, "opencode-auth", true, "VESLO_OPENCODE_AUTH");
  const opencodeUsername = opencodeAuth
    ? readFlag(args.flags, "opencode-username") ?? process.env.VESLO_OPENCODE_USERNAME ?? DEFAULT_OPENCODE_USERNAME
    : undefined;
  const opencodePassword = opencodeAuth
    ? readFlag(args.flags, "opencode-password") ?? process.env.VESLO_OPENCODE_PASSWORD ?? randomUUID()
    : undefined;

  const vesloHost = readFlag(args.flags, "veslo-host") ?? process.env.VESLO_HOST ?? "0.0.0.0";
  const vesloPort = await resolvePort(
    readNumber(args.flags, "veslo-port", undefined, "VESLO_PORT"),
    "127.0.0.1",
  );
  // Always choose a free opencodeRouter health port by default (avoid conflicts with
  // other local processes using 3005).
  const opencodeRouterHealthPort = await resolvePort(
    readNumber(args.flags, "veslo-code-router-health-port", undefined, "OPENCODE_ROUTER_HEALTH_PORT"),
    "127.0.0.1",
  );
  const vesloToken = readFlag(args.flags, "veslo-token") ?? process.env.VESLO_TOKEN ?? randomUUID();
  const vesloHostToken = readFlag(args.flags, "veslo-host-token") ?? process.env.VESLO_HOST_TOKEN ?? randomUUID();
  const approvalMode =
    (readFlag(args.flags, "approval") as ApprovalMode | undefined) ??
    (process.env.VESLO_APPROVAL_MODE as ApprovalMode | undefined) ??
    "manual";
  const approvalTimeoutMs = readNumber(
    args.flags,
    "approval-timeout",
    DEFAULT_APPROVAL_TIMEOUT,
    "VESLO_APPROVAL_TIMEOUT_MS",
  ) as number;
  const readOnly = readBool(args.flags, "read-only", false, "VESLO_READONLY");
  const corsValue = readFlag(args.flags, "cors") ?? process.env.VESLO_CORS_ORIGINS ?? "*";
  const corsOrigins = parseList(corsValue);
  const connectHost = readFlag(args.flags, "connect-host");

  const manifest = await readVersionManifest();
  const allowExternal = readBool(args.flags, "allow-external", false, "VESLO_ALLOW_EXTERNAL");
  const sidecarTarget = resolveSidecarTarget();
  const sidecar = resolveSidecarConfigForTarget(args.flags, cliVersion, sidecarTarget);

  const sidecarSource = sidecarSourceInput;
  const opencodeSource = opencodeSourceInput;
  logVerbose(`cli version: ${cliVersion}`);
  logVerbose(`sidecar target: ${sidecar.target ?? "unknown"}`);
  logVerbose(`sidecar dir: ${sidecar.dir}`);
  logVerbose(`sidecar base URL: ${sidecar.baseUrl}`);
  logVerbose(`sidecar manifest: ${sidecar.manifestUrl}`);
  logVerbose(`sidecar source: ${sidecarSource}`);
  logVerbose(`opencode source: ${opencodeSource}`);
  logVerbose(
    `opencode hot reload: ${opencodeHotReload.enabled ? "on" : "off"} (debounce=${opencodeHotReload.debounceMs}ms cooldown=${opencodeHotReload.cooldownMs}ms)`,
  );
  logVerbose(`allow external: ${allowExternal ? "true" : "false"}`);
  const opencodeBinary = await resolveOpencodeBin({
    explicit: explicitOpencodeBin,
    manifest,
    allowExternal,
    sidecar,
    source: opencodeSource,
  });

  const opencodeRouterEnabled = readBool(args.flags, "veslo-code-router", true);
  const opencodeRouterRequired = readBool(
    args.flags,
    "veslo-code-router-required",
    false,
    "VESLO_OPENCODE_ROUTER_REQUIRED",
  );
  const vesloServerBinary = await resolveVesloServerBin({
    explicit: explicitVesloServerBin,
    manifest,
    allowExternal,
    sidecar,
    source: sidecarSource,
  });
  const opencodeRouterBinary = opencodeRouterEnabled
    ? await resolveOpenCodeRouterBin({
        explicit: explicitOpenCodeRouterBin,
        manifest,
        allowExternal,
        sidecar,
        source: sidecarSource,
      })
    : null;

  let opencodeRouterActualVersion: string | undefined;
  logVerbose(`opencode bin: ${opencodeBinary.bin} (${opencodeBinary.source})`);
  logVerbose(`veslo-server bin: ${vesloServerBinary.bin} (${vesloServerBinary.source})`);
  if (opencodeRouterBinary) {
    logVerbose(`opencodeRouter bin: ${opencodeRouterBinary.bin} (${opencodeRouterBinary.source})`);
  }

  const vesloBaseUrl = `http://127.0.0.1:${vesloPort}`;
  const vesloConnect = resolveConnectUrl(vesloPort, connectHost);
  const vesloConnectUrl = vesloConnect.connectUrl ?? vesloBaseUrl;

  const opencodeBaseUrl = `http://127.0.0.1:${opencodePort}`;
  const opencodeConnectUrl =
    resolveConnectUrl(opencodePort, connectHost).connectUrl ?? opencodeBaseUrl;

  const attachCommand = buildAttachCommand({
    url: opencodeConnectUrl,
    workspace: resolvedWorkspace,
    username: opencodeUsername,
    password: opencodePassword,
  });

  const opencodeRouterHealthUrl = `http://127.0.0.1:${opencodeRouterHealthPort}`;
  const opencodeRouterEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_DIRECTORY: resolvedWorkspace,
    OPENCODE_URL: opencodeConnectUrl,
    ...(opencodeUsername ? { OPENCODE_SERVER_USERNAME: opencodeUsername } : {}),
    ...(opencodePassword ? { OPENCODE_SERVER_PASSWORD: opencodePassword } : {}),
    ...(opencodeRouterEnabled ? { OPENCODE_ROUTER_HEALTH_PORT: String(opencodeRouterHealthPort) } : {}),
  };

  const children: ChildHandle[] = [];
  let shuttingDown = false;
  let detached = false;
  const startedAt = Date.now();
  let opencodeRouterHealthInterval: NodeJS.Timeout | null = null;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    if (opencodeRouterHealthInterval) {
      clearInterval(opencodeRouterHealthInterval);
      opencodeRouterHealthInterval = null;
    }
    logger.info(
      "Shutting down",
      { children: children.map((handle) => handle.name) },
      "veslo-orchestrator",
    );
    await Promise.all(children.map((handle) => stopChild(handle.child)));
  };

  const detachChildren = () => {
    detached = true;
    for (const handle of children) {
      try {
        handle.child.unref();
      } catch {
        // ignore
      }
      handle.child.stdout?.removeAllListeners();
      handle.child.stderr?.removeAllListeners();
      handle.child.stdout?.destroy();
      handle.child.stderr?.destroy();
    }
  };

  const handleQuit = async () => {
    tui?.stop();
    await shutdown();
    process.exit(0);
  };

  const handleDetach = async () => {
    if (detached) return;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    if (opencodeRouterHealthInterval) {
      clearInterval(opencodeRouterHealthInterval);
      opencodeRouterHealthInterval = null;
    }
    tui?.stop();
    detachChildren();
    const summary = [
      "Detached. Services still running:",
      ...children.map((handle) => `- ${handle.name} (pid ${handle.child.pid ?? "unknown"})`),
      `Veslo URL: ${vesloConnectUrl}`,
      `Veslo Token: ${vesloToken}`,
      `OpenCode URL: ${opencodeConnectUrl}`,
      `Attach: ${attachCommand}`,
    ].join("\n");
    process.stdout.write(`${summary}\n`);
    process.exit(0);
  };

  if (useTui) {
    if (compiledBinary) {
      const originalConsoleError = console.error.bind(console);
      restoreConsoleError = () => {
        console.error = originalConsoleError;
      };
      console.error = (...items: unknown[]) => {
        const text = items
          .map((item) => {
            if (typeof item === "string") return item;
            if (item instanceof Error) return `${item.name}: ${item.message}`;
            return String(item);
          })
          .join(" ");
        if (
          text.includes("React is not defined") ||
          text.includes("/$bunfs/root/veslo-orchestrator") ||
          text.includes("/$bunfs/root/veslo")
        ) {
          switchToPlainOutput(text);
        }
        originalConsoleError(...items);
      };
    }
    try {
      const { startOrchestratorTui } = await import("./tui/app.js");
      tui = startOrchestratorTui({
        version: cliVersion,
        connect: {
          runId,
          workspace: resolvedWorkspace,
          vesloUrl: vesloConnectUrl,
          vesloToken,
          hostToken: vesloHostToken,
          opencodeUrl: opencodeConnectUrl,
          opencodePassword: opencodePassword ?? undefined,
          opencodeUsername: opencodeUsername ?? undefined,
          attachCommand,
        },
        services: [
          { name: "opencode", label: "opencode", status: "starting", port: opencodePort },
          { name: "veslo-server", label: "veslo-server", status: "starting", port: vesloPort },
          {
            name: "router",
            label: "veslo-code-router",
            status: opencodeRouterEnabled ? "starting" : "disabled",
            port: opencodeRouterHealthPort,
          },
        ],
        onQuit: handleQuit,
        onDetach: handleDetach,
        onCopyAttach: async () => {
          const result = await copyToClipboard(attachCommand);
          return { command: attachCommand, ...result };
        },
        onCopySelection: async (text) => copyToClipboard(text),
        onRouterHealth: async () => fetchOpenCodeRouterHealthViaVeslo(vesloBaseUrl, vesloToken),
        onRouterTelegramIdentities: async () => {
          const url = `${vesloBaseUrl.replace(/\/$/, "")}/veslo-code-router/identities/telegram`;
          const result = await fetchJson(url, {
            headers: {
              "X-Veslo-Host-Token": vesloHostToken,
            },
          });
          const items = Array.isArray(result?.items) ? result.items : [];
          return { items };
        },
        onRouterSlackIdentities: async () => {
          const url = `${vesloBaseUrl.replace(/\/$/, "")}/veslo-code-router/identities/slack`;
          const result = await fetchJson(url, {
            headers: {
              "X-Veslo-Host-Token": vesloHostToken,
            },
          });
          const items = Array.isArray(result?.items) ? result.items : [];
          return { items };
        },
        onRouterSetGroupsEnabled: async (enabled) => {
          try {
            const url = `${vesloBaseUrl.replace(/\/$/, "")}/veslo-code-router/config/groups`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Veslo-Host-Token": vesloHostToken,
              },
              body: JSON.stringify({ enabled }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        onRouterSetTelegramToken: async (token) => {
          try {
            const url = `${vesloBaseUrl.replace(/\/$/, "")}/veslo-code-router/identities/telegram`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Veslo-Host-Token": vesloHostToken,
              },
              body: JSON.stringify({ id: "default", token, enabled: true }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        onRouterSetSlackTokens: async (botToken, appToken) => {
          try {
            const url = `${vesloBaseUrl.replace(/\/$/, "")}/veslo-code-router/identities/slack`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Veslo-Host-Token": vesloHostToken,
              },
              body: JSON.stringify({ id: "default", botToken, appToken, enabled: true }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      });
      tui.setUptimeStart(startedAt);
    } catch (error) {
      switchToPlainOutput(error instanceof Error ? error.message : String(error));
    }
  }

  const tuiServiceName = (name: string) => (name === "veslo-code-router" ? "router" : name);

  const handleExit = (name: string, code: number | null, signal: NodeJS.Signals | null) => {
    if (shuttingDown || detached) return;
    const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
    const services =
      name === "sandbox"
        ? ["opencode", "veslo-server", "router"]
        : [tuiServiceName(name)];
    for (const service of services) {
      tui?.updateService(service, { status: "stopped", message: reason });
    }
    logger.error("Process exited", { reason, code, signal }, name);
    void shutdown().then(() => process.exit(code ?? 1));
  };

  const handleSpawnError = (name: string, error: unknown) => {
    if (shuttingDown || detached) return;
    tui?.updateService(tuiServiceName(name), { status: "error", message: String(error) });
    logger.error("Process failed to start", { error: String(error) }, name);
    void shutdown().then(() => process.exit(1));
  };

  try {
    const opencodeActualVersion = await verifyOpencodeVersion(opencodeBinary);
    let vesloActualVersion: string | undefined;
    let opencodeClient: ReturnType<typeof createOpencodeClient>;

    {
      const opencodeChild = await startOpencode({
        bin: opencodeBinary.bin,
        workspace: resolvedWorkspace,
        configDir: opencodeConfigDir,
        hotReload: opencodeHotReload,
        bindHost: opencodeBindHost,
        port: opencodePort,
        username: opencodeUsername,
        password: opencodePassword,
        corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
        logger,
        runId,
        logFormat,
        opencodeRouterHealthPort: opencodeRouterEnabled ? opencodeRouterHealthPort : undefined,
      });
      children.push({ name: "opencode", child: opencodeChild });
      tui?.updateService("opencode", {
        status: "running",
        pid: opencodeChild.pid ?? undefined,
        port: opencodePort,
      });
      logger.info("Process spawned", { pid: opencodeChild.pid ?? 0 }, "opencode");
      opencodeChild.on("exit", (code, signal) => handleExit("opencode", code, signal));
      opencodeChild.on("error", (error) => handleSpawnError("opencode", error));

      const authHeaders: Record<string, string> = {};
      if (opencodeUsername && opencodePassword) {
        authHeaders.Authorization = `Basic ${encodeBasicAuth(opencodeUsername, opencodePassword)}`;
      }
      opencodeClient = createOpencodeClient({
        baseUrl: opencodeBaseUrl,
        directory: resolvedWorkspace,
        headers: Object.keys(authHeaders).length ? authHeaders : undefined,
      });

      logger.info("Waiting for health", { url: opencodeBaseUrl }, "opencode");
      await waitForOpencodeHealthy(opencodeClient);
      logger.info("Healthy", { url: opencodeBaseUrl }, "opencode");
      tui?.updateService("opencode", { status: "healthy" });

      let opencodeRouterChild: ChildProcess | null = null;
      let opencodeRouterReady = false;
      if (opencodeRouterEnabled) {
        if (!opencodeRouterBinary) {
          throw new Error("OpenCodeRouter binary missing.");
        }
        opencodeRouterActualVersion = await verifyOpenCodeRouterVersion(opencodeRouterBinary);
        logVerbose(`opencodeRouter version: ${opencodeRouterActualVersion ?? "unknown"}`);

        try {
          opencodeRouterChild = await startOpenCodeRouter({
            bin: opencodeRouterBinary.bin,
            workspace: resolvedWorkspace,
            opencodeUrl: opencodeConnectUrl,
            opencodeUsername,
            opencodePassword,
            opencodeRouterHealthPort,
            opencodeRouterDataDir: opencodeRouterDataDir ?? undefined,
            logger,
            runId,
            logFormat,
          });
          children.push({ name: "veslo-code-router", child: opencodeRouterChild });
          tui?.updateService("router", {
            status: "running",
            pid: opencodeRouterChild.pid ?? undefined,
            port: opencodeRouterHealthPort,
          });
          logger.info("Process spawned", { pid: opencodeRouterChild.pid ?? 0 }, "veslo-code-router");
          opencodeRouterChild.on("exit", (code, signal) => {
            if (opencodeRouterRequired) {
              handleExit("veslo-code-router", code, signal);
              return;
            }
            const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
            tui?.updateService("router", { status: "stopped", message: reason });
            logger.warn("Process exited, continuing without opencodeRouter", { reason, code, signal }, "veslo-code-router");
          });
          opencodeRouterChild.on("error", (error) => handleSpawnError("veslo-code-router", error));

          const healthBaseUrl = `http://127.0.0.1:${opencodeRouterHealthPort}`;
          logger.info("Waiting for health", { url: healthBaseUrl }, "veslo-code-router");
          const health = await waitForOpenCodeRouterHealthy(healthBaseUrl, 10_000, 400);
          tui?.setRouterHealth(health);
          tui?.updateService("router", { status: health.ok ? "healthy" : "running" });
          logger.info("Healthy", { url: healthBaseUrl, ok: health.ok }, "veslo-code-router");
          opencodeRouterReady = true;
        } catch (error) {
          if (opencodeRouterRequired) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("OpenCodeRouter failed to start, continuing without it", { error: message }, "veslo-code-router");
          tui?.updateService("router", { status: "stopped", message });
          if (opencodeRouterChild) {
            try {
              opencodeRouterChild.kill();
            } catch {
              // ignore
            }
          }
          opencodeRouterChild = null;
          opencodeRouterReady = false;
        }
      }

      const vesloChild = await startVesloServer({
        bin: vesloServerBinary.bin,
        host: vesloHost,
        port: vesloPort,
        workspace: resolvedWorkspace,
        token: vesloToken,
        hostToken: vesloHostToken,
        approvalMode: approvalMode === "auto" ? "auto" : "manual",
        approvalTimeoutMs,
        readOnly,
        corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
        opencodeBaseUrl: opencodeConnectUrl,
        opencodeDirectory: resolvedWorkspace,
        opencodeUsername,
        opencodePassword,
        opencodeRouterHealthPort: opencodeRouterReady ? opencodeRouterHealthPort : undefined,
        opencodeRouterDataDir: opencodeRouterReady ? (opencodeRouterDataDir ?? undefined) : undefined,
        logger,
        runId,
        logFormat,
      });
      children.push({ name: "veslo-server", child: vesloChild });
      tui?.updateService("veslo-server", {
        status: "running",
        pid: vesloChild.pid ?? undefined,
        port: vesloPort,
      });
      logger.info("Process spawned", { pid: vesloChild.pid ?? 0 }, "veslo-server");
      vesloChild.on("exit", (code, signal) => handleExit("veslo-server", code, signal));
      vesloChild.on("error", (error) => handleSpawnError("veslo-server", error));

      logger.info("Waiting for health", { url: vesloBaseUrl }, "veslo-server");
      await waitForHealthy(vesloBaseUrl);
      logger.info("Healthy", { url: vesloBaseUrl }, "veslo-server");
      tui?.updateService("veslo-server", { status: "healthy" });

      vesloActualVersion = await verifyVesloServer({
        baseUrl: vesloBaseUrl,
        token: vesloToken,
        hostToken: vesloHostToken,
        expectedVersion: vesloServerBinary.expectedVersion,
        expectedWorkspace: resolvedWorkspace,
        expectedOpencodeBaseUrl: opencodeConnectUrl,
        expectedOpencodeDirectory: resolvedWorkspace,
        expectedOpencodeUsername: opencodeUsername,
        expectedOpencodePassword: opencodePassword,
      });
      logVerbose(`veslo-server version: ${vesloActualVersion ?? "unknown"}`);

      if (opencodeRouterReady && !opencodeRouterHealthInterval) {
        opencodeRouterHealthInterval = setInterval(() => {
          fetchOpenCodeRouterHealthViaVeslo(vesloBaseUrl, vesloToken)
            .then((health) => {
              tui?.setRouterHealth(health);
              if (health.ok) {
                tui?.updateService("router", { status: "healthy" });
              }
            })
            .catch(() => undefined);
        }, 15_000);
      }
    }

    const payload = {
      runId,
      workspace: resolvedWorkspace,
      approval: {
        mode: approvalMode,
        timeoutMs: approvalTimeoutMs,
        readOnly,
      },
      opencode: {
        baseUrl: opencodeBaseUrl,
        connectUrl: opencodeConnectUrl,
        username: opencodeUsername,
        password: opencodePassword,
        bindHost: opencodeBindHost,
        port: opencodePort,
        hotReload: opencodeHotReload,
        version: opencodeActualVersion,
      },
      veslo: {
        baseUrl: vesloBaseUrl,
        connectUrl: vesloConnectUrl,
        host: vesloHost,
        port: vesloPort,
        token: vesloToken,
        hostToken: vesloHostToken,
        version: vesloActualVersion,
      },
      opencodeRouter: {
        enabled: opencodeRouterEnabled,
        version: opencodeRouterEnabled ? opencodeRouterActualVersion : undefined,
        healthPort: opencodeRouterHealthPort,
      },
      diagnostics: {
        cliVersion,
        sidecar: {
          dir: sidecar.dir,
          baseUrl: sidecar.baseUrl,
          manifestUrl: sidecar.manifestUrl,
          target: sidecar.target,
          source: sidecarSource,
          opencodeSource,
          allowExternal,
        } as SidecarDiagnostics,
        binaries: {
          opencode: {
            path: opencodeBinary.bin,
            source: opencodeBinary.source,
            expectedVersion: opencodeBinary.expectedVersion,
            actualVersion: opencodeActualVersion,
          } as BinaryDiagnostics,
          vesloServer: {
            path: vesloServerBinary.bin,
            source: vesloServerBinary.source,
            expectedVersion: vesloServerBinary.expectedVersion,
            actualVersion: vesloActualVersion,
          } as BinaryDiagnostics,
          opencodeRouter: opencodeRouterBinary
            ? ({
                path: opencodeRouterBinary.bin,
                source: opencodeRouterBinary.source,
                expectedVersion: opencodeRouterBinary.expectedVersion,
                actualVersion: opencodeRouterActualVersion,
              } as BinaryDiagnostics)
            : null,
        },
      },
    };

    const safePayload = sanitizeRuntimePayloadForLogs(payload);

    if (outputJson) {
      console.log(JSON.stringify(safePayload, null, 2));
    } else if (useTui) {
      logger.info(
        "Ready",
        {
          workspace: safePayload.workspace,
          opencode: safePayload.opencode,
          veslo: safePayload.veslo,
          opencodeRouter: safePayload.opencodeRouter,
        },
        "veslo-orchestrator",
      );
    } else if (logFormat === "json") {
      logger.info(
        "Ready",
        {
          workspace: safePayload.workspace,
          opencode: safePayload.opencode,
          veslo: safePayload.veslo,
          opencodeRouter: safePayload.opencodeRouter,
        },
        "veslo-orchestrator",
      );
    } else {
      console.log("Veslo orchestrator running");
      console.log(`Run ID: ${safePayload.runId}`);
      console.log(`Workspace: ${safePayload.workspace}`);
      console.log(`OpenCode: ${safePayload.opencode.baseUrl}`);
      console.log(`OpenCode connect URL: ${safePayload.opencode.connectUrl}`);
      if (safePayload.opencode.username) {
        console.log("OpenCode auth: configured");
      }
      console.log(`Veslo server: ${safePayload.veslo.baseUrl}`);
      console.log(`Veslo connect URL: ${safePayload.veslo.connectUrl}`);
      console.log("Client token: [REDACTED]");
      console.log("Host token: [REDACTED]");
    }

    if (detachRequested) {
      await handleDetach();
    }

    if (checkOnly) {
      try {
        await runChecks({
          opencodeClient,
          vesloUrl: vesloBaseUrl,
          vesloToken,
          hostToken: vesloHostToken,
          checkEvents,
        });
        logger.info("Checks ok", { checkEvents }, "veslo-orchestrator");
        if (!outputJson && logFormat === "pretty") {
          console.log("Checks: ok");
        }
      } catch (error) {
        logger.error("Checks failed", { error: String(error) }, "veslo-orchestrator");
        await shutdown();
        tui?.stop();
        process.exit(1);
      }
      await shutdown();
      tui?.stop();
      process.exit(0);
    }

    process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
    process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
    await new Promise(() => undefined);
  } catch (error) {
    await shutdown();
    tui?.stop();
    logger.error(
      "Run failed",
      { error: error instanceof Error ? error.message : String(error) },
      "veslo-orchestrator",
    );
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (readBool(args.flags, "help", false) || args.flags.get("help") === true) {
    printHelp();
    return;
  }
  if (readBool(args.flags, "version", false) || args.flags.get("version") === true) {
    console.log(await resolveCliVersion());
    return;
  }

  const command = args.positionals[0] ?? "start";
  if (command === "start") {
    await runStart(args);
    return;
  }
  if (command === "serve") {
    args.flags.set("tui", false);
    await runStart(args);
    return;
  }
  if (command === "daemon") {
    await runDaemonCommand(args);
    return;
  }
  if (command === "workspace" || command === "workspaces") {
    await runWorkspaceCommand(args);
    return;
  }
  if (command === "instance") {
    await runInstanceCommand(args);
    return;
  }
  if (command === "approvals") {
    await runApprovals(args);
    return;
  }
  if (command === "files") {
    await runFiles(args);
    return;
  }
  if (command === "status") {
    await runStatus(args);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
