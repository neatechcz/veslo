import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type AutomationRun,
  type VesloAutomation,
  isValidIsoInstant,
  parseAutomationRunStatus,
  parseAutomationSchedule,
  parseAutomationStatus,
} from "./automations.js";
import { ApiError } from "./errors.js";
import { ensureDir, exists } from "./utils.js";

export type AutomationStoreData = {
  schemaVersion: 1;
  updatedAt: string;
  items: VesloAutomation[];
  runs: AutomationRun[];
};

type LegacyAgentLabAutomation = {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  schedule?: unknown;
  prompt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastRunAt?: unknown;
  lastRunSessionId?: unknown;
};

type LegacyAgentLabStore = {
  updatedAt?: unknown;
  items?: unknown;
};

export function resolveAutomationsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "automations.json");
}

export function resolveLegacyAgentLabAutomationsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "agentlab", "automations.json");
}

export async function readAutomationStore(workspaceRoot: string, workspaceId: string): Promise<AutomationStoreData> {
  const path = resolveAutomationsPath(workspaceRoot);
  if (await exists(path)) {
    return readNewAutomationStore(path);
  }

  const legacyPath = resolveLegacyAgentLabAutomationsPath(workspaceRoot);
  if (await exists(legacyPath)) {
    const migrated = await readLegacyAgentLabStore(legacyPath, workspaceId);
    await writeAutomationStore(workspaceRoot, migrated);
    return migrated;
  }

  return emptyStore();
}

export async function writeAutomationStore(workspaceRoot: string, data: AutomationStoreData): Promise<void> {
  const path = resolveAutomationsPath(workspaceRoot);
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function upsertAutomation(workspaceRoot: string, automation: VesloAutomation): Promise<AutomationStoreData> {
  const store = await readAutomationStore(workspaceRoot, automation.workspaceId);
  const items = [...store.items];
  const existingIndex = items.findIndex((item) => item.id === automation.id);
  if (existingIndex === -1) {
    items.unshift(automation);
  } else {
    items[existingIndex] = automation;
  }

  const next = { ...store, updatedAt: nowIso(), items };
  await writeAutomationStore(workspaceRoot, next);
  return next;
}

export async function appendOrReplaceAutomationRun(workspaceRoot: string, run: AutomationRun): Promise<AutomationStoreData> {
  const store = await readAutomationStore(workspaceRoot, "");
  const runs = [...store.runs];
  const existingIndex = runs.findIndex((item) => item.id === run.id);
  if (existingIndex === -1) {
    runs.push(run);
  } else {
    runs[existingIndex] = run;
  }

  const next = { ...store, updatedAt: nowIso(), runs };
  await writeAutomationStore(workspaceRoot, next);
  return next;
}

async function readNewAutomationStore(path: string): Promise<AutomationStoreData> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse Veslo automations");
  }

  const record = isRecord(parsed) ? parsed : {};
  return {
    schemaVersion: 1,
    updatedAt: normalizeIsoInstant(record.updatedAt) ?? nowIso(),
    items: normalizeAutomationItems(record.items),
    runs: normalizeAutomationRuns(record.runs),
  };
}

async function readLegacyAgentLabStore(path: string, workspaceId: string): Promise<AutomationStoreData> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse Agent Lab automations");
  }

  const legacy = (isRecord(parsed) ? parsed : {}) as LegacyAgentLabStore;
  const items = Array.isArray(legacy.items) ? legacy.items : [];
  const automations: VesloAutomation[] = [];
  const runs: AutomationRun[] = [];

  for (const item of items) {
    const migrated = migrateLegacyAutomation(item as LegacyAgentLabAutomation, workspaceId);
    if (!migrated) continue;
    automations.push(migrated.automation);
    if (migrated.run) {
      runs.push(migrated.run);
    }
  }

  return {
    schemaVersion: 1,
    updatedAt: normalizeLegacyTimestamp(legacy.updatedAt) ?? nowIso(),
    items: automations,
    runs,
  };
}

function migrateLegacyAutomation(
  record: LegacyAgentLabAutomation,
  workspaceId: string,
): { automation: VesloAutomation; run?: AutomationRun } | null {
  const id = normalizeNonEmptyString(record.id);
  const name = normalizeNonEmptyString(record.name);
  const prompt = typeof record.prompt === "string" ? record.prompt : "";
  if (!id || !name || !prompt) {
    return null;
  }

  let schedule: VesloAutomation["schedule"];
  try {
    schedule = parseAutomationSchedule(record.schedule);
  } catch {
    return null;
  }

  const createdAt = normalizeLegacyTimestamp(record.createdAt) ?? nowIso();
  const updatedAt = normalizeLegacyTimestamp(record.updatedAt) ?? createdAt;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const lastRunAt = normalizeLegacyTimestamp(record.lastRunAt);
  const runId = lastRunAt ? stableLegacyRunId(id, lastRunAt) : undefined;
  const automation: VesloAutomation = {
    id,
    workspaceId,
    name,
    enabled,
    status: enabled ? "active" : "paused",
    schedule,
    prompt,
    target: {},
    createdAt,
    updatedAt,
    ...(runId ? { lastRunId: runId } : {}),
  };

  if (!lastRunAt || !runId) {
    return { automation };
  }

  const run: AutomationRun = {
    id: runId,
    automationId: id,
    scheduledFor: lastRunAt,
    startedAt: lastRunAt,
    finishedAt: lastRunAt,
    status: "success",
    sessionId: normalizeNonEmptyString(record.lastRunSessionId) ?? null,
    createdSession: false,
  };
  return { automation, run };
}

function normalizeAutomationItems(value: unknown): VesloAutomation[] {
  if (!Array.isArray(value)) return [];

  const items: VesloAutomation[] = [];
  for (const item of value) {
    const normalized = normalizeAutomationItem(item);
    if (normalized) {
      items.push(normalized);
    }
  }
  return items;
}

function normalizeAutomationItem(value: unknown): VesloAutomation | null {
  if (!isRecord(value)) return null;

  const id = normalizeNonEmptyString(value.id);
  const workspaceId = normalizeNonEmptyString(value.workspaceId);
  const name = normalizeNonEmptyString(value.name);
  const prompt = typeof value.prompt === "string" ? value.prompt : "";
  const createdAt = normalizeIsoInstant(value.createdAt);
  const updatedAt = normalizeIsoInstant(value.updatedAt);
  if (!id || !workspaceId || !name || !prompt || !createdAt || !updatedAt) {
    return null;
  }

  let status: VesloAutomation["status"];
  let schedule: VesloAutomation["schedule"];
  try {
    status = parseAutomationStatus(value.status);
    schedule = parseAutomationSchedule(value.schedule);
  } catch {
    return null;
  }

  const target = isRecord(value.target) ? normalizeAutomationTarget(value.target) : {};
  const automation: VesloAutomation = {
    id,
    workspaceId,
    name,
    enabled: typeof value.enabled === "boolean" ? value.enabled : status === "active",
    status,
    schedule,
    prompt,
    target,
    createdAt,
    updatedAt,
  };

  const nextRunAt = normalizeNullableIsoInstant(value.nextRunAt);
  if (nextRunAt !== undefined) automation.nextRunAt = nextRunAt;
  const completedAt = normalizeNullableIsoInstant(value.completedAt);
  if (completedAt !== undefined) automation.completedAt = completedAt;
  const lastRunId = normalizeNullableString(value.lastRunId);
  if (lastRunId !== undefined) automation.lastRunId = lastRunId;

  return automation;
}

function normalizeAutomationRuns(value: unknown): AutomationRun[] {
  if (!Array.isArray(value)) return [];

  const runs: AutomationRun[] = [];
  for (const item of value) {
    const normalized = normalizeAutomationRun(item);
    if (normalized) {
      runs.push(normalized);
    }
  }
  return runs;
}

function normalizeAutomationRun(value: unknown): AutomationRun | null {
  if (!isRecord(value)) return null;

  const id = normalizeNonEmptyString(value.id);
  const automationId = normalizeNonEmptyString(value.automationId);
  const scheduledFor = normalizeIsoInstant(value.scheduledFor);
  if (!id || !automationId || !scheduledFor) {
    return null;
  }

  let status: AutomationRun["status"];
  try {
    status = parseAutomationRunStatus(value.status);
  } catch {
    return null;
  }

  const run: AutomationRun = {
    id,
    automationId,
    scheduledFor,
    status,
    createdSession: typeof value.createdSession === "boolean" ? value.createdSession : false,
  };

  const startedAt = normalizeNullableIsoInstant(value.startedAt);
  if (startedAt !== undefined) run.startedAt = startedAt;
  const finishedAt = normalizeNullableIsoInstant(value.finishedAt);
  if (finishedAt !== undefined) run.finishedAt = finishedAt;
  const sessionId = normalizeNullableString(value.sessionId);
  if (sessionId !== undefined) run.sessionId = sessionId;
  const error = normalizeNullableString(value.error);
  if (error !== undefined) run.error = error;

  return run;
}

function normalizeAutomationTarget(value: Record<string, unknown>): VesloAutomation["target"] {
  const target: VesloAutomation["target"] = {};
  const preferredSessionId = normalizeNonEmptyString(value.preferredSessionId);
  if (preferredSessionId) target.preferredSessionId = preferredSessionId;
  const fallbackTitle = normalizeNonEmptyString(value.fallbackTitle);
  if (fallbackTitle) target.fallbackTitle = fallbackTitle;
  const agent = normalizeNonEmptyString(value.agent);
  if (agent) target.agent = agent;
  if (typeof value.model === "string" || value.model === null) target.model = value.model;
  if (typeof value.variant === "string" || value.variant === null) target.variant = value.variant;
  return target;
}

function normalizeIsoInstant(value: unknown): string | undefined {
  return typeof value === "string" && isValidIsoInstant(value) ? value : undefined;
}

function normalizeNullableIsoInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  return normalizeIsoInstant(value);
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function normalizeLegacyTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function stableLegacyRunId(legacyId: string, lastRunAt: string): string {
  return `run_${sanitizeIdPart(legacyId)}_${sanitizeIdPart(lastRunAt)}`;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "legacy";
}

function emptyStore(): AutomationStoreData {
  return { schemaVersion: 1, updatedAt: nowIso(), items: [], runs: [] };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
