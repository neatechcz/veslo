import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { materializeCodexAuthJson } from "../providers/codex-cli-worker-transport.js";

export type CodexUsageStatusSource = "codex_exec_rate_limits" | "codex_status" | "codex_login_status" | "unavailable";

export type CodexUsageLimitWindow = {
  label: string;
  usedPercent: number | null;
  windowMinutes: number;
  resetAt: string | null;
};

export type CodexUsageStatus = {
  available: boolean;
  source: CodexUsageStatusSource;
  label: string;
  detail?: string | null;
  checkedAt?: string | null;
  planType?: string | null;
  limits?: {
    fiveHour: CodexUsageLimitWindow | null;
    weekly: CodexUsageLimitWindow | null;
  } | null;
};

export type CodexCredentialStatusInput = {
  credentialId: string;
  credentialName: string;
};

export interface CodexCredentialStatusProvider {
  getStatus(input: CodexCredentialStatusInput): Promise<CodexUsageStatus>;
}

type CodexRateLimitWindowSnapshot = {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | null;
};

export type CodexRateLimitsSnapshot = {
  primary?: CodexRateLimitWindowSnapshot | null;
  secondary?: CodexRateLimitWindowSnapshot | null;
  plan_type?: string | null;
};

type CachedStatusEntry = {
  expiresAt: number;
  status: CodexUsageStatus;
};

type ProbeResult = {
  checkedAt: string;
  rateLimits: CodexRateLimitsSnapshot | null;
  detail?: string | null;
};

export type CachedCodexCredentialStatusProviderDeps = {
  loadCredentialAuthJson: (credentialId: string) => Promise<string | null>;
  probe?: (input: {
    credentialId: string;
    credentialName: string;
    authJson: string;
  }) => Promise<ProbeResult>;
  command?: string;
  workDir?: string;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => Date;
};

export class UnavailableCodexCredentialStatusProvider implements CodexCredentialStatusProvider {
  async getStatus(): Promise<CodexUsageStatus> {
    return unavailableStatus("Codex status probe is not configured.");
  }
}

export class CachedCodexCredentialStatusProvider implements CodexCredentialStatusProvider {
  private readonly loadCredentialAuthJson: (credentialId: string) => Promise<string | null>;
  private readonly probe: (input: {
    credentialId: string;
    credentialName: string;
    authJson: string;
  }) => Promise<ProbeResult>;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CachedStatusEntry>();

  constructor(deps: CachedCodexCredentialStatusProviderDeps) {
    this.loadCredentialAuthJson = deps.loadCredentialAuthJson;
    this.ttlMs = deps.ttlMs ?? parseTimeoutMs(process.env.AI_GATEWAY_CODEX_STATUS_TTL_MS, 5 * 60 * 1000);
    this.now = deps.now ?? (() => new Date());
    this.probe =
      deps.probe ??
      ((input) =>
        runCodexExecRateLimitProbe({
          ...input,
          command: deps.command?.trim() || process.env.AI_GATEWAY_CODEX_COMMAND?.trim() || "codex",
          workDir: deps.workDir?.trim() || process.env.AI_GATEWAY_CODEX_WORKDIR?.trim() || tmpdir(),
          timeoutMs: deps.timeoutMs ?? parseTimeoutMs(process.env.AI_GATEWAY_CODEX_TIMEOUT_MS, 120000),
          now: this.now,
        }));
  }

  async getStatus(input: CodexCredentialStatusInput): Promise<CodexUsageStatus> {
    const cached = this.cache.get(input.credentialId);
    const nowMs = this.now().getTime();
    if (cached && cached.expiresAt > nowMs) {
      return cached.status;
    }

    let status = unavailableStatus("Credential is missing Codex auth.json.");
    try {
      const authJson = await this.loadCredentialAuthJson(input.credentialId);
      if (!authJson?.trim()) {
        status = unavailableStatus("Credential is missing Codex auth.json.");
      } else {
        const result = await this.probe({
          credentialId: input.credentialId,
          credentialName: input.credentialName,
          authJson,
        });
        status = result.rateLimits
          ? codexUsageStatusFromRateLimits(result.rateLimits, result.checkedAt, result.detail)
          : unavailableStatus(result.detail || "Codex probe did not return rate limits.", result.checkedAt);
      }
    } catch (error) {
      status = unavailableStatus(
        error instanceof Error && error.message ? error.message : "Codex probe failed.",
        this.now().toISOString(),
      );
    }

    this.cache.set(input.credentialId, {
      expiresAt: nowMs + this.ttlMs,
      status,
    });
    return status;
  }
}

export function parseCodexStatusText(
  text: string,
  checkedAt: string,
): CodexUsageStatus {
  const normalized = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const limitLine = normalized.find((line) => /limit|remaining|reset|usage/i.test(line));

  return {
    available: true,
    source: "codex_status",
    label: limitLine || normalized[0] || "Codex status available",
    detail: normalized.length > 0 ? normalized.slice(0, 6).join(" | ") : null,
    checkedAt,
  };
}

export function codexUsageStatusFromRateLimits(
  snapshot: CodexRateLimitsSnapshot,
  checkedAt: string,
  detail?: string | null,
): CodexUsageStatus {
  const windows = [snapshot.primary, snapshot.secondary]
    .filter(Boolean)
    .map((entry) => toUsageLimitWindow(entry ?? null))
    .filter((entry): entry is CodexUsageLimitWindow => entry !== null);
  const fiveHour = windows.find((entry) => entry.windowMinutes === 300) ?? null;
  const weekly = windows.find((entry) => entry.windowMinutes === 10080) ?? null;

  return {
    available: true,
    source: "codex_exec_rate_limits",
    label: "Codex limits available",
    detail: detail ?? null,
    checkedAt,
    planType: snapshot.plan_type ?? null,
    limits: {
      fiveHour,
      weekly,
    },
  };
}

export function parseRateLimitsFromSessionLog(text: string): CodexRateLimitsSnapshot | null {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] ?? "");
      const payload = getRecord(parsed, "payload");
      const tokenType = getString(payload, "type");
      if (tokenType === "token_count") {
        const snapshot = readRateLimitsSnapshot(getRecord(payload, "info")?.rate_limits);
        if (snapshot) {
          return snapshot;
        }
      }

      const fallback = findRateLimitsSnapshot(parsed);
      if (fallback) {
        return fallback;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function readRateLimitsSnapshot(value: unknown): CodexRateLimitsSnapshot | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }

  return {
    primary: readRateLimitWindow(record.primary),
    secondary: readRateLimitWindow(record.secondary),
    plan_type: getString(record, "plan_type"),
  };
}

function findRateLimitsSnapshot(value: unknown, depth = 0): CodexRateLimitsSnapshot | null {
  if (depth > 6) {
    return null;
  }

  const record = getRecord(value);
  if (!record) {
    return null;
  }

  const direct = readRateLimitsSnapshot(record.rate_limits);
  if (direct) {
    return direct;
  }

  for (const key of ["payload", "info", "message", "data", "event", "metadata"]) {
    const nested = findRateLimitsSnapshot(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function readRateLimitWindow(value: unknown): CodexRateLimitWindowSnapshot | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }

  return {
    used_percent: getNumber(record, "used_percent"),
    window_minutes: getNumber(record, "window_minutes"),
    resets_at: getNumber(record, "resets_at"),
  };
}

function toUsageLimitWindow(snapshot: CodexRateLimitWindowSnapshot | null): CodexUsageLimitWindow | null {
  if (!snapshot) {
    return null;
  }

  const windowMinutes = Number.isFinite(snapshot.window_minutes) ? Number(snapshot.window_minutes) : 0;
  if (windowMinutes <= 0) {
    return null;
  }

  return {
    label: formatWindowLabel(windowMinutes),
    usedPercent: Number.isFinite(snapshot.used_percent) ? Number(snapshot.used_percent) : null,
    windowMinutes,
    resetAt:
      Number.isFinite(snapshot.resets_at) && Number(snapshot.resets_at) > 0
        ? new Date(Number(snapshot.resets_at) * 1000).toISOString()
        : null,
  };
}

async function runCodexExecRateLimitProbe(input: {
  credentialId: string;
  credentialName: string;
  authJson: string;
  command: string;
  workDir: string;
  timeoutMs: number;
  now: () => Date;
}): Promise<ProbeResult> {
  const checkedAt = input.now().toISOString();
  const codexHome = await mkdtemp(path.join(input.workDir, "veslo-codex-status-home-"));
  const scratchDir = await mkdtemp(path.join(input.workDir, "veslo-codex-status-work-"));
  const outputFile = path.join(scratchDir, "last-message.txt");

  try {
    await materializeCodexAuthJson({
      codexHome,
      authJson: input.authJson,
    });

    const result = await runProcess({
      command: input.command,
      args: [
        "--ask-for-approval",
        "never",
        "exec",
        "--cd",
        scratchDir,
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-last-message",
        outputFile,
        "Reply with exactly OK.",
      ],
      cwd: scratchDir,
      codexHome,
      timeoutMs: input.timeoutMs,
    });

    const rateLimits = await readLatestRateLimitsSnapshot(codexHome);
    if (rateLimits) {
      return {
        checkedAt,
        rateLimits,
        detail: summarizeProbeDetail(result),
      };
    }

    return {
      checkedAt,
      rateLimits: null,
      detail: summarizeProbeFailure(result, "Codex rate limit snapshot was not found."),
    };
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function readLatestRateLimitsSnapshot(codexHome: string): Promise<CodexRateLimitsSnapshot | null> {
  const sessionRoot = path.join(codexHome, "sessions");
  const files = await listJsonlFiles(sessionRoot).catch(() => []);
  if (files.length === 0) {
    return null;
  }

  const withStats = await Promise.all(
    files.map(async (file) => ({
      file,
      stat: await readFile(file, "utf8"),
    })),
  );

  for (const entry of withStats.reverse()) {
    const snapshot = parseRateLimitsFromSessionLog(entry.stat);
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(resolved)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(resolved);
    }
  }

  return files.sort();
}

function summarizeProbeDetail(result: ProcessResult): string | null {
  const stderrTail = summarizeText(result.stderr);
  if (stderrTail) {
    return stderrTail;
  }
  return result.exitCode === 0 ? null : `Probe exited with code ${String(result.exitCode)}.`;
}

function summarizeProbeFailure(result: ProcessResult, fallback: string): string {
  const stderrTail = summarizeText(result.stderr);
  if (stderrTail) {
    return stderrTail;
  }
  if (result.timedOut) {
    return "Codex status probe timed out.";
  }
  if (result.exitCode !== 0) {
    return `Codex status probe exited with code ${String(result.exitCode)}.`;
  }
  return fallback;
}

function summarizeText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" | ")
    .slice(-400);
}

function unavailableStatus(detail: string, checkedAt: string | null = null): CodexUsageStatus {
  return {
    available: false,
    source: "unavailable",
    label: "Codex limits unavailable",
    detail,
    checkedAt,
    limits: {
      fiveHour: null,
      weekly: null,
    },
  };
}

function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 300) {
    return "5h";
  }
  if (windowMinutes === 10080) {
    return "Weekly";
  }
  return `${Math.max(1, Math.round(windowMinutes / 60))}h`;
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getRecord(value: unknown, key?: string): Record<string, unknown> | null {
  const resolved = key ? getRecord((value as Record<string, unknown> | null)?.[key]) : value;
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    return null;
  }
  return resolved as Record<string, unknown>;
}

function getString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  codexHome: string;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        CODEX_HOME: input.codexHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    }, input.timeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: 1,
        signal: null,
        timedOut,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}
