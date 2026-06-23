import { createHash } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

import { resolveVesloDataDir } from "./audit.js";
import { ApiError } from "./errors.js";
import type {
  Actor,
  DisabledSkillRecord,
  DisabledSkillTarget,
  SkillEnabledOverridesDocument,
  SkillEnabledRegistryIdentity,
  SkillEnabledScope,
  TokenScope,
} from "./types.js";
import { ensureDir } from "./utils.js";
import { validateSkillName } from "./validators.js";

export type SetSkillEnabledStateInput = {
  dataDir?: string;
  target: DisabledSkillTarget;
  enabled: boolean;
  actor?: Actor;
};

type SetSkillEnabledStateResult = {
  ok: true;
  enabled: boolean;
  record?: DisabledSkillRecord;
};

const STORE_FILE = "skill-enabled-overrides.json";
const SCOPES = new Set<SkillEnabledScope>(["workspace", "user-global", "organization", "platform"]);
const REGISTRY_SOURCES = new Set(["personal", "workspace", "organization", "platform"]);
const TOKEN_SCOPES = new Set<TokenScope>(["owner", "collaborator", "viewer"]);
const DISABLED_BY_MAX_LENGTH = 256;
const mutationQueues = new Map<string, Promise<void>>();

export async function listDisabledSkills(input: {
  dataDir?: string;
  workspaceId?: string;
  includeGlobal?: boolean;
} = {}): Promise<DisabledSkillRecord[]> {
  const document = await readStore(input.dataDir);
  const workspaceId = normalizeOptionalString(input.workspaceId, "workspaceId");
  const includeGlobal = input.includeGlobal ?? true;

  return document.disabled.filter((record) => {
    if (record.workspaceId) {
      return Boolean(workspaceId) && record.workspaceId === workspaceId;
    }
    return includeGlobal;
  });
}

export async function setSkillEnabledState(input: SetSkillEnabledStateInput): Promise<SetSkillEnabledStateResult> {
  if (typeof input.enabled !== "boolean") {
    throw new ApiError(400, "invalid_payload", "enabled must be a boolean");
  }

  const target = normalizeTarget(input.target);
  const id = disabledSkillTargetId(target);

  return mutateStore<SetSkillEnabledStateResult>(input.dataDir, (document) => {
    const existingIndex = document.disabled.findIndex((record) => record.id === id);

    if (input.enabled) {
      if (existingIndex !== -1) {
        document.disabled.splice(existingIndex, 1);
      }
      return {
        document,
        result: { ok: true as const, enabled: true },
      };
    }

    const existing = existingIndex === -1 ? undefined : document.disabled[existingIndex];
    const record: DisabledSkillRecord = {
      id,
      ...target,
      disabledAt: existing?.disabledAt ?? new Date().toISOString(),
      ...(input.actor
        ? { disabledBy: normalizeActorIdentity(input.actor) }
        : existing?.disabledBy
          ? { disabledBy: existing.disabledBy }
          : {}),
    };

    if (existingIndex === -1) {
      document.disabled.push(record);
    } else {
      document.disabled[existingIndex] = record;
    }
    return {
      document,
      result: { ok: true as const, enabled: false, record },
    };
  });
}

export function disabledSkillRecordMatchesTarget(
  record: DisabledSkillRecord,
  target: DisabledSkillTarget,
): boolean {
  return record.id === disabledSkillTargetId(normalizeTarget(target));
}

function resolveDataDir(dataDir?: string): string {
  const trimmed = dataDir?.trim();
  return trimmed ? resolve(trimmed) : resolveVesloDataDir();
}

function storePath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), STORE_FILE);
}

async function readStore(dataDir?: string): Promise<SkillEnabledOverridesDocument> {
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
    throw new ApiError(422, "invalid_json", "Failed to parse skill enabled overrides");
  }

  const source = isRecord(parsed) && Array.isArray(parsed.disabled) ? parsed.disabled : [];
  return {
    schemaVersion: 1,
    disabled: source.map(normalizeStoredRecord).filter((record): record is DisabledSkillRecord => Boolean(record)),
  };
}

async function writeStore(dataDir: string | undefined, document: SkillEnabledOverridesDocument): Promise<void> {
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
  mutate: (document: SkillEnabledOverridesDocument) => { document: SkillEnabledOverridesDocument; result: T },
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

function emptyStore(): SkillEnabledOverridesDocument {
  return { schemaVersion: 1, disabled: [] };
}

function normalizeStoredRecord(value: unknown): DisabledSkillRecord | null {
  if (!isRecord(value)) return null;
  try {
    const target = normalizeTarget({
      name: value.name,
      scope: value.scope,
      workspaceId: value.workspaceId,
      path: value.path,
      registry: isRecord(value.registry) ? value.registry : undefined,
    } as DisabledSkillTarget);
    const disabledBy = normalizeStoredDisabledBy(value.disabledBy);
    return {
      id: disabledSkillTargetId(target),
      ...target,
      disabledAt: normalizeIsoString(value.disabledAt) ?? new Date(0).toISOString(),
      ...(disabledBy ? { disabledBy } : {}),
    };
  } catch {
    return null;
  }
}

function normalizeTarget(target: DisabledSkillTarget): DisabledSkillTarget {
  if (!target || typeof target !== "object") {
    throw new ApiError(400, "invalid_payload", "target is required");
  }

  const name = normalizeOptionalString(target.name, "target.name");
  if (!name) {
    throw new ApiError(400, "invalid_skill_name", "Skill name is required");
  }
  validateSkillName(name);

  const scope = target.scope;
  if (!SCOPES.has(scope)) {
    throw new ApiError(400, "invalid_scope", "Skill enabled scope is invalid");
  }

  const workspaceId = normalizeOptionalString(target.workspaceId, "target.workspaceId");
  if (scope === "workspace" && !workspaceId) {
    throw new ApiError(400, "invalid_workspace_id", "Workspace skill overrides require a workspace id");
  }

  const path = normalizePath(target.path, name);
  const registry = normalizeRegistry(target.registry);
  return {
    name,
    scope,
    ...(workspaceId ? { workspaceId } : {}),
    ...(path ? { path } : {}),
    ...(registry ? { registry } : {}),
  };
}

function normalizeRegistry(registry: SkillEnabledRegistryIdentity | undefined): SkillEnabledRegistryIdentity | undefined {
  if (!registry) return undefined;
  if (typeof registry !== "object") {
    throw new ApiError(400, "invalid_payload", "target.registry must be an object");
  }

  const normalized = {
    skillId: normalizeOptionalString(registry.skillId, "target.registry.skillId"),
    installationId: normalizeOptionalString(registry.installationId, "target.registry.installationId"),
    policyId: normalizeOptionalString(registry.policyId, "target.registry.policyId"),
    versionId: normalizeOptionalString(registry.versionId, "target.registry.versionId"),
    source: normalizeOptionalString(registry.source, "target.registry.source") as SkillEnabledRegistryIdentity["source"],
  };

  if (normalized.source && !REGISTRY_SOURCES.has(normalized.source)) {
    throw new ApiError(400, "invalid_payload", "target.registry.source is invalid");
  }

  const result: SkillEnabledRegistryIdentity = {};
  if (normalized.skillId) result.skillId = normalized.skillId;
  if (normalized.installationId) result.installationId = normalized.installationId;
  if (normalized.policyId) result.policyId = normalized.policyId;
  if (normalized.versionId) result.versionId = normalized.versionId;
  if (normalized.source) result.source = normalized.source;
  return Object.keys(result).length ? result : undefined;
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

function normalizeStoredDisabledBy(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return normalizeStoredIdentityString(value);
  if (isRecord(value)) return normalizeActorIdentity(value);
  return undefined;
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeStoredIdentityString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  return trimmed.length > DISABLED_BY_MAX_LENGTH ? trimmed.slice(0, DISABLED_BY_MAX_LENGTH) : trimmed;
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

function normalizePath(value: unknown, name: string): string | undefined {
  const path = normalizeOptionalString(value, "target.path", 4096);
  if (!path) return undefined;
  const pathApi = path.startsWith("/") || posix.isAbsolute(path)
    ? posix
    : win32.isAbsolute(path)
      ? win32
      : null;
  if (!pathApi) {
    throw new ApiError(400, "invalid_skill_path", "Skill path must be absolute");
  }
  const normalized = pathApi.normalize(path);
  if (!pathApi.isAbsolute(normalized)) {
    throw new ApiError(400, "invalid_skill_path", "Skill path must be absolute");
  }
  if (pathApi.basename(normalized) !== "SKILL.md") {
    throw new ApiError(400, "invalid_skill_path", "Skill path must point to SKILL.md");
  }
  if (pathApi.basename(pathApi.dirname(normalized)) !== name) {
    throw new ApiError(400, "invalid_skill_path", "Skill path parent directory must match skill name");
  }
  return normalized;
}

function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !Number.isNaN(Date.parse(trimmed)) ? trimmed : undefined;
}

function disabledSkillTargetId(target: DisabledSkillTarget): string {
  const identity = target.registry?.policyId
    ? ["registry-policy", target.registry.policyId]
    : target.registry?.installationId
      ? ["registry-installation", target.registry.installationId]
      : target.path
        ? ["path", target.scope, target.workspaceId ?? "", target.path]
        : ["name", target.scope, target.workspaceId ?? "", target.name];

  return `skill-disabled:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
