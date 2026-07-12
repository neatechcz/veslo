import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CODEX_DEFAULT_MODEL } from "../providers/codex-model-catalog.js";
import { resolveCodexCliCommandSpec, type CodexCliCommandSpec } from "../providers/codex-command.js";
import { materializeCodexAuthJson } from "../providers/codex-cli-worker-transport.js";

export type CodexUsageStatusSource =
  | "codex_exec_rate_limits"
  | "codex_exec_no_rate_limits"
  | "codex_status"
  | "codex_login_status"
  | "unavailable";

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
  unsupportedModels?: string[];
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
  signal?: AbortSignal;
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
  ok?: boolean;
  detail?: string | null;
  updatedAuthJson?: string | null;
};

export type CachedCodexCredentialStatusProviderDeps = {
  loadCredentialAuthJson: (credentialId: string) => Promise<string | null>;
  saveCredentialAuthJson?: (credentialId: string, authJson: string) => Promise<void>;
  probe?: (input: {
    credentialId: string;
    credentialName: string;
    authJson: string;
    signal?: AbortSignal;
  }) => Promise<ProbeResult>;
  command?: string;
  commandArgsPrefix?: string[];
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

export class CodexStatusProbeAbortedError extends Error {
  constructor() {
    super("Codex status probe was aborted.");
    this.name = "CodexStatusProbeAbortedError";
  }
}

export class CachedCodexCredentialStatusProvider implements CodexCredentialStatusProvider {
  private readonly loadCredentialAuthJson: (credentialId: string) => Promise<string | null>;
  private readonly saveCredentialAuthJson: ((credentialId: string, authJson: string) => Promise<void>) | null;
  private readonly probe: (input: {
    credentialId: string;
    credentialName: string;
    authJson: string;
    signal?: AbortSignal;
  }) => Promise<ProbeResult>;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CachedStatusEntry>();
  private readonly inFlight = new Map<string, Promise<CodexUsageStatus>>();

  constructor(deps: CachedCodexCredentialStatusProviderDeps) {
    this.loadCredentialAuthJson = deps.loadCredentialAuthJson;
    this.saveCredentialAuthJson = deps.saveCredentialAuthJson ?? null;
    this.ttlMs = deps.ttlMs ?? parseTimeoutMs(process.env.AI_GATEWAY_CODEX_STATUS_TTL_MS, 5 * 60 * 1000);
    this.now = deps.now ?? (() => new Date());
    this.probe =
      deps.probe ??
      ((input) =>
        {
          const commandSpec = resolveCodexCliCommandSpec(deps.command ?? process.env.AI_GATEWAY_CODEX_COMMAND);
          return runCodexExecRateLimitProbe({
            ...input,
            command: {
              command: commandSpec.command,
              argsPrefix: deps.commandArgsPrefix ?? commandSpec.argsPrefix,
            },
            workDir: deps.workDir?.trim() || process.env.AI_GATEWAY_CODEX_WORKDIR?.trim() || tmpdir(),
            timeoutMs: deps.timeoutMs ?? parseTimeoutMs(process.env.AI_GATEWAY_CODEX_TIMEOUT_MS, 120000),
            now: this.now,
          });
        });
  }

  async getStatus(input: CodexCredentialStatusInput): Promise<CodexUsageStatus> {
    throwIfCodexStatusProbeAborted(input.signal);
    const cached = this.cache.get(input.credentialId);
    const nowMs = this.now().getTime();
    if (cached && cached.expiresAt > nowMs) {
      return cached.status;
    }

    const refreshStatus = async () => {
      let status = unavailableStatus("Credential is missing Codex auth.json.");
      try {
        const authJson = await this.loadCredentialAuthJson(input.credentialId);
        throwIfCodexStatusProbeAborted(input.signal);
        if (!authJson?.trim()) {
          status = unavailableStatus("Credential is missing Codex auth.json.");
        } else {
          const result = await this.probe({
            credentialId: input.credentialId,
            credentialName: input.credentialName,
            authJson,
            signal: input.signal,
          });
          throwIfCodexStatusProbeAborted(input.signal);
          await this.persistUpdatedAuthJson(input.credentialId, authJson, result.updatedAuthJson);
          throwIfCodexStatusProbeAborted(input.signal);
          const unsupportedModels = extractUnsupportedCodexModels(result.detail);
          const usageLimitStatus = result.rateLimits
            ? null
            : codexUsageStatusFromUsageLimitFailure(result.detail, result.checkedAt);
          status = result.rateLimits
            ? codexUsageStatusFromRateLimits(result.rateLimits, result.checkedAt, result.detail)
            : usageLimitStatus
              ? usageLimitStatus
            : result.ok === true || unsupportedModels.length > 0
              ? codexUsageStatusUnknownLimits(result.checkedAt, result.detail, unsupportedModels)
              : unavailableStatus(result.detail || "Codex probe did not return rate limits.", result.checkedAt);
        }
      } catch (error) {
        if (error instanceof CodexStatusProbeAbortedError || input.signal?.aborted) {
          throw new CodexStatusProbeAbortedError();
        }
        status = unavailableStatus(
          error instanceof Error && error.message ? error.message : "Codex probe failed.",
          this.now().toISOString(),
        );
      }

      throwIfCodexStatusProbeAborted(input.signal);
      this.cache.set(input.credentialId, {
        expiresAt: nowMs + this.ttlMs,
        status,
      });
      return status;
    };

    // A caller-owned signal must never cancel or join a probe owned by another caller.
    // Signal-aware aggregate checks therefore run independently from the shared refresh.
    if (input.signal) {
      return refreshStatus();
    }

    const current = this.inFlight.get(input.credentialId);
    if (current) {
      return current;
    }

    const refresh = refreshStatus();
    this.inFlight.set(input.credentialId, refresh);

    try {
      return await refresh;
    } finally {
      this.inFlight.delete(input.credentialId);
    }
  }

  private async persistUpdatedAuthJson(
    credentialId: string,
    previousAuthJson: string,
    updatedAuthJson: string | null | undefined,
  ): Promise<void> {
    const nextAuthJson = updatedAuthJson?.trim();
    if (!this.saveCredentialAuthJson || !nextAuthJson || nextAuthJson === previousAuthJson.trim()) {
      return;
    }

    await this.saveCredentialAuthJson(credentialId, nextAuthJson);
  }
}

function throwIfCodexStatusProbeAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CodexStatusProbeAbortedError();
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

function codexUsageStatusUnknownLimits(
  checkedAt: string,
  detail?: string | null,
  unsupportedModels: string[] = [],
): CodexUsageStatus {
  return {
    available: true,
    source: "codex_exec_no_rate_limits",
    label: "Codex OK, limits unknown",
    detail: detail ?? null,
    ...(unsupportedModels.length > 0 ? { unsupportedModels } : {}),
    checkedAt,
    limits: {
      fiveHour: null,
      weekly: null,
    },
  };
}

function extractUnsupportedCodexModels(detail: string | null | undefined): string[] {
  const text = detail?.trim();
  if (!text || !/model is not supported/i.test(text)) {
    return [];
  }

  const models = new Set<string>();
  const quotedPattern = /['"`]([a-z0-9][a-z0-9._:-]*)['"`]\s+model is not supported/gi;
  for (const match of text.matchAll(quotedPattern)) {
    if (match[1]) {
      models.add(match[1]);
    }
  }

  const unquotedPattern = /\b([a-z0-9][a-z0-9._:-]*)['"`]?\s+model is not supported/gi;
  for (const match of text.matchAll(unquotedPattern)) {
    if (match[1] && !["the", "a", "this"].includes(match[1].toLowerCase())) {
      models.add(match[1]);
    }
  }

  return Array.from(models);
}

function codexUsageStatusFromUsageLimitFailure(
  detail: string | null | undefined,
  checkedAt: string,
): CodexUsageStatus | null {
  const normalized = detail?.trim();
  if (!normalized || !isCodexUsageLimitFailure(normalized)) {
    return null;
  }

  return codexUsageStatusFromRateLimits(
    {
      primary: {
        used_percent: 100,
        window_minutes: 300,
        resets_at: null,
      },
      secondary: null,
      plan_type: null,
    },
    checkedAt,
    normalized,
  );
}

function isCodexUsageLimitFailure(statusText: string): boolean {
  return /you(?:'|’)?ve hit your usage limit|hit your usage limit/i.test(statusText);
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

      const fallback = findRateLimitsSnapshot(parsed, 0, false);
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

  const primary = readRateLimitWindow(record.primary);
  const secondary = readRateLimitWindow(record.secondary);
  if (!primary && !secondary) {
    return null;
  }

  return {
    primary,
    secondary,
    plan_type: getString(record, "plan_type"),
  };
}

function findRateLimitsSnapshot(value: unknown, depth = 0, allowDirect = true): CodexRateLimitsSnapshot | null {
  if (depth > 6) {
    return null;
  }

  const record = getRecord(value);
  if (!record) {
    return null;
  }

  if (allowDirect) {
    const direct = readRateLimitsSnapshot(record.rate_limits);
    if (direct) {
      return direct;
    }
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

  const windowMinutes = getNumber(record, "window_minutes");
  if (!Number.isFinite(windowMinutes) || Number(windowMinutes) <= 0) {
    return null;
  }

  return {
    used_percent: getNumber(record, "used_percent"),
    window_minutes: windowMinutes,
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
  command: CodexCliCommandSpec;
  workDir: string;
  timeoutMs: number;
  now: () => Date;
  signal?: AbortSignal;
}): Promise<ProbeResult> {
  const checkedAt = input.now().toISOString();
  let codexHome: string | null = null;
  let scratchDir: string | null = null;

  try {
    throwIfCodexStatusProbeAborted(input.signal);
    codexHome = await mkdtemp(path.join(input.workDir, "veslo-codex-status-home-"));
    throwIfCodexStatusProbeAborted(input.signal);
    scratchDir = await mkdtemp(path.join(input.workDir, "veslo-codex-status-work-"));
    throwIfCodexStatusProbeAborted(input.signal);
    const outputFile = path.join(scratchDir, "last-message.txt");
    await materializeCodexAuthJson({
      codexHome,
      authJson: input.authJson,
    });

    const result = await runProcess({
      command: input.command.command,
      args: [
        ...input.command.argsPrefix,
        "--ask-for-approval",
        "never",
        "exec",
        "--model",
        CODEX_DEFAULT_MODEL,
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
      signal: input.signal,
    });
    const updatedAuthJson = await readUpdatedCodexAuthJson(codexHome, input.authJson);

    const rateLimits = await readLatestRateLimitsSnapshot(codexHome);
    if (rateLimits) {
      return {
        checkedAt,
        rateLimits,
        ok: result.exitCode === 0 && !result.timedOut,
        detail: summarizeProbeDetail(result),
        updatedAuthJson,
      };
    }

    return {
      checkedAt,
      rateLimits: null,
      ok: result.exitCode === 0 && !result.timedOut,
      detail: summarizeProbeFailure(result, "Codex rate limit snapshot was not found."),
      updatedAuthJson,
    };
  } finally {
    await Promise.all(
      [codexHome, scratchDir]
        .filter((directory): directory is string => directory !== null)
        .map((directory) => removeTemporaryProbeDirectory(directory)),
    );
  }
}

async function removeTemporaryProbeDirectory(directory: string): Promise<void> {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  }).catch(() => {});
}

async function readUpdatedCodexAuthJson(codexHome: string, previousAuthJson: string): Promise<string | null> {
  const authPath = path.join(codexHome, "auth.json");
  const raw = await readFile(authPath, "utf8").catch(() => "");
  const updated = raw.trim();
  if (!updated || updated === previousAuthJson.trim()) {
    return null;
  }
  return updated;
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
  signal?: AbortSignal;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new CodexStatusProbeAbortedError());
      return;
    }
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
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
    };

    const terminate = (killAfterMs: number) => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, killAfterMs);
      killTimer.unref();
    };

    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      terminate(1_000);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(5_000);
    }, input.timeoutMs);
    timeout.unref();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

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
      cleanup();
      if (aborted) {
        reject(new CodexStatusProbeAbortedError());
        return;
      }
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
      cleanup();
      if (aborted) {
        reject(new CodexStatusProbeAbortedError());
        return;
      }
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
