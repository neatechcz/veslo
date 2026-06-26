import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { recordAudit } from "../audit.js";
import {
  type AutomationRun,
  type AutomationSchedule,
  type AutomationStatus,
  type AutomationTarget,
  type VesloAutomation,
  computeNextAutomationRunAt,
  parseAutomationSchedule,
  parseAutomationStatus,
} from "../automations.js";
import {
  mutateAutomationStore,
  readAutomationStore,
  resolveAutomationsPath,
} from "../automation-store.js";
import { ApiError } from "../errors.js";
import { addRoute, type Route } from "../routing.js";
import {
  ensureWritable,
  jsonResponse,
  readJsonBody,
  requireApproval,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import type { WorkspaceInfo } from "../types.js";
import { exists, shortId } from "../utils.js";

type AgentLabSchedule =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

type AgentLabAutomation = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AgentLabSchedule;
  prompt: string;
  createdAt: number;
  updatedAt?: number;
  lastRunAt?: number;
  lastRunSessionId?: string;
};

type AgentLabAutomationStore = {
  schemaVersion: number;
  updatedAt: number;
  items: AgentLabAutomation[];
};

export function registerAutomationRoutes(routes: Route[]): void {
  addRoute(routes, "GET", "/workspace/:id/automations", "client", async (ctx) => {
    const config = ctx.config;
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await readAutomationStore(workspace.path, workspace.id, { migrateLegacy: !config.readOnly });
    return jsonResponse({ items: store.items, updatedAt: store.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/automations", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const automation = createAutomationFromPayload(workspace, body);
    const path = resolveAutomationsPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.create",
      summary: `Create automation ${automation.name}`,
      paths: [path],
    });

    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      if (store.items.some((item) => item.id === automation.id)) {
        throw new ApiError(409, "automation_conflict", "Automation id already exists");
      }
      return { ...store, updatedAt: automation.updatedAt, items: [automation, ...store.items] };
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.create",
      target: path,
      summary: `Created automation ${automation.name}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);
    return jsonResponse({ automation }, 201);
  });

  addRoute(routes, "PATCH", "/workspace/:id/automations/:automationId", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAutomationId(ctx.params.automationId);
    const body = await readJsonBody(ctx.request);
    const path = resolveAutomationsPath(workspace.path);

    let automation: VesloAutomation | null = null;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.update",
      summary: `Update automation ${automationId}`,
      paths: [path],
    });
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;
        automation = updateAutomationFromPayload(item, body);
        return automation;
      });
      if (!automation) {
        throw new ApiError(404, "automation_not_found", "Automation not found");
      }
      return { ...store, updatedAt: automation.updatedAt, items };
    });
    const updatedAutomation = automation as VesloAutomation | null;
    if (!updatedAutomation) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.update",
      target: path,
      summary: `Updated automation ${updatedAutomation.name}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);
    return jsonResponse({ automation: updatedAutomation });
  });

  addRoute(routes, "DELETE", "/workspace/:id/automations/:automationId", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAutomationId(ctx.params.automationId);
    const path = resolveAutomationsPath(workspace.path);

    let automation: VesloAutomation | null = null;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.delete",
      summary: `Cancel automation ${automationId}`,
      paths: [path],
    });
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const updatedAt = new Date().toISOString();
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;
        automation = {
          ...item,
          enabled: false,
          status: "cancelled",
          nextRunAt: null,
          updatedAt,
        };
        return automation;
      });
      if (!automation) {
        throw new ApiError(404, "automation_not_found", "Automation not found");
      }
      return { ...store, updatedAt, items };
    });
    const cancelledAutomation = automation as VesloAutomation | null;
    if (!cancelledAutomation) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.delete",
      target: path,
      summary: `Cancelled automation ${cancelledAutomation.name}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);
    return jsonResponse({ automation: cancelledAutomation });
  });

  addRoute(routes, "POST", "/workspace/:id/automations/:automationId/run", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAutomationId(ctx.params.automationId);
    const path = resolveAutomationsPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.run",
      summary: `Run automation ${automationId}`,
      paths: [path],
    });
    const run = await ctx.automationRunner.runNow(workspace.id, automationId);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.run",
      target: path,
      summary: `Ran automation ${automationId}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ run });
  });

  addRoute(routes, "GET", "/workspace/:id/automations/:automationId/runs", "client", async (ctx) => {
    const config = ctx.config;
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAutomationId(ctx.params.automationId);
    const store = await readAutomationStore(workspace.path, workspace.id, { migrateLegacy: !config.readOnly });
    const items = store.runs.filter((run) => run.automationId === automationId);
    if (!store.items.some((item) => item.id === automationId) && items.length === 0) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }
    return jsonResponse({ items });
  });

  // @internal: toy-ui only, no production UI callers.
  addRoute(routes, "GET", "/workspace/:id/agentlab/automations", "client", async (ctx) => {
    const config = ctx.config;
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await readAutomationStore(workspace.path, workspace.id, { migrateLegacy: !config.readOnly });
    const legacy = legacyAgentLabStoreFromAutomations(store);
    return jsonResponse({ items: legacy.items, updatedAt: legacy.updatedAt });
  });

  // @internal: toy-ui only, no production UI callers.
  addRoute(routes, "POST", "/workspace/:id/agentlab/automations", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const automation = createAutomationFromPayload(workspace, {
      ...body,
      id: body.id ? validateAgentLabAutomationId(body.id) : `agentlab_${shortId().replace(/-/g, "")}`,
    });
    const path = resolveAutomationsPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.create",
      summary: `Upsert automation ${automation.name}`,
      paths: [path],
    });

    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const existing = store.items.find((item) => item.id === automation.id);
      const nextAutomation = existing
        ? { ...automation, createdAt: existing.createdAt, lastRunId: existing.lastRunId ?? null }
        : automation;
      const items = store.items.filter((item) => item.id !== automation.id);
      return { ...store, updatedAt: nextAutomation.updatedAt, items: [nextAutomation, ...items] };
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.create",
      target: path,
      summary: `Upserted automation ${automation.name}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);

    const next = legacyAgentLabStoreFromAutomations(await readAutomationStore(workspace.path, workspace.id));
    return jsonResponse({ items: next.items, updatedAt: next.updatedAt }, 201);
  });

  // @internal: toy-ui only, no production UI callers.
  addRoute(routes, "DELETE", "/workspace/:id/agentlab/automations/:automationId", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);

    const path = resolveAutomationsPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.delete",
      summary: `Cancel automation ${automationId}`,
      paths: [path],
    });

    let automation: VesloAutomation | null = null;
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const updatedAt = new Date().toISOString();
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;
        automation = { ...item, enabled: false, status: "cancelled", nextRunAt: null, updatedAt };
        return automation;
      });
      if (!automation) {
        throw new ApiError(404, "automation_not_found", "Automation not found");
      }
      return { ...store, updatedAt, items };
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.delete",
      target: path,
      summary: `Cancelled automation ${automationId}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);
    return jsonResponse({ ok: true });
  });

  // @internal: toy-ui only, no production UI callers.
  addRoute(routes, "POST", "/workspace/:id/agentlab/automations/:automationId/run", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);
    const path = resolveAutomationsPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.run",
      summary: `Run automation ${automationId}`,
      paths: [path],
    });
    const run = await ctx.automationRunner.runNow(workspace.id, automationId);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.run",
      target: path,
      summary: `Ran automation ${automationId}`,
      timestamp: Date.now(),
    });

    if (run.status === "failed") {
      return jsonResponse({
        ok: false,
        automationId,
        sessionId: run.sessionId,
        ranAt: run.finishedAt ? Date.parse(run.finishedAt) : Date.now(),
        run,
      }, 502);
    }

    return jsonResponse({
      ok: true,
      automationId,
      sessionId: run.sessionId,
      ranAt: run.finishedAt ? Date.parse(run.finishedAt) : Date.now(),
      run,
    });
  });

  // @internal: toy-ui only, no production UI callers.
  addRoute(routes, "GET", "/workspace/:id/agentlab/automations/logs", "client", async (ctx) => {
    const config = ctx.config;
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const logsDir = resolveAgentLabLogsDir(workspace.path);
    if (!(await exists(logsDir))) {
      return jsonResponse({ items: [] });
    }
    const entries = await readdir(logsDir, { withFileTypes: true });
    const items: Array<{ id: string; path: string; size: number; updatedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".log")) continue;
      const id = entry.name.slice(0, -4);
      const abs = join(logsDir, entry.name);
      try {
        const info = await stat(abs);
        items.push({ id, path: entry.name, size: info.size, updatedAt: info.mtimeMs });
      } catch {
        // ignore
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return jsonResponse({ items });
  });

  // @internal: toy-ui only, no production UI callers.
  addRoute(routes, "GET", "/workspace/:id/agentlab/automations/logs/:automationId", "client", async (ctx) => {
    const config = ctx.config;
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);
    const logsDir = resolveAgentLabLogsDir(workspace.path);
    const abs = join(logsDir, `${automationId}.log`);
    if (!(await exists(abs))) {
      throw new ApiError(404, "log_not_found", "Log not found");
    }
    const content = await readFile(abs, "utf8");
    return jsonResponse({ id: automationId, content });
  });
}

function resolveAgentLabLogsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "agentlab", "logs");
}

function validateAgentLabAutomationId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new ApiError(400, "invalid_payload", "automation id is required");
  }
  if (raw.length > 80) {
    throw new ApiError(400, "invalid_payload", "automation id is too long");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new ApiError(400, "invalid_payload", "automation id must match /^[a-zA-Z0-9_-]+$/");
  }
  return raw;
}

function requireNonEmptyPayloadString(value: unknown, name: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new ApiError(400, "invalid_payload", `${name} is required`);
  }
  return trimmed;
}

function optionalPayloadString(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_payload", `${name} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalNullablePayloadString(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_payload", `${name} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function parseAutomationTargetPayload(value: unknown, previous: AutomationTarget = {}): AutomationTarget {
  if (value === undefined) return previous;
  if (value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_payload", "target must be an object or null");
  }
  const target = value as Record<string, unknown>;
  const next: AutomationTarget = { ...previous };
  const preferredSessionId = optionalPayloadString(target.preferredSessionId, "target.preferredSessionId");
  const fallbackTitle = optionalPayloadString(target.fallbackTitle, "target.fallbackTitle");
  const agent = optionalPayloadString(target.agent, "target.agent");
  const model = optionalNullablePayloadString(target.model, "target.model");
  const variant = optionalNullablePayloadString(target.variant, "target.variant");
  if (preferredSessionId !== undefined) {
    if (preferredSessionId) next.preferredSessionId = preferredSessionId;
    else delete next.preferredSessionId;
  }
  if (fallbackTitle !== undefined) {
    if (fallbackTitle) next.fallbackTitle = fallbackTitle;
    else delete next.fallbackTitle;
  }
  if (agent !== undefined) {
    if (agent) next.agent = agent;
    else delete next.agent;
  }
  if (model !== undefined) next.model = model;
  if (variant !== undefined) next.variant = variant;
  return next;
}

function parseOptionalAutomationStatus(value: unknown): AutomationStatus | undefined {
  if (value === undefined || value === null) return undefined;
  return parseAutomationStatus(value);
}

function resolveAutomationState(
  input: { enabled?: unknown; status?: unknown },
  previous: { enabled: boolean; status: AutomationStatus },
): { enabled: boolean; status: AutomationStatus } {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ApiError(400, "invalid_payload", "enabled must be a boolean");
  }
  const explicitStatus = parseOptionalAutomationStatus(input.status);
  let enabled = typeof input.enabled === "boolean" ? input.enabled : previous.enabled;
  let status = explicitStatus ?? previous.status;

  if (explicitStatus) {
    enabled = explicitStatus === "active";
  } else if (typeof input.enabled === "boolean") {
    status = input.enabled ? "active" : "paused";
  }

  if (status !== "active") {
    enabled = false;
  }
  if (status === "active" && !enabled) {
    status = "paused";
  }
  return { enabled, status };
}

function isTerminalAutomationStatus(status: AutomationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function canReactivateWithSchedule(schedule: AutomationSchedule): boolean {
  if (schedule.kind !== "oneShot") {
    return true;
  }
  return Date.parse(schedule.runAt) > Date.now();
}

function nextAutomationRunAt(
  schedule: AutomationSchedule,
  state: { enabled: boolean; status: AutomationStatus },
): string | null {
  if (!state.enabled || state.status !== "active") {
    return null;
  }
  return computeNextAutomationRunAt(schedule, Date.now());
}

function validateAutomationId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new ApiError(400, "invalid_payload", "automation id is required");
  }
  if (raw.length > 80) {
    throw new ApiError(400, "invalid_payload", "automation id is too long");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new ApiError(400, "invalid_payload", "automation id must match /^[a-zA-Z0-9_-]+$/");
  }
  return raw;
}

function createAutomationFromPayload(
  workspace: WorkspaceInfo,
  body: Record<string, unknown>,
): VesloAutomation {
  const name = requireNonEmptyPayloadString(body.name, "name");
  const prompt = requireNonEmptyPayloadString(body.prompt, "prompt");
  const schedule = parseAutomationSchedule(body.schedule);
  const state = resolveAutomationState(
    { enabled: body.enabled, status: body.status },
    { enabled: true, status: "active" },
  );
  const now = new Date().toISOString();
  const id = body.id === undefined || body.id === null
    ? `automation_${shortId().replace(/-/g, "")}`
    : validateAutomationId(body.id);

  return {
    id,
    workspaceId: workspace.id,
    name,
    enabled: state.enabled,
    status: state.status,
    schedule,
    prompt,
    target: parseAutomationTargetPayload(body.target),
    createdAt: now,
    updatedAt: now,
    nextRunAt: nextAutomationRunAt(schedule, state),
    completedAt: null,
    lastRunId: null,
  };
}

function updateAutomationFromPayload(
  existing: VesloAutomation,
  body: Record<string, unknown>,
): VesloAutomation {
  const name = body.name === undefined ? existing.name : requireNonEmptyPayloadString(body.name, "name");
  const prompt = body.prompt === undefined ? existing.prompt : requireNonEmptyPayloadString(body.prompt, "prompt");
  const schedule = body.schedule === undefined ? existing.schedule : parseAutomationSchedule(body.schedule);
  const wantsActive = body.enabled === true || body.status === "active";
  if (isTerminalAutomationStatus(existing.status) && wantsActive) {
    const allowed = body.status === "active" && body.schedule !== undefined && canReactivateWithSchedule(schedule);
    if (!allowed) {
      throw new ApiError(
        409,
        "automation_terminal",
        "Terminal automations require an explicit active status and updated future or recurring schedule to reactivate",
      );
    }
  }
  const state = resolveAutomationState(
    { enabled: body.enabled, status: body.status },
    { enabled: existing.enabled, status: existing.status },
  );
  return {
    ...existing,
    name,
    prompt,
    schedule,
    enabled: state.enabled,
    status: state.status,
    target: parseAutomationTargetPayload(body.target, existing.target),
    updatedAt: new Date().toISOString(),
    nextRunAt: nextAutomationRunAt(schedule, state),
    completedAt: state.status === "completed" ? existing.completedAt ?? new Date().toISOString() : existing.completedAt ?? null,
  };
}

function toLegacyAgentLabAutomation(
  automation: VesloAutomation,
  runs: AutomationRun[],
): AgentLabAutomation {
  const lastRun = automation.lastRunId
    ? runs.find((run) => run.id === automation.lastRunId)
    : [...runs].reverse().find((run) => run.automationId === automation.id);
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    schedule: automation.schedule as AgentLabSchedule,
    prompt: automation.prompt,
    createdAt: Date.parse(automation.createdAt),
    updatedAt: Date.parse(automation.updatedAt),
    lastRunAt: lastRun?.finishedAt ? Date.parse(lastRun.finishedAt) : undefined,
    lastRunSessionId: lastRun?.sessionId ?? undefined,
  };
}

function isLegacyAgentLabSchedule(schedule: AutomationSchedule): schedule is AgentLabSchedule {
  return schedule.kind === "interval" || schedule.kind === "daily" || schedule.kind === "weekly";
}

function legacyAgentLabStoreFromAutomations(store: { updatedAt: string; items: VesloAutomation[]; runs: AutomationRun[] }): AgentLabAutomationStore {
  return {
    schemaVersion: 1,
    updatedAt: Date.parse(store.updatedAt),
    items: store.items
      .filter((item) => isLegacyAgentLabSchedule(item.schedule))
      .map((item) => toLegacyAgentLabAutomation(item, store.runs)),
  };
}
