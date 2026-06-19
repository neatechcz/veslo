import { dirname, join, posix, win32 } from "node:path";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { randomUUID } from "node:crypto";
import type { AuditEntry } from "./types.js";
import type { DebugLogPipeline } from "./debug-log-pipeline.js";
import { ensureDir, exists } from "./utils.js";

let auditDebugPipeline: DebugLogPipeline | null = null;
const attemptedLegacyDataDirMigrations = new Set<string>();
const legacyDataDirMigrationFallbacks = new Set<string>();

export function setAuditDebugLogPipeline(pipeline: DebugLogPipeline | null): void {
  auditDebugPipeline = pipeline;
}

export function resolveVesloDataDir(): string {
  const override = process.env.VESLO_DATA_DIR?.trim();
  if (override) return expandHome(override);
  const home = homedir();
  const os = platform();
  const defaultDir = resolveDefaultVesloDataDir({
    env: process.env,
    home,
    platform: os,
  });
  if (os !== "win32") return defaultDir;
  return resolveVesloDataDirWithLegacyMigration(
    defaultDir,
    resolveLegacyVesloDataDir({ home, platform: os }),
  );
}

export function resolveVesloDataDirWithLegacyMigration(defaultDir: string, legacyDir: string): string {
  const target = defaultDir.trim();
  const legacy = legacyDir.trim();
  const targetKey = normalizeDataDirKey(target);
  const legacyKey = normalizeDataDirKey(legacy);
  if (!target || !legacy || targetKey === legacyKey) return target || legacy;
  if (!existsSync(legacy)) return target;

  const migrationKey = `${targetKey}\u0000${legacyKey}`;
  if (attemptedLegacyDataDirMigrations.has(migrationKey)) {
    return legacyDataDirMigrationFallbacks.has(migrationKey) ? legacy : target;
  }
  attemptedLegacyDataDirMigrations.add(migrationKey);

  try {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(legacy, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    return target;
  } catch {
    legacyDataDirMigrationFallbacks.add(migrationKey);
    return legacy;
  }
}

export function resolveLegacyVesloDataDir(input: {
  home: string;
  platform: NodeJS.Platform;
}): string {
  if (input.platform === "win32") {
    return win32.join(input.home, ".veslo", "veslo-server");
  }
  return posix.join(input.home, ".veslo", "veslo-server");
}

function normalizeDataDirKey(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function resolveDefaultVesloDataDir(input: {
  env?: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}): string {
  if (input.platform === "win32") {
    const appDataRoot = input.env?.LOCALAPPDATA?.trim()
      || input.env?.APPDATA?.trim()
      || win32.join(input.home, "AppData", "Local");
    return win32.join(appDataRoot, "com.neatech.veslo", "veslo-server");
  }
  return resolveLegacyVesloDataDir(input);
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function auditLogPath(workspaceId: string): string {
  return join(resolveVesloDataDir(), "audit", `${workspaceId}.jsonl`);
}

export function legacyAuditLogPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "audit.jsonl");
}

async function resolveReadableAuditPath(workspaceRoot: string, workspaceId: string): Promise<string | null> {
  const primary = auditLogPath(workspaceId);
  if (await exists(primary)) return primary;
  const legacy = legacyAuditLogPath(workspaceRoot);
  if (await exists(legacy)) return legacy;
  return null;
}

export async function recordAudit(workspaceRoot: string, entry: AuditEntry): Promise<void> {
  const workspaceId = entry.workspaceId?.trim();
  if (!workspaceId) {
    const path = legacyAuditLogPath(workspaceRoot);
    await ensureDir(dirname(path));
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  } else {
    const path = auditLogPath(workspaceId);
    await ensureDir(dirname(path));
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  }

  const pipeline = auditDebugPipeline;
  if (pipeline) {
    void pipeline.append({
      id: randomUUID(),
      userId: "",
      orgId: "",
      workspaceId: workspaceId ?? "",
      source: "audit",
      stream: "jsonl",
      timestamp: Date.now() * 1_000_000,
      sequenceNo: 0,
      payload: entry as unknown as Record<string, unknown>,
    }).catch(() => undefined);
  }
}

export async function readLastAudit(workspaceRoot: string, workspaceId: string): Promise<AuditEntry | null> {
  const path = await resolveReadableAuditPath(workspaceRoot, workspaceId);
  if (!path) return null;
  const content = await readFile(path, "utf8");
  const lines = content.trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last) as AuditEntry;
  } catch {
    return null;
  }
}

export async function readAuditEntries(
  workspaceRoot: string,
  workspaceId: string,
  limit = 50,
): Promise<AuditEntry[]> {
  const path = await resolveReadableAuditPath(workspaceRoot, workspaceId);
  if (!path) return [];
  const content = await readFile(path, "utf8");
  const rawLines = content.trim().split("\n").filter(Boolean);
  if (!rawLines.length) return [];
  const slice = rawLines.slice(-Math.max(1, limit));
  const entries: AuditEntry[] = [];
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    try {
      entries.push(JSON.parse(slice[i]) as AuditEntry);
    } catch {
      // ignore malformed entry
    }
  }
  return entries;
}
