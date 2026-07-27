import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { recordAudit } from "../audit.js";
import { fetchOrgSkillsCatalog } from "../den-catalog.js";
import { ApiError } from "../errors.js";
import { requireConfiguredDenCatalogContext } from "../request-headers.js";
import { workspaceResourceOwner } from "../resource-owner.js";
import {
  ensureActiveRuntimeSkillView,
  invalidateActiveRuntimeSkillView,
} from "../active-runtime-skill-view.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  readOptionalJsonBody,
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
  readSkillFilesAtPath,
  updateSkillAtPath,
  upsertSkill,
} from "../skills.js";
import type { WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import { userGlobalMaterializedSkillsRoot } from "../user-skill-store.js";
import { withWorkspaceSkillLease } from "../workspace-skill-lease.js";

export type WorkspaceSkillRouteDependencies = {
  serverDataDir: string;
};

const ownerForWorkspace = (workspace: WorkspaceInfo) =>
  workspaceResourceOwner({
    workspaceId: workspace.id,
    root: workspace.path,
    label: workspace.name,
  });

const trimmedSearchParam = (
  params: URLSearchParams,
  key: string,
): string | undefined => {
  const value = params.get(key)?.trim();
  return value || undefined;
};

function requireRouteParam(
  params: Record<string, string>,
  field: string,
  label = field,
): string {
  const value = params[field]?.trim() ?? "";
  if (!value) {
    throw new ApiError(400, "invalid_payload", `${label} is required`);
  }
  return value;
}

export function registerWorkspaceSkillRoutes(
  routes: Route[],
  dependencies: WorkspaceSkillRouteDependencies,
): void {
  const { serverDataDir } = dependencies;

  const refreshWorkspaceRuntimeSkillView = async (
    workspace: WorkspaceInfo,
  ): Promise<void> => {
    invalidateActiveRuntimeSkillView(workspace);
    await ensureActiveRuntimeSkillView(workspace, {
      disabledSkills: await listDisabledSkills({
        dataDir: serverDataDir,
        workspaceId: workspace.id,
        includeGlobal: true,
      }),
      workspaceId: workspace.id,
      workspaceOwner: ownerForWorkspace(workspace),
      forceRefresh: true,
    });
  };

  const listWorkspaceRuntimeSkills = async (
    workspace: WorkspaceInfo,
    options: { includeGlobal?: boolean; includeDisabled?: boolean },
  ) => {
    const disabledSkills = await listDisabledSkills({
      dataDir: serverDataDir,
      workspaceId: workspace.id,
      includeGlobal: true,
    });
    const listOptions = {
      disabledSkills,
      workspaceId: workspace.id,
      workspaceOwner: ownerForWorkspace(workspace),
      ...(options.includeDisabled !== undefined
        ? { includeDisabled: options.includeDisabled }
        : {}),
    };
    if (options.includeGlobal === true) {
      // Compatibility management view: broad global discovery is never used
      // by active resolution or engine launch.
      const projectedRoot = resolve(
        userGlobalMaterializedSkillsRoot(workspace.path),
      );
      const seen = new Set<string>();
      return (
        await listSkills(workspace.path, {
          ...listOptions,
          includeGlobal: true,
          includeDuplicates: true,
        })
      )
        .filter(
          (skill) => !resolve(skill.path).startsWith(`${projectedRoot}${sep}`),
        )
        .filter((skill) => {
          if (seen.has(skill.name)) return false;
          seen.add(skill.name);
          return true;
        });
    }
    return (
      await withWorkspaceSkillLease(workspace.path, "runtime-skill-read", () =>
        ensureActiveRuntimeSkillView(workspace, {
          disabledSkills,
          workspaceId: workspace.id,
          workspaceOwner: ownerForWorkspace(workspace),
        }),
      )
    ).skills;
  };

  addRoute(routes, "GET", "/hub/skills", "client", async (ctx) => {
    const { denApiBase, denOrgId, denToken } =
      requireConfiguredDenCatalogContext(ctx);
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
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const includeDisabled =
      ctx.url.searchParams.get("includeDisabled") === "true";
    const items = await listWorkspaceRuntimeSkills(workspace, {
      includeGlobal,
      includeDisabled,
    });
    return jsonResponse({ items });
  });

  addRoute(
    routes,
    "POST",
    "/workspace/:id/skills/runtime-view",
    "client",
    async (ctx) => {
      const workspace = await resolveWorkspace(
        ctx.config,
        requireRouteParam(ctx.params, "id", "workspace id"),
      );
      const disabledSkills = await listDisabledSkills({
        dataDir: serverDataDir,
        workspaceId: workspace.id,
        includeGlobal: true,
      });
      const body = await readOptionalJsonBody(ctx.request);
      const expectedRevision =
        typeof body?.expectedRevision === "string"
          ? body.expectedRevision
          : undefined;
      const forceRefresh = body?.forceRefresh === true;
      const view = await withWorkspaceSkillLease(
        workspace.path,
        "runtime-skill-view",
        () =>
          ensureActiveRuntimeSkillView(workspace, {
            disabledSkills,
            workspaceId: workspace.id,
            workspaceOwner: ownerForWorkspace(workspace),
            ...(expectedRevision ? { expectedRevision } : {}),
            ...(forceRefresh ? { forceRefresh: true } : {}),
          }),
      );
      return jsonResponse({
        ready: true,
        revision: view.revision,
        generatedAt: view.generatedAt,
        activeCount: view.skills.length,
        items: view.skills,
      });
    },
  );

  addRoute(
    routes,
    "POST",
    "/workspace/:id/skills/resolve",
    "client",
    async (ctx) => {
      const workspace = await resolveWorkspace(
        ctx.config,
        requireRouteParam(ctx.params, "id", "workspace id"),
      );
      const body = await readJsonBody(ctx.request);
      const text = typeof body.text === "string" ? body.text : "";
      const threshold =
        typeof body.threshold === "number" ? body.threshold : undefined;
      const ambiguityDelta =
        typeof body.ambiguityDelta === "number"
          ? body.ambiguityDelta
          : undefined;
      const maxCandidates =
        typeof body.maxCandidates === "number" ? body.maxCandidates : undefined;
      const skills = (
        await withWorkspaceSkillLease(
          workspace.path,
          "runtime-skill-resolve",
          async () =>
            ensureActiveRuntimeSkillView(workspace, {
              disabledSkills: await listDisabledSkills({
                dataDir: serverDataDir,
                workspaceId: workspace.id,
                includeGlobal: true,
              }),
              workspaceId: workspace.id,
              workspaceOwner: ownerForWorkspace(workspace),
            }),
        )
      ).skills;
      const result = resolveSkillMatch({
        text,
        skills,
        ...(threshold !== undefined ? { threshold } : {}),
        ...(ambiguityDelta !== undefined ? { ambiguityDelta } : {}),
        ...(maxCandidates !== undefined ? { maxCandidates } : {}),
      });
      return jsonResponse(result);
    },
  );

  addRoute(
    routes,
    "POST",
    "/workspace/:id/skills/hub/:name",
    "client",
    async (ctx) => {
      ensureWritable(ctx.config);
      requireClientScope(ctx, "collaborator");
      const workspace = await resolveWorkspace(
        ctx.config,
        requireRouteParam(ctx.params, "id", "workspace id"),
      );
      const name = String(ctx.params.name ?? "").trim();
      if (!name) {
        throw new ApiError(400, "invalid_skill_name", "Skill name is required");
      }
      const body = await readJsonBody(ctx.request);
      const overwrite = body?.overwrite === true;
      const repoPayload =
        body?.repo && typeof body.repo === "object"
          ? (body.repo as Record<string, unknown>)
          : undefined;
      const repo = repoPayload
        ? {
            ...(typeof repoPayload.owner === "string"
              ? { owner: repoPayload.owner }
              : {}),
            ...(typeof repoPayload.repo === "string"
              ? { repo: repoPayload.repo }
              : {}),
            ...(typeof repoPayload.ref === "string"
              ? { ref: repoPayload.ref }
              : {}),
          }
        : undefined;

      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "skills.install_hub",
        summary: `Install hub skill ${name}`,
        paths: [join(workspace.path, ".opencode", "skills", name)],
      });

      const result = await withWorkspaceSkillLease(
        workspace.path,
        "hub-skill-install",
        async () => {
          const result = await installHubSkill(workspace.path, {
            name,
            overwrite,
            ...(repo ? { repo } : {}),
          });
          await refreshWorkspaceRuntimeSkillView(workspace);
          return result;
        },
      );
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
    },
  );

  addRoute(
    routes,
    "GET",
    "/workspace/:id/skills/:name",
    "client",
    async (ctx) => {
      const workspace = await resolveWorkspace(
        ctx.config,
        requireRouteParam(ctx.params, "id", "workspace id"),
      );
      const includeGlobal =
        ctx.url.searchParams.get("includeGlobal") === "true";
      const includeDisabled =
        ctx.url.searchParams.get("includeDisabled") === "true";
      const name = String(ctx.params.name ?? "").trim();
      if (!name) {
        throw new ApiError(400, "invalid_skill_name", "Skill name is required");
      }
      const items = await listWorkspaceRuntimeSkills(workspace, {
        includeGlobal,
        includeDisabled,
      });
      const instancePath = ctx.url.searchParams.get("path")?.trim() ?? "";
      if (instancePath) {
        // An explicit workspace path is a management/read operation. It may
        // address a suppressed conflict, but it must never opt into raw global
        // roots merely because the legacy query flag is present.
        const readableItems = await listSkills(workspace.path, {
          includeGlobal: false,
          includeDisabled,
          includeDuplicates: true,
          disabledSkills: await listDisabledSkills({
            dataDir: serverDataDir,
            workspaceId: workspace.id,
            includeGlobal: true,
          }),
          workspaceId: workspace.id,
          workspaceOwner: ownerForWorkspace(workspace),
        });
        const allowedItem = readableItems.find(
          (skill) =>
            skill.name === name &&
            resolve(skill.path) === resolve(instancePath),
        );
        if (!allowedItem) {
          throw new ApiError(
            404,
            "skill_not_found",
            `Skill not found: ${name}`,
          );
        }
        const result = await readSkillAtPath(workspace.path, {
          name,
          path: instancePath,
        });
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
    },
  );

  addRoute(
    routes,
    "GET",
    "/workspace/:id/skills/:name/files",
    "client",
    async (ctx) => {
      const workspace = await resolveWorkspace(
        ctx.config,
        requireRouteParam(ctx.params, "id", "workspace id"),
      );
      const includeGlobal =
        ctx.url.searchParams.get("includeGlobal") === "true";
      const includeDisabled =
        ctx.url.searchParams.get("includeDisabled") === "true";
      const name = String(ctx.params.name ?? "").trim();
      if (!name) {
        throw new ApiError(400, "invalid_skill_name", "Skill name is required");
      }
      const items = await listWorkspaceRuntimeSkills(workspace, {
        includeGlobal,
        includeDisabled,
      });
      const instancePath = ctx.url.searchParams.get("path")?.trim() ?? "";
      if (instancePath) {
        const readableItems = await listSkills(workspace.path, {
          includeGlobal: false,
          includeDisabled,
          includeDuplicates: true,
          disabledSkills: await listDisabledSkills({
            dataDir: serverDataDir,
            workspaceId: workspace.id,
            includeGlobal: true,
          }),
          workspaceId: workspace.id,
          workspaceOwner: ownerForWorkspace(workspace),
        });
        const allowedItem = readableItems.find(
          (skill) =>
            skill.name === name &&
            resolve(skill.path) === resolve(instancePath),
        );
        if (!allowedItem) {
          throw new ApiError(
            404,
            "skill_not_found",
            `Skill not found: ${name}`,
          );
        }
        const result = await readSkillFilesAtPath(workspace.path, {
          name,
          path: instancePath,
        });
        return jsonResponse({
          item: allowedItem,
          files: result.files,
        });
      }
      const item = items.find((skill) => skill.name === name);
      if (!item) {
        throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
      }
      const result = await readSkillFilesAtPath(workspace.path, {
        name,
        path: item.path,
      });
      return jsonResponse({ item, files: result.files });
    },
  );

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    const instancePath = typeof body.path === "string" ? body.path.trim() : "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [
        instancePath ||
          join(workspace.path, ".opencode", "skills", name, "SKILL.md"),
      ],
    });
    const skillPayload = {
      name,
      content,
      ...(description !== undefined ? { description } : {}),
    };
    const result = await withWorkspaceSkillLease(
      workspace.path,
      "workspace-skill-upsert",
      async () => {
        const result = instancePath
          ? await updateSkillAtPath(workspace.path, {
              ...skillPayload,
              path: instancePath,
            })
          : await upsertSkill(workspace.path, skillPayload);
        await refreshWorkspaceRuntimeSkillView(workspace);
        return result;
      },
    );
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
    return jsonResponse({
      name,
      path: result.path,
      description: description ?? "",
      scope: "project",
    });
  });

  addRoute(
    routes,
    "DELETE",
    "/workspace/:id/skills/:name",
    "client",
    async (ctx) => {
      ensureWritable(ctx.config);
      requireClientScope(ctx, "collaborator");
      const workspace = await resolveWorkspace(
        ctx.config,
        requireRouteParam(ctx.params, "id", "workspace id"),
      );
      const name = String(ctx.params.name ?? "").trim();
      if (!name) {
        throw new ApiError(400, "invalid_skill_name", "Skill name is required");
      }
      const instancePath = ctx.url.searchParams.get("path")?.trim() ?? "";
      const removalReason = trimmedSearchParam(ctx.url.searchParams, "reason");
      const removalJournal = {
        dataDir: serverDataDir,
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        ...(removalReason !== undefined ? { reason: removalReason } : {}),
      };
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "skills.delete",
        summary: `Delete skill ${name}`,
        paths: [
          instancePath || join(workspace.path, ".opencode", "skills", name),
        ],
      });
      const result = await withWorkspaceSkillLease(
        workspace.path,
        "workspace-skill-delete",
        async () => {
          const result = instancePath
            ? await deleteSkillAtPathRecoverable(
                workspace.path,
                { name, path: instancePath },
                removalJournal,
              )
            : await deleteSkillRecoverable(
                workspace.path,
                name,
                removalJournal,
              );
          await refreshWorkspaceRuntimeSkillView(workspace);
          return result;
        },
      );
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
      return jsonResponse({
        ok: true,
        name,
        path: result.path,
        removalId: result.removalId,
      });
    },
  );
}
