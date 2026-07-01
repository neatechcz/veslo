import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { listCommands } from "./commands.js";
import { readJsoncFile } from "./jsonc.js";
import { listScheduledJobs } from "./scheduler.js";
import { exists } from "./utils.js";
import { opencodeConfigPath } from "./workspace-files.js";

export const SOUL_INSTRUCTIONS = [
  ".opencode/soul-company.md",
  ".opencode/soul-user.md",
  ".opencode/soul-workspace.md",
] as const;

export const LEGACY_SOUL_MEMORY_PATH = ".opencode/soul.md";
export const SOUL_HEARTBEAT_PATH = ".opencode/soul/heartbeat.jsonl";
export const SOUL_MANIFEST_PATH = ".opencode/veslo/soul-manifest.json";

export type SoulHeartbeatEntry = {
  id: string;
  ts: string | null;
  workspace: string | null;
  summary: string;
  looseEnds: string[];
  nextAction: string | null;
};

export type SoulStatus = {
  enabled: boolean;
  state: "off" | "healthy" | "stale" | "error";
  memoryEnabled: boolean;
  instructionsEnabled: boolean;
  heartbeatLogExists: boolean;
  heartbeatCommandExists: boolean;
  heartbeatJob: {
    name: string;
    slug: string;
    schedule: string;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunError: string | null;
  } | null;
  heartbeatCount: number;
  lastHeartbeatAt: string | null;
  lastHeartbeatSummary: string | null;
  staleAfterMs: number | null;
  overdue: boolean;
  summary: string;
  memoryPath: typeof SOUL_INSTRUCTIONS[number];
  memoryPaths: Array<typeof SOUL_INSTRUCTIONS[number]>;
  heartbeatPath: typeof SOUL_HEARTBEAT_PATH;
};

export function soulMemoryPaths(workspaceRoot: string): string[] {
  return SOUL_INSTRUCTIONS.map((relativePath) => join(workspaceRoot, relativePath));
}

export function soulLegacyMemoryPath(workspaceRoot: string): string {
  return join(workspaceRoot, LEGACY_SOUL_MEMORY_PATH);
}

export function soulHeartbeatPath(workspaceRoot: string): string {
  return join(workspaceRoot, SOUL_HEARTBEAT_PATH);
}

export function soulMaterializationApprovalPaths(workspaceRoot: string): string[] {
  return [
    opencodeConfigPath(workspaceRoot),
    ...soulMemoryPaths(workspaceRoot),
    join(workspaceRoot, SOUL_MANIFEST_PATH),
  ];
}

export function configIncludesSoulInstruction(config: Record<string, unknown>): boolean {
  const targets = [...SOUL_INSTRUCTIONS, LEGACY_SOUL_MEMORY_PATH];
  const instructions = config.instructions;
  const matchesSoulInstruction = (entry: unknown) =>
    typeof entry === "string" && targets.some((target) => entry.includes(target));
  if (typeof instructions === "string") {
    return matchesSoulInstruction(instructions);
  }
  if (Array.isArray(instructions)) {
    return instructions.some(matchesSoulInstruction);
  }
  return false;
}

export function normalizeSoulTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function toSoulStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

export function parseSoulHeartbeatLine(rawLine: string, lineIndex: number): SoulHeartbeatEntry | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const ts = normalizeSoulTimestamp(parsed.ts);
  const workspace = typeof parsed.workspace === "string" && parsed.workspace.trim()
    ? parsed.workspace.trim()
    : null;
  const looseEnds = toSoulStringArray(parsed.loose_ends ?? parsed.looseEnds);
  const nextActionRaw = parsed.next_action ?? parsed.nextAction;
  const nextAction = typeof nextActionRaw === "string" && nextActionRaw.trim() ? nextActionRaw.trim() : null;
  const summaryRaw = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const summary =
    summaryRaw ||
    nextAction ||
    (looseEnds.length ? `Loose ends: ${looseEnds.slice(0, 2).join("; ")}` : "(no summary)");

  return {
    id: `${ts ?? "unknown"}-${lineIndex}`,
    ts,
    workspace,
    summary,
    looseEnds,
    nextAction,
  };
}

export function parseSoulHeartbeatEntries(content: string): SoulHeartbeatEntry[] {
  const lines = content.split(/\r?\n/);
  const items: SoulHeartbeatEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const item = parseSoulHeartbeatLine(lines[i] ?? "", i + 1);
    if (item) items.push(item);
  }
  return items;
}

export function estimateCronIntervalMs(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [minute, hour, dom, mon, dow] = parts;
  if (!minute || !hour || !dom || !mon || !dow) return null;

  if (minute === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return 60_000;
  }

  const minuteEvery = /^\*\/(\d+)$/.exec(minute);
  if (minuteEvery && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const interval = Number(minuteEvery[1]);
    if (Number.isFinite(interval) && interval > 0) {
      return interval * 60_000;
    }
  }

  const hourEvery = /^\*\/(\d+)$/.exec(hour);
  if (hourEvery && /^\d+$/.test(minute) && dom === "*" && mon === "*" && dow === "*") {
    const interval = Number(hourEvery[1]);
    if (Number.isFinite(interval) && interval > 0) {
      return interval * 60 * 60_000;
    }
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    return 24 * 60 * 60_000;
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow !== "*") {
    return 24 * 60 * 60_000;
  }

  return null;
}

export async function listSoulHeartbeats(
  workspaceRoot: string,
  limit: number,
): Promise<{ items: SoulHeartbeatEntry[]; total: number; path: typeof SOUL_HEARTBEAT_PATH }> {
  const heartbeatPath = soulHeartbeatPath(workspaceRoot);
  if (!(await exists(heartbeatPath))) {
    return { items: [], total: 0, path: SOUL_HEARTBEAT_PATH };
  }

  const content = await readFile(heartbeatPath, "utf8");
  const all = parseSoulHeartbeatEntries(content);
  return { items: all.slice(0, Math.max(1, limit)), total: all.length, path: SOUL_HEARTBEAT_PATH };
}

export async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  return data;
}

export async function getSoulStatus(workspaceRoot: string): Promise<SoulStatus> {
  const memoryPaths = soulMemoryPaths(workspaceRoot);
  const [opencodeConfig, currentMemoryExists, legacyMemoryExists, heartbeatLogExists] = await Promise.all([
    readOpencodeConfig(workspaceRoot),
    Promise.all(memoryPaths.map((path) => exists(path))).then((results) => results.some(Boolean)),
    exists(soulLegacyMemoryPath(workspaceRoot)),
    exists(soulHeartbeatPath(workspaceRoot)),
  ]);
  const memoryEnabled = currentMemoryExists || legacyMemoryExists;

  let heartbeatCommandExists = false;
  try {
    const commands = await listCommands(workspaceRoot, "workspace");
    heartbeatCommandExists = commands.some((command) => command.name === "soul-heartbeat");
  } catch {
    heartbeatCommandExists = false;
  }

  let heartbeatJob: SoulStatus["heartbeatJob"] = null;
  try {
    const jobs = await listScheduledJobs(workspaceRoot);
    const found = jobs.find((job) => {
      if (job.name === "soul-heartbeat") return true;
      if (job.slug === "soul-heartbeat") return true;
      return job.slug.includes("soul-heartbeat");
    });
    if (found) {
      heartbeatJob = {
        name: found.name,
        slug: found.slug,
        schedule: found.schedule,
        lastRunAt: found.lastRunAt ?? null,
        lastRunStatus: found.lastRunStatus ?? null,
        lastRunError: found.lastRunError ?? null,
      };
    }
  } catch {
    heartbeatJob = null;
  }

  const instructionsEnabled = configIncludesSoulInstruction(opencodeConfig);
  const heartbeats = await listSoulHeartbeats(workspaceRoot, 500);
  const lastHeartbeat = heartbeats.items[0] ?? null;
  const lastHeartbeatAt = lastHeartbeat?.ts ?? null;
  const lastHeartbeatSummary = lastHeartbeat?.summary ?? null;

  const enabled =
    memoryEnabled ||
    instructionsEnabled ||
    heartbeatLogExists ||
    heartbeatCommandExists ||
    Boolean(heartbeatJob);

  const estimatedIntervalMs = heartbeatJob ? estimateCronIntervalMs(heartbeatJob.schedule) : null;
  const staleAfterMs = enabled
    ? Math.max(estimatedIntervalMs ? estimatedIntervalMs * 2 : 24 * 60 * 60_000, 30 * 60_000)
    : null;

  const parsedLastHeartbeat = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : NaN;
  const hasLastHeartbeat = Number.isFinite(parsedLastHeartbeat);
  const overdue = Boolean(
    enabled &&
    staleAfterMs != null &&
    (heartbeatJob || lastHeartbeatAt) &&
    (!hasLastHeartbeat || Date.now() - parsedLastHeartbeat > staleAfterMs),
  );

  let state: SoulStatus["state"] = "off";
  if (!enabled) {
    state = "off";
  } else if ((heartbeatJob?.lastRunStatus ?? "") === "failed" || Boolean(heartbeatJob?.lastRunError?.trim())) {
    state = "error";
  } else if (overdue) {
    state = "stale";
  } else {
    state = "healthy";
  }

  const summary = !enabled
    ? "Soul mode is not enabled for this worker yet."
    : state === "error"
      ? "Soul heartbeat ran into an error."
      : state === "stale"
        ? "Soul heartbeat is overdue."
        : heartbeatJob
          ? "Soul mode is active and heartbeat is on schedule."
          : "Soul mode is active. Heartbeat schedule not found.";

  return {
    enabled,
    state,
    memoryEnabled,
    instructionsEnabled,
    heartbeatLogExists,
    heartbeatCommandExists,
    heartbeatJob,
    heartbeatCount: heartbeats.total,
    lastHeartbeatAt,
    lastHeartbeatSummary,
    staleAfterMs,
    overdue,
    summary,
    memoryPath: SOUL_INSTRUCTIONS[0],
    memoryPaths: [...SOUL_INSTRUCTIONS],
    heartbeatPath: SOUL_HEARTBEAT_PATH,
  };
}
