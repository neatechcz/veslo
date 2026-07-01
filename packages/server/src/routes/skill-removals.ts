import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { addRoute, type RequestContext, type Route } from "../routing.js";
import {
  ensureWritable,
  emitReloadEvent,
  jsonResponse,
  readJsonBody,
  resolveWorkspace,
  scopeRank,
} from "../route-helpers.js";
import {
  deleteGlobalSkillRecoverable,
  deleteSkillAtPathRecoverable,
  deleteSkillRecoverable,
} from "../skills.js";
import {
  userGlobalSkillRootsForMutation,
  workspaceSkillRootsForMutation,
} from "../skill-roots.js";
import {
  listSkillRemovals,
  readSkillRemovalRecord,
  restoreSkillRemoval,
  type SkillRemovalRecord,
  type SkillRemovalScope,
} from "../skill-removal-journal.js";
import {
  deleteRegistrySkillInstallation,
  updateRegistrySkillRolloutPolicy,
} from "../skill-registry-client.js";
import type { Actor, ReloadTrigger } from "../types.js";
import { shortId } from "../utils.js";

const SKILL_BATCH_REMOVE_MAX_ITEMS = 50;

export type SkillRemovalRouteDependencies = {
  serverDataDir: string;
  resolveActor: (ctx: RequestContext) => Promise<Actor>;
};

type SkillBatchRemoveScope = "workspace" | "user-global" | "organization";

type SkillBatchRemoveItem = {
  id?: string;
  index: number;
  name: string;
  scope: SkillBatchRemoveScope;
  path?: string;
  workspaceId?: string;
  reason?: string;
  registry?: {
    installationId?: string;
    policyId?: string;
  };
};

type SkillBatchRemoveSuccess = {
  id?: string;
  index: number;
  ok: true;
  name: string;
  scope: SkillBatchRemoveScope;
  path?: string;
  removalId?: string;
  reloadRequired?: boolean;
  registry?: {
    installationId?: string;
    policyId?: string;
  };
  trigger?: ReloadTrigger & { scope?: SkillBatchRemoveScope };
};

type SkillBatchRemoveFailure = {
  id?: string;
  index: number;
  ok: false;
  name?: string;
  scope?: string;
  code: string;
  message: string;
  status: number;
  details?: unknown;
};

type SkillRemovalListItem = {
  id: string;
  name: string;
  scope: SkillRemovalScope;
  workspaceId?: string;
  path: string;
  reason?: string;
  status: "removed" | "restored";
  removedAt: string;
  restoredAt?: string;
  canRestore: boolean;
};

function trimmedSearchParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value || undefined;
}

function parseSkillRemovalScope(value: string | undefined): SkillRemovalScope | undefined {
  if (!value) return undefined;
  if (value === "workspace" || value === "user-global") return value;
  throw new ApiError(400, "invalid_scope", "Skill removal scope must be workspace or user-global");
}

function optionalRecordString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function parseSkillBatchRemoveItem(value: unknown, index: number): SkillBatchRemoveItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_skill_batch_item", "Skill batch item must be an object");
  }
  const record = value as Record<string, unknown>;
  const name = optionalRecordString(record, "name");
  if (!name) {
    throw new ApiError(400, "invalid_skill_batch_item", "Skill batch item name is required");
  }
  const rawScope = optionalRecordString(record, "scope");
  if (rawScope !== "workspace" && rawScope !== "user-global" && rawScope !== "organization") {
    throw new ApiError(
      400,
      "invalid_skill_batch_item",
      "Skill batch item scope must be workspace, user-global, or organization",
    );
  }
  const registryValue = record.registry;
  let registry: SkillBatchRemoveItem["registry"];
  if (registryValue !== undefined) {
    if (!registryValue || typeof registryValue !== "object" || Array.isArray(registryValue)) {
      throw new ApiError(400, "invalid_skill_batch_item", "Skill batch item registry must be an object");
    }
    const registryRecord = registryValue as Record<string, unknown>;
    const installationId = optionalRecordString(registryRecord, "installationId");
    const policyId = optionalRecordString(registryRecord, "policyId");
    if (installationId && policyId) {
      throw new ApiError(
        400,
        "invalid_skill_batch_item",
        "Skill batch item must not include both registry.installationId and registry.policyId",
      );
    }
    if (installationId || policyId) registry = { installationId, policyId };
  }

  return {
    index,
    name,
    scope: rawScope,
    ...(optionalRecordString(record, "id") ? { id: optionalRecordString(record, "id") } : {}),
    ...(optionalRecordString(record, "path") ? { path: optionalRecordString(record, "path") } : {}),
    ...(optionalRecordString(record, "workspaceId") ? { workspaceId: optionalRecordString(record, "workspaceId") } : {}),
    ...(optionalRecordString(record, "reason") ? { reason: optionalRecordString(record, "reason") } : {}),
    ...(registry ? { registry } : {}),
  };
}

function skillBatchRemoveFailure(
  value: unknown,
  index: number,
  error: unknown,
): SkillBatchRemoveFailure {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "internal_error", "Unexpected server error");
  return {
    ...(optionalRecordString(record, "id") ? { id: optionalRecordString(record, "id") } : {}),
    index,
    ok: false,
    ...(optionalRecordString(record, "name") ? { name: optionalRecordString(record, "name") } : {}),
    ...(optionalRecordString(record, "scope") ? { scope: optionalRecordString(record, "scope") } : {}),
    code: apiError.code,
    message: apiError.message,
    status: apiError.status,
    ...(apiError.details !== undefined ? { details: apiError.details } : {}),
  };
}

function serializeSkillRemoval(record: SkillRemovalRecord): SkillRemovalListItem {
  return {
    id: record.id,
    name: record.name,
    scope: record.scope,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    path: record.originalPath,
    ...(record.reason ? { reason: record.reason } : {}),
    status: record.restoredAt ? "restored" : "removed",
    removedAt: record.removedAt ?? "",
    ...(record.restoredAt ? { restoredAt: record.restoredAt } : {}),
    canRestore: !record.restoredAt,
  };
}

function normalizeSkillRegistryBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function skillRegistryRequestBaseUrl(ctx: RequestContext): string {
  return (
    ctx.config.skillRegistryBaseUrl?.trim() ||
    normalizeSkillRegistryBaseUrl(ctx.request.headers.get("x-veslo-den-api-base"))
  );
}

function requireSkillRegistryRequestBaseUrl(ctx: RequestContext): void {
  if (!skillRegistryRequestBaseUrl(ctx)) {
    throw new ApiError(503, "skill_registry_misconfigured", "Skill registry base URL is missing");
  }
}

function skillRegistryRequestInput(ctx: RequestContext) {
  const userId = ctx.request.headers.get("x-veslo-den-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-account-id")?.trim() ||
    undefined;
  return {
    baseUrl: skillRegistryRequestBaseUrl(ctx),
    token: ctx.config.skillRegistryToken?.trim() || undefined,
    denToken: ctx.request.headers.get("x-veslo-den-token")?.trim() || undefined,
    orgId: ctx.request.headers.get("x-veslo-den-org-id")?.trim() || undefined,
    userId,
  };
}

export function registerSkillRemovalRoutes(
  routes: Route[],
  dependencies: SkillRemovalRouteDependencies,
): void {
  const { serverDataDir, resolveActor } = dependencies;

  addRoute(routes, "GET", "/skill-removals", "none", async (ctx) => {
    const actor = await resolveActor(ctx);
    if (scopeRank(actor.scope ?? "viewer") < scopeRank("collaborator")) {
      throw new ApiError(403, "forbidden", "Insufficient token scope", {
        required: "collaborator",
        scope: actor.scope,
      });
    }
    const includeRestored = trimmedSearchParam(ctx.url.searchParams, "includeRestored") === "true";
    const scope = parseSkillRemovalScope(trimmedSearchParam(ctx.url.searchParams, "scope")) ?? "workspace";
    const workspaceId = trimmedSearchParam(ctx.url.searchParams, "workspaceId");
    let items = await listSkillRemovals({
      dataDir: serverDataDir,
      scope,
      includeRestored,
    });
    if (scope === "workspace") {
      if (workspaceId) {
        const workspace = await resolveWorkspace(ctx.config, workspaceId);
        items = items.filter((record) => record.workspaceId === workspace.id);
      } else {
        const visibleWorkspaceIds = new Set<string>();
        for (const workspace of ctx.config.workspaces) {
          try {
            const resolved = await resolveWorkspace(ctx.config, workspace.id);
            visibleWorkspaceIds.add(resolved.id);
          } catch {
            // Skip workspaces that are no longer authorized for this server.
          }
        }
        items = items.filter((record) => record.workspaceId && visibleWorkspaceIds.has(record.workspaceId));
      }
    } else if (actor.type !== "host" && actor.scope !== "owner") {
      throw new ApiError(403, "forbidden", "Owner or host access is required for user-global skill removals");
    }
    return jsonResponse({ items: items.map(serializeSkillRemoval) });
  });

  addRoute(routes, "POST", "/skill-removals/:id/restore", "host", async (ctx) => {
    ensureWritable(ctx.config);
    const record = await readSkillRemovalRecord({ dataDir: serverDataDir, removalId: ctx.params.id });
    let workspace = null;
    let skillRoots: string[] | undefined;
    if (record.scope === "workspace") {
      if (!record.workspaceId) {
        throw new ApiError(400, "invalid_skill_removal_record", "Workspace skill removal is missing a workspace id");
      }
      workspace = await resolveWorkspace(ctx.config, record.workspaceId);
      skillRoots = await workspaceSkillRootsForMutation(workspace.path);
    }
    const result = await restoreSkillRemoval({
      dataDir: serverDataDir,
      removalId: ctx.params.id,
      actor: ctx.actor ?? { type: "host" },
      ...(workspace && skillRoots
        ? {
            workspace: {
              id: workspace.id,
              rootDir: workspace.path,
              skillRoots,
            },
            authorizedRoots: ctx.config.authorizedRoots,
          }
        : record.scope === "user-global"
          ? { userGlobalSkillRoots: userGlobalSkillRootsForMutation() }
          : {}),
    });
    const reloadTrigger = {
      type: "skill" as const,
      name: record.name,
      action: "added" as const,
      path: result.path,
    };
    if (workspace) {
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "host" },
        action: "skills.restore",
        target: result.path,
        summary: `Restored skill ${record.name}`,
        timestamp: Date.now(),
      });
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", reloadTrigger);
    } else if (record.scope === "user-global") {
      for (const configuredWorkspace of ctx.config.workspaces) {
        try {
          const resolved = await resolveWorkspace(ctx.config, configuredWorkspace.id);
          emitReloadEvent(ctx.reloadEvents, resolved, "skills", reloadTrigger);
        } catch {
          // Skip workspaces that are no longer authorized for this server.
        }
      }
    }
    return jsonResponse({
      ok: true,
      ...result,
      reloadRequired: true,
      trigger: { ...reloadTrigger, scope: record.scope },
    });
  });

  const removeSkillBatchItem = async (
    ctx: RequestContext,
    item: SkillBatchRemoveItem,
  ): Promise<SkillBatchRemoveSuccess> => {
    const installationId = item.registry?.installationId?.trim() ?? "";
    if (installationId) {
      requireSkillRegistryRequestBaseUrl(ctx);
      await deleteRegistrySkillInstallation({
        ...skillRegistryRequestInput(ctx),
        installationId,
      });
      const trigger = { type: "skill" as const, name: item.name, action: "removed" as const };
      return {
        id: item.id,
        index: item.index,
        ok: true,
        name: item.name,
        scope: item.scope,
        registry: { installationId },
        reloadRequired: true,
        trigger: { ...trigger, scope: item.scope },
      };
    }

    const policyId = item.registry?.policyId?.trim() ?? "";
    if (policyId) {
      requireSkillRegistryRequestBaseUrl(ctx);
      await updateRegistrySkillRolloutPolicy({
        ...skillRegistryRequestInput(ctx),
        policyId,
        enabled: false,
      });
      const trigger = { type: "skill" as const, name: item.name, action: "removed" as const };
      return {
        id: item.id,
        index: item.index,
        ok: true,
        name: item.name,
        scope: item.scope,
        registry: { policyId },
        reloadRequired: true,
        trigger: { ...trigger, scope: item.scope },
      };
    }

    if (item.scope === "workspace") {
      const workspaceId = item.workspaceId?.trim() ?? "";
      if (!workspaceId) {
        throw new ApiError(400, "invalid_skill_batch_item", "Workspace skill batch item requires workspaceId");
      }
      const workspace = await resolveWorkspace(ctx.config, workspaceId);
      const result = item.path
        ? await deleteSkillAtPathRecoverable(workspace.path, { name: item.name, path: item.path }, {
            dataDir: serverDataDir,
            workspaceId: workspace.id,
            actor: ctx.actor ?? { type: "host" },
            reason: item.reason,
          })
        : await deleteSkillRecoverable(workspace.path, item.name, {
            dataDir: serverDataDir,
            workspaceId: workspace.id,
            actor: ctx.actor ?? { type: "host" },
            reason: item.reason,
          });
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "host" },
        action: "skills.delete",
        target: result.path,
        summary: `Deleted skill ${item.name}`,
        timestamp: Date.now(),
      });
      const reloadTrigger = {
        type: "skill" as const,
        name: item.name,
        action: "removed" as const,
        path: result.path,
      };
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", reloadTrigger);
      return {
        id: item.id,
        index: item.index,
        ok: true,
        name: item.name,
        scope: item.scope,
        path: result.path,
        removalId: result.removalId,
        reloadRequired: true,
        trigger: { ...reloadTrigger, scope: item.scope },
      };
    }

    if (item.scope === "user-global") {
      const result = await deleteGlobalSkillRecoverable(
        item.name,
        { path: item.path },
        {
          dataDir: serverDataDir,
          actor: ctx.actor ?? { type: "host" },
          reason: item.reason,
        },
      );
      const reloadTrigger = {
        type: "skill" as const,
        name: item.name,
        action: "removed" as const,
        path: result.path,
      };
      for (const configuredWorkspace of ctx.config.workspaces) {
        try {
          const resolved = await resolveWorkspace(ctx.config, configuredWorkspace.id);
          emitReloadEvent(ctx.reloadEvents, resolved, "skills", reloadTrigger);
        } catch {
          // Skip workspaces that are no longer authorized for this server.
        }
      }
      return {
        id: item.id,
        index: item.index,
        ok: true,
        name: item.name,
        scope: item.scope,
        path: result.path,
        removalId: result.removalId,
        reloadRequired: true,
        trigger: { ...reloadTrigger, scope: item.scope },
      };
    }

    throw new ApiError(400, "invalid_skill_batch_item", "Organization skills require registry mutation metadata");
  };

  addRoute(routes, "POST", "/skills/batch-remove", "host", async (ctx) => {
    ensureWritable(ctx.config);
    const body = await readJsonBody(ctx.request);
    if (!Array.isArray(body.items)) {
      throw new ApiError(400, "invalid_skill_batch_request", "Field items must be an array");
    }
    if (body.items.length > SKILL_BATCH_REMOVE_MAX_ITEMS) {
      throw new ApiError(
        400,
        "invalid_skill_batch_request",
        `Field items must contain at most ${SKILL_BATCH_REMOVE_MAX_ITEMS} entries`,
      );
    }

    const results: Array<SkillBatchRemoveSuccess | SkillBatchRemoveFailure> = [];
    for (const [index, rawItem] of body.items.entries()) {
      try {
        const item = parseSkillBatchRemoveItem(rawItem, index);
        results.push(await removeSkillBatchItem(ctx, item));
      } catch (error) {
        results.push(skillBatchRemoveFailure(rawItem, index, error));
      }
    }

    const succeeded = results.filter((result) => result.ok).length;
    const failed = results.length - succeeded;
    return jsonResponse({
      ok: failed === 0,
      succeeded,
      failed,
      results,
    });
  });
}
