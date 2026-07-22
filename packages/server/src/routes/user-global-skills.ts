import { recordAudit } from "../audit.js";
import { invalidateActiveRuntimeSkillView } from "../active-runtime-skill-view.js";
import { ApiError } from "../errors.js";
import { addRoute, type RequestContext, type Route } from "../routing.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  requireClientScope,
  resolveWorkspace,
  scopeRank,
} from "../route-helpers.js";
import {
  deleteGlobalSkillRecoverable,
  disabledRecordMatchesSkill,
  readGlobalSkillAtPath,
  readGlobalSkillFilesAtPath,
} from "../skills.js";
import { listDisabledSkills } from "../skill-enabled-overrides.js";
import type { Actor } from "../types.js";
import {
  deleteUserGlobalSkill,
  listUserGlobalSkills,
  readUserGlobalSkill,
  upsertUserGlobalSkill,
  userGlobalSkillStorePath,
} from "../user-skill-store.js";
import { shortId } from "../utils.js";

export type UserGlobalSkillRouteDependencies = {
  serverDataDir: string;
  resolveActor: (ctx: RequestContext) => Promise<Actor>;
};

function trimmedSearchParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value || undefined;
}

async function requireRouteActor(ctx: RequestContext, resolveActor: UserGlobalSkillRouteDependencies["resolveActor"]): Promise<Actor> {
  return ctx.actor ?? await resolveActor(ctx);
}

export function registerUserGlobalSkillRoutes(
  routes: Route[],
  dependencies: UserGlobalSkillRouteDependencies,
): void {
  const { serverDataDir, resolveActor } = dependencies;

  addRoute(routes, "GET", "/skills/user-global-store", "client", async () => {
    return jsonResponse({ items: await listUserGlobalSkills(serverDataDir) });
  });

  addRoute(routes, "GET", "/skills/user-global-store/:name", "client", async (ctx) => {
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    return jsonResponse(await readUserGlobalSkill(name, serverDataDir));
  });

  addRoute(routes, "GET", "/skills/user-global-store/:name/files", "client", async (ctx) => {
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const result = await readUserGlobalSkill(name, serverDataDir);
    return jsonResponse({
      item: result.item,
      files: [{
        path: "SKILL.md",
        sizeBytes: Buffer.byteLength(result.content, "utf8"),
        mediaType: "text/markdown",
        text: result.content,
      }],
    });
  });

  addRoute(routes, "POST", "/skills/user-global-store", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "").trim();
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    const result = await upsertUserGlobalSkill({ name, content, description, enabled }, serverDataDir);
    for (const workspace of ctx.config.workspaces) {
      if (workspace.workspaceType === "local") invalidateActiveRuntimeSkillView(workspace);
    }

    await recordAudit(userGlobalSkillStorePath(serverDataDir), {
      id: shortId(),
      workspaceId: "global",
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.user_global_store.upsert",
      target: result.item.path,
      summary: `Upserted user-global skill ${result.item.name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      ok: true,
      action: result.action,
      item: result.item,
      reloadRequired: true,
      trigger: {
        type: "skill",
        name: result.item.name,
        action: result.action,
        path: result.item.path,
        scope: "user-global",
      },
    });
  });

  addRoute(routes, "DELETE", "/skills/user-global-store/:name", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const result = await deleteUserGlobalSkill(name, serverDataDir);
    for (const workspace of ctx.config.workspaces) {
      if (workspace.workspaceType === "local") invalidateActiveRuntimeSkillView(workspace);
    }

    await recordAudit(userGlobalSkillStorePath(serverDataDir), {
      id: shortId(),
      workspaceId: "global",
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.user_global_store.delete",
      target: result.item.path,
      summary: `Deleted user-global skill ${result.item.name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      ok: true,
      name: result.item.name,
      path: result.item.path,
      reloadRequired: true,
      trigger: {
        type: "skill",
        name: result.item.name,
        action: "removed",
        path: result.item.path,
        scope: "user-global",
      },
    });
  });

  addRoute(routes, "GET", "/skills/user-global/:name", "hostOrClient", async (ctx) => {
    await requireRouteActor(ctx, resolveActor);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const instancePath = trimmedSearchParam(ctx.url.searchParams, "path");
    if (!instancePath) {
      throw new ApiError(400, "invalid_skill_path", "User-global exact skill read requires path");
    }
    const result = await readGlobalSkillAtPath({ name, path: instancePath });
    const item = {
      name,
      path: result.path,
      description: "",
      scope: "global" as const,
    };
    const disabledSkills = await listDisabledSkills({
      dataDir: serverDataDir,
      includeGlobal: true,
    });
    const disabled = disabledSkills.some((record) => disabledRecordMatchesSkill(record, item, undefined));
    if (disabled && ctx.url.searchParams.get("includeDisabled") !== "true") {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    return jsonResponse({
      item: disabled ? { ...item, enabled: false, disabledReason: "user" } : item,
      content: result.content,
    });
  });

  addRoute(routes, "GET", "/skills/user-global/:name/files", "hostOrClient", async (ctx) => {
    await requireRouteActor(ctx, resolveActor);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const instancePath = trimmedSearchParam(ctx.url.searchParams, "path");
    if (!instancePath) {
      throw new ApiError(400, "invalid_skill_path", "User-global exact skill file read requires path");
    }
    const result = await readGlobalSkillFilesAtPath({ name, path: instancePath });
    const item = {
      name,
      path: result.path,
      description: "",
      scope: "global" as const,
    };
    const disabledSkills = await listDisabledSkills({
      dataDir: serverDataDir,
      includeGlobal: true,
    });
    const disabled = disabledSkills.some((record) => disabledRecordMatchesSkill(record, item, undefined));
    if (disabled && ctx.url.searchParams.get("includeDisabled") !== "true") {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    return jsonResponse({
      item: disabled ? { ...item, enabled: false, disabledReason: "user" } : item,
      files: result.files,
    });
  });

  addRoute(routes, "DELETE", "/skills/user-global/:name", "hostOrClient", async (ctx) => {
    ensureWritable(ctx.config);
    const actor = await requireRouteActor(ctx, resolveActor);
    if (scopeRank(actor.scope ?? "viewer") < scopeRank("collaborator")) {
      throw new ApiError(403, "forbidden", "Insufficient token scope", {
        required: "collaborator",
        scope: actor.scope,
      });
    }
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const result = await deleteGlobalSkillRecoverable(
      name,
      { path: trimmedSearchParam(ctx.url.searchParams, "path") },
      {
        dataDir: serverDataDir,
        actor,
        reason: trimmedSearchParam(ctx.url.searchParams, "reason"),
      },
    );
    const reloadTrigger = {
      type: "skill" as const,
      name,
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
    return jsonResponse({
      ok: true,
      name,
      path: result.path,
      removalId: result.removalId,
      reloadRequired: true,
      trigger: { ...reloadTrigger, scope: "user-global" },
    });
  });
}
