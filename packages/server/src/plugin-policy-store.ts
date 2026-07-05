import { createHash } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { resolveVesloDataDir } from "./audit.js";
import { ApiError } from "./errors.js";
import type { PluginPolicy } from "./plugin-policy.js";
import type {
  Actor,
  PluginPolicyOverride,
  PluginPolicyOverrideAction,
  PluginPolicyOverridesDocument,
  PluginPolicyOverrideScope,
  TokenScope,
} from "./types.js";
import { ensureDir } from "./utils.js";

export type { PluginPolicyOverride } from "./types.js";

export type SetPluginEnabledStateInput = {
  dataDir?: string;
  policy: PluginPolicy;
  scope: PluginPolicyOverrideScope;
  workspaceId?: string;
  orgId?: string;
  enabled: boolean;
  actor?: Actor;
};

export type SetPluginRemovedStateInput = {
  dataDir?: string;
  policy: PluginPolicy;
  scope: PluginPolicyOverrideScope;
  workspaceId?: string;
  orgId?: string;
  removed: boolean;
  actor?: Actor;
};

type SetPluginEnabledStateResult = {
  ok: true;
  enabled: boolean;
  record?: PluginPolicyOverride;
};

type SetPluginRemovedStateResult = {
  ok: true;
  removed: boolean;
  record?: PluginPolicyOverride;
};

type PluginPolicyOverrideTarget = {
  pluginId: string;
  scope: PluginPolicyOverrideScope;
  workspaceId?: string;
  orgId?: string;
};

const STORE_FILE = "plugin-policy-overrides.json";
const SCOPES = new Set<PluginPolicyOverrideScope>(["user", "project", "organization"]);
const TOKEN_SCOPES = new Set<TokenScope>(["owner", "collaborator", "viewer"]);
const ACTOR_MAX_LENGTH = 256;
const PLUGIN_ID_MAX_LENGTH = 256;
const mutationQueues = new Map<string, Promise<void>>();

export async function listPluginPolicyOverrides(input: {
  dataDir?: string;
  workspaceId?: string;
  orgId?: string;
  includeGlobal?: boolean;
} = {}): Promise<PluginPolicyOverride[]> {
  const document = await readStore(input.dataDir);
  const workspaceId = normalizeOptionalString(input.workspaceId, "workspaceId");
  const orgId = normalizeOptionalString(input.orgId, "orgId");
  const includeGlobal = input.includeGlobal ?? true;

  return document.overrides.filter((record) => {
    if (record.scope === "project") {
      return Boolean(workspaceId) && record.workspaceId === workspaceId;
    }
    if (record.scope === "organization") {
      return includeGlobal && Boolean(orgId) && record.orgId === orgId;
    }
    return includeGlobal;
  });
}

export async function setPluginEnabledState(
  input: SetPluginEnabledStateInput,
): Promise<SetPluginEnabledStateResult> {
  if (typeof input.enabled !== "boolean") {
    throw new ApiError(400, "invalid_payload", "enabled must be a boolean");
  }

  const policy = normalizePolicy(input.policy);
  const target = normalizeTarget({
    pluginId: policy.id,
    scope: input.scope,
    workspaceId: input.workspaceId,
    orgId: input.orgId,
  });
  const id = pluginPolicyOverrideId(target, "disabled");

  if (!input.enabled && policy.enabledPolicy === "locked-on") {
    throw new ApiError(409, "plugin_policy_locked", "Plugin policy is locked on and cannot be disabled");
  }

  return mutateStore<SetPluginEnabledStateResult>(input.dataDir, (document) => {
    const existingIndex = document.overrides.findIndex((record) => record.id === id);

    if (input.enabled) {
      if (existingIndex !== -1) {
        document.overrides.splice(existingIndex, 1);
      }
      return {
        document,
        result: { ok: true as const, enabled: true },
      };
    }

    const existing = existingIndex === -1 ? undefined : document.overrides[existingIndex];
    const record = buildOverrideRecord(target, "disabled", existing, input.actor);
    if (existingIndex === -1) {
      document.overrides.push(record);
    } else {
      document.overrides[existingIndex] = record;
    }
    return {
      document,
      result: { ok: true as const, enabled: false, record },
    };
  });
}

export async function setPluginRemovedState(
  input: SetPluginRemovedStateInput,
): Promise<SetPluginRemovedStateResult> {
  if (typeof input.removed !== "boolean") {
    throw new ApiError(400, "invalid_payload", "removed must be a boolean");
  }

  const policy = normalizePolicy(input.policy);
  const target = normalizeTarget({
    pluginId: policy.id,
    scope: input.scope,
    workspaceId: input.workspaceId,
    orgId: input.orgId,
  });
  const id = pluginPolicyOverrideId(target, "removed");

  if (input.removed && policy.removalPolicy === "locked") {
    throw new ApiError(409, "plugin_policy_locked", "Plugin policy is locked and cannot be removed");
  }

  return mutateStore<SetPluginRemovedStateResult>(input.dataDir, (document) => {
    const existingIndex = document.overrides.findIndex((record) => record.id === id);

    if (!input.removed) {
      if (existingIndex !== -1) {
        document.overrides.splice(existingIndex, 1);
      }
      return {
        document,
        result: { ok: true as const, removed: false },
      };
    }

    const existing = existingIndex === -1 ? undefined : document.overrides[existingIndex];
    const record = buildOverrideRecord(target, "removed", existing, input.actor);
    if (existingIndex === -1) {
      document.overrides.push(record);
    } else {
      document.overrides[existingIndex] = record;
    }
    return {
      document,
      result: { ok: true as const, removed: true, record },
    };
  });
}

export function pluginPolicyOverrideMatches(
  record: PluginPolicyOverride,
  target: PluginPolicyOverrideTarget,
): boolean {
  try {
    const normalizedRecord = normalizeTarget({
      pluginId: record.pluginId,
      scope: record.scope,
      workspaceId: record.workspaceId,
      orgId: record.orgId,
    });
    const normalizedTarget = normalizeTarget(target);
    return pluginPolicyOverrideTargetKey(normalizedRecord) === pluginPolicyOverrideTargetKey(normalizedTarget);
  } catch {
    return false;
  }
}

function resolveDataDir(dataDir?: string): string {
  const trimmed = dataDir?.trim();
  return trimmed ? resolve(trimmed) : resolveVesloDataDir();
}

function storePath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), STORE_FILE);
}

async function readStore(dataDir?: string): Promise<PluginPolicyOverridesDocument> {
  const path = storePath(dataDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return emptyStore();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse plugin policy overrides");
  }

  const source = isRecord(parsed) && Array.isArray(parsed.overrides) ? parsed.overrides : [];
  return {
    schemaVersion: 1,
    overrides: source.map(normalizeStoredRecord).filter((record): record is PluginPolicyOverride => Boolean(record)),
  };
}

async function writeStore(dataDir: string | undefined, document: PluginPolicyOverridesDocument): Promise<void> {
  const path = storePath(dataDir);
  const dir = dirname(path);
  await ensureDir(dir);

  const tmpPath = join(
    dir,
    `${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmpPath, "w");
    await handle.writeFile(JSON.stringify(document, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmpPath, path);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write error.
      }
    }
    await rm(tmpPath, { force: true });
    throw error;
  }
}

async function mutateStore<T>(
  dataDir: string | undefined,
  mutate: (document: PluginPolicyOverridesDocument) => {
    document: PluginPolicyOverridesDocument;
    result: T;
  },
): Promise<T> {
  const path = storePath(dataDir);
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let result: T | undefined;

  const operation = previous.catch(() => undefined).then(async () => {
    const current = await readStore(dataDir);
    const next = mutate(current);
    result = next.result;
    await writeStore(dataDir, next.document);
  });
  const queued = operation.then(() => undefined, () => undefined);
  mutationQueues.set(path, queued);

  try {
    await operation;
    return result as T;
  } finally {
    if (mutationQueues.get(path) === queued) {
      mutationQueues.delete(path);
    }
  }
}

function emptyStore(): PluginPolicyOverridesDocument {
  return { schemaVersion: 1, overrides: [] };
}

function buildOverrideRecord(
  target: PluginPolicyOverrideTarget,
  action: PluginPolicyOverrideAction,
  existing: PluginPolicyOverride | undefined,
  actor: Actor | undefined,
): PluginPolicyOverride {
  const normalizedActor = actor ? normalizeActorIdentity(actor) : existing?.actor;
  return {
    id: pluginPolicyOverrideId(target, action),
    ...target,
    action,
    ...(normalizedActor ? { actor: normalizedActor } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

function normalizeStoredRecord(value: unknown): PluginPolicyOverride | null {
  if (!isRecord(value)) return null;
  try {
    const action = normalizeAction(value.action);
    const target = normalizeTarget({
      pluginId: value.pluginId,
      scope: value.scope,
      workspaceId: value.workspaceId,
      orgId: value.orgId,
    });
    const actor = normalizeStoredActor(value.actor);
    return {
      id: pluginPolicyOverrideId(target, action),
      ...target,
      action,
      ...(actor ? { actor } : {}),
      createdAt: normalizeIsoString(value.createdAt) ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizePolicy(policy: PluginPolicy): PluginPolicy {
  if (!isRecord(policy)) {
    throw new ApiError(400, "invalid_payload", "policy is required");
  }
  return {
    ...policy,
    id: normalizePluginId(policy.id, "policy.id"),
  };
}

function normalizeTarget(target: {
  pluginId: unknown;
  scope: unknown;
  workspaceId?: unknown;
  orgId?: unknown;
}): PluginPolicyOverrideTarget {
  const pluginId = normalizePluginId(target.pluginId, "pluginId");
  const scope = normalizeScope(target.scope);
  const workspaceId = normalizeOptionalString(target.workspaceId, "workspaceId");
  const orgId = normalizeOptionalString(target.orgId, "orgId");

  if (scope === "project") {
    if (!workspaceId) {
      throw new ApiError(400, "invalid_workspace_id", "Project plugin policy overrides require a workspace id");
    }
    return { pluginId, scope, workspaceId };
  }

  if (scope === "organization") {
    if (!orgId) {
      throw new ApiError(400, "invalid_org_id", "Organization plugin policy overrides require an organization id");
    }
    return { pluginId, scope, orgId };
  }

  return { pluginId, scope };
}

function normalizeScope(value: unknown): PluginPolicyOverrideScope {
  if (typeof value !== "string" || !SCOPES.has(value as PluginPolicyOverrideScope)) {
    throw new ApiError(400, "invalid_scope", "Plugin policy override scope is invalid");
  }
  return value as PluginPolicyOverrideScope;
}

function normalizeAction(value: unknown): PluginPolicyOverrideAction {
  if (value !== "disabled" && value !== "removed") {
    throw new ApiError(400, "invalid_action", "Plugin policy override action is invalid");
  }
  return value;
}

function normalizePluginId(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_plugin_id", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > PLUGIN_ID_MAX_LENGTH
    || trimmed.includes("\0")
    || trimmed.includes("/")
    || trimmed.includes("\\")
    || trimmed.includes("..")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)
  ) {
    throw new ApiError(400, "invalid_plugin_id", "Plugin id is invalid");
  }
  return trimmed;
}

function normalizeActorIdentity(actor: unknown): string {
  if (!isRecord(actor) || (actor.type !== "host" && actor.type !== "remote")) {
    throw new ApiError(400, "invalid_payload", "actor is invalid");
  }

  const clientId = normalizeOptionalString(actor.clientId, "actor.clientId", 4096);
  const scope = normalizeOptionalString(actor.scope, "actor.scope") as TokenScope | undefined;
  if (scope && !TOKEN_SCOPES.has(scope)) {
    throw new ApiError(400, "invalid_payload", "actor.scope is invalid");
  }

  if (actor.type === "host") return "host";
  return ["remote", clientId ? `client:${hashIdentity(clientId)}` : undefined, scope ? `scope:${scope}` : undefined]
    .filter(Boolean)
    .join(":");
}

function normalizeStoredActor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return normalizeStoredIdentityString(value);
  if (isRecord(value)) return normalizeActorIdentity(value);
  return undefined;
}

function normalizeOptionalString(value: unknown, field: string, maxLength = 2048): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("\0")) {
    throw new ApiError(400, "invalid_payload", `${field} is invalid`);
  }
  if (trimmed.length > maxLength) {
    throw new ApiError(400, "invalid_payload", `${field} is too long`);
  }
  return trimmed;
}

function normalizeStoredIdentityString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  return trimmed.length > ACTOR_MAX_LENGTH ? trimmed.slice(0, ACTOR_MAX_LENGTH) : trimmed;
}

function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !Number.isNaN(Date.parse(trimmed)) ? trimmed : undefined;
}

function pluginPolicyOverrideId(
  target: PluginPolicyOverrideTarget,
  action: PluginPolicyOverrideAction,
): string {
  return `plugin-policy:${createHash("sha256").update(JSON.stringify([action, pluginPolicyOverrideTargetKey(target)])).digest("hex")}`;
}

function pluginPolicyOverrideTargetKey(target: PluginPolicyOverrideTarget): string {
  return JSON.stringify([target.pluginId, target.scope, target.workspaceId ?? "", target.orgId ?? ""]);
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
