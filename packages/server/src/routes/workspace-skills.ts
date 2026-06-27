import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { recordAudit } from "../audit.js";
import { fetchOrgSkillsCatalog } from "../den-catalog.js";
import { ApiError } from "../errors.js";
import { workspaceResourceOwner } from "../resource-owner.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  requireApproval,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import { addRoute, type Route } from "../routing.js";
import { installHubSkill } from "../skill-hub.js";
import { listDisabledSkills } from "../skill-enabled-overrides.js";
import { resolveSkillMatch } from "../skill-resolver.js";
import {
  deleteSkillAtPathRecoverable,
  deleteSkillRecoverable,
  listSkills,
  readSkillAtPath,
  updateSkillAtPath,
  upsertSkill,
} from "../skills.js";
import type { WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";

export type WorkspaceSkillRouteDependencies = {
  serverDataDir: string;
};

const ownerForWorkspace = (workspace: WorkspaceInfo) =>
  workspaceResourceOwner({ workspaceId: workspace.id, root: workspace.path, label: workspace.name });

const trimmedSearchParam = (params: URLSearchParams, key: string): string | undefined => {
  const value = params.get(key)?.trim();
  return value || undefined;
};

export function registerWorkspaceSkillRoutes(
  routes: Route[],
  dependencies: WorkspaceSkillRouteDependencies,
): void {
  const { serverDataDir } = dependencies;

  const listWorkspaceRuntimeSkills = async (
    workspace: WorkspaceInfo,
    options: { includeGlobal: boolean; includeDisabled?: boolean },
  ) => {
    const disabledSkills = await listDisabledSkills({
      dataDir: serverDataDir,
      workspaceId: workspace.id,
      includeGlobal: true,
    });
    return listSkills(workspace.path, {
      includeGlobal: options.includeGlobal,
      includeDisabled: options.includeDisabled,
      disabledSkills,
      workspaceId: workspace.id,
      workspaceOwner: ownerForWorkspace(workspace),
    });
  };

  addRoute(routes, "GET", "/hub/skills", "client", async (ctx) => {
    const denToken = ctx.request.headers.get("x-veslo-den-token")?.trim() || "";
    if (!denToken) {
      throw new ApiError(401, "den_token_required", "Missing Den token header (x-veslo-den-token)");
    }

    const denOrgId = ctx.request.headers.get("x-veslo-den-org-id")?.trim() || "";
    if (!denOrgId) {
      throw new ApiError(400, "den_org_required", "Missing Den org header (x-veslo-den-org-id)");
    }

    const denApiBase = ctx.config.denApiBase?.trim() || "";
    if (!denApiBase) {
      return jsonResponse({ items: [] });
    }

    const items = await fetchOrgSkillsCatalog({
      baseUrl: denApiBase,
      orgId: denOrgId,
      denToken,
    });

    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const includeDisabled = ctx.url.searchParams.get("includeDisabled") === "true";
    const items = await listWorkspaceRuntimeSkills(workspace, { includeGlobal, includeDisabled });
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/skills/resolve", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const text = typeof body.text === "string" ? body.text : "";
    const includeGlobal = body?.includeGlobal === true || ctx.url.searchParams.get("includeGlobal") === "true";
    const threshold = typeof body.threshold === "number" ? body.threshold : undefined;
    const ambiguityDelta = typeof body.ambiguityDelta === "number" ? body.ambiguityDelta : undefined;
    const maxCandidates = typeof body.maxCandidates === "number" ? body.maxCandidates : undefined;
    const skills = await listWorkspaceRuntimeSkills(workspace, { includeGlobal });
    const result = resolveSkillMatch({
      text,
      skills,
      threshold,
      ambiguityDelta,
      maxCandidates,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/skills/hub/:name", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const body = await readJsonBody(ctx.request);
    const overwrite = body?.overwrite === true;
    const repoPayload = body?.repo && typeof body.repo === "object" ? (body.repo as Record<string, unknown>) : undefined;
    const repo = repoPayload
      ? {
          owner: typeof repoPayload.owner === "string" ? repoPayload.owner : undefined,
          repo: typeof repoPayload.repo === "string" ? repoPayload.repo : undefined,
          ref: typeof repoPayload.ref === "string" ? repoPayload.ref : undefined,
        }
      : undefined;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.install_hub",
      summary: `Install hub skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });

    const result = await installHubSkill(workspace.path, { name, overwrite, repo });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.install_hub",
      target: result.path,
      summary: `Installed hub skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });

    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/:name", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const includeDisabled = ctx.url.searchParams.get("includeDisabled") === "true";
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const items = await listWorkspaceRuntimeSkills(workspace, { includeGlobal, includeDisabled });
    const instancePath = ctx.url.searchParams.get("path")?.trim() ?? "";
    if (instancePath) {
      const allowedItem = items.find((skill) => skill.name === name && resolve(skill.path) === resolve(instancePath));
      if (!allowedItem) {
        throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
      }
      const result = await readSkillAtPath(workspace.path, { name, path: instancePath });
      return jsonResponse({
        item: allowedItem,
        content: result.content,
      });
    }
    const item = items.find((skill) => skill.name === name);
    if (!item) {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    const content = await readFile(item.path, "utf8");
    return jsonResponse({ item, content });
  });

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    const instancePath = typeof body.path === "string" ? body.path.trim() : "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [instancePath || join(workspace.path, ".opencode", "skills", name, "SKILL.md")],
    });
    const result = instancePath
      ? await updateSkillAtPath(workspace.path, { name, path: instancePath, content, description })
      : await upsertSkill(workspace.path, { name, content, description });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.upsert",
      target: result.path,
      summary: `Upserted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });
    return jsonResponse({ name, path: result.path, description: description ?? "", scope: "project" });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skills/:name", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const instancePath = ctx.url.searchParams.get("path")?.trim() ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.delete",
      summary: `Delete skill ${name}`,
      paths: [instancePath || join(workspace.path, ".opencode", "skills", name)],
    });
    const result = instancePath
      ? await deleteSkillAtPathRecoverable(workspace.path, { name, path: instancePath }, {
          dataDir: serverDataDir,
          workspaceId: workspace.id,
          actor: ctx.actor ?? { type: "remote" },
          reason: trimmedSearchParam(ctx.url.searchParams, "reason"),
        })
      : await deleteSkillRecoverable(workspace.path, name, {
          dataDir: serverDataDir,
          workspaceId: workspace.id,
          actor: ctx.actor ?? { type: "remote" },
          reason: trimmedSearchParam(ctx.url.searchParams, "reason"),
        });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.delete",
      target: result.path,
      summary: `Deleted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: "removed",
      path: result.path,
    });
    return jsonResponse({ ok: true, name, path: result.path, removalId: result.removalId });
  });
}
