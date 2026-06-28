import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  readOptionalJsonBody,
  requireClientScope,
  requireSoulApproval,
  resolveWorkspace,
} from "../route-helpers.js";
import { addRoute, type RequestContext, type Route } from "../routing.js";
import {
  getSoulVersion,
  listSoulVersions,
  restoreSoulVersion as restoreDenSoulVersion,
  updateOrganizationSoul,
  updateUserSoul,
} from "../soul-den-client.js";
import {
  cacheSoulDocument,
  readCachedSoulDocument,
  soulCachePath,
} from "../soul-cache.js";
import {
  createSoulVersion,
  restoreSoulVersion as restoreLocalSoulVersion,
  type SoulDocument,
  type SoulScope,
} from "../soul-memory.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";

type SoulDenContext = {
  baseUrl: string;
  denToken?: string;
  orgId?: string;
  userId?: string;
};

type SoulModel = {
  document: SoulDocument | null;
  summary: unknown;
  pendingEdits?: unknown[];
  denSynced?: boolean;
  materialization?: unknown;
};

type SoulMaterializationAuditSet = {
  workspaces: Array<{ workspaceId: string; result?: { pending?: boolean; [key: string]: unknown } }>;
};

export type SoulRouteDependencies = {
  serverDataDir: string;
  readOrganizationSoulModel: (ctx: RequestContext) => Promise<SoulModel>;
  readUserSoulModel: (ctx: RequestContext) => Promise<SoulModel>;
  readWorkspaceSoulModel: (ctx: RequestContext, workspace: WorkspaceInfo) => Promise<SoulModel>;
  soulReadPayload: (input: any) => unknown;
  materializeSoulForWorkspace: (
    dataDir: string,
    ctx: RequestContext,
    workspace: WorkspaceInfo,
    overrides?: Partial<Record<SoulScope, SoulDocument | null>>,
    options?: { workspaceActive?: boolean },
  ) => Promise<{ pending?: boolean; [key: string]: unknown }>;
  materializeSoulForConfiguredWorkspaces: (
    dataDir: string,
    config: ServerConfig,
    ctx: RequestContext,
    overrides: Partial<Record<SoulScope, SoulDocument | null>>,
    options?: { activeWorkspaceIds?: Set<string> },
  ) => Promise<SoulMaterializationAuditSet & { ok: boolean; pending: boolean; manualSyncRequired: false }>;
  activeSoulWorkspaceIdsFromBody: (body: Record<string, unknown>) => Set<string>;
  soulWorkspaceActiveFromBody: (body: Record<string, unknown>, workspaceId: string) => boolean;
  soulMaterializationApprovalPaths: (workspace: WorkspaceInfo) => string[];
  configuredSoulMaterializationApprovalPaths: (
    config: ServerConfig,
    extraPaths: string[],
  ) => Promise<string[]>;
  globalSoulApprovalWorkspaceId: (config: ServerConfig) => string;
  validateSoulScopeParam: (value: string) => SoulScope;
  readCachedSoulVersions: (dataDir: string, scope: SoulScope, ownerId: string) => Promise<unknown[]>;
  soulDenContext: (ctx: RequestContext) => SoulDenContext;
  requireSoulDenToken: (ctx: SoulDenContext) => string;
  requireSoulOrgId: (ctx: SoulDenContext) => string;
  requireSoulUserId: (ctx: SoulDenContext) => string;
  soulCanEdit: (ctx: RequestContext, scope: SoulScope) => boolean;
  soulSummary: (input: any) => unknown;
  isSoulDenUnavailable: (error: unknown) => boolean;
  requireSoulText: (body: Record<string, unknown>, field: "content" | "changeSummary") => string;
  optionalSoulBaseVersionId: (body: Record<string, unknown>) => string | null;
  soulVersionResponse: (document: SoulDocument, versionId: string) => unknown;
  emptySoulDocument: (scope: SoulScope, ownerId: string) => SoulDocument;
  soulActorId: (ctx: RequestContext) => string;
  soulVersionId: (prefix?: string) => string;
  parseInteger: (value: string | undefined) => number | null;
  getSoulStatus: (workspaceRoot: string) => Promise<unknown>;
  listSoulHeartbeats: (
    workspaceRoot: string,
    limit: number,
  ) => Promise<{ items: unknown[]; total: number; path: string }>;
};

export function registerSoulRoutes(
  routes: Route[],
  dependencies: SoulRouteDependencies,
): void {
  const {
    serverDataDir,
    readOrganizationSoulModel,
    readUserSoulModel,
    readWorkspaceSoulModel,
    soulReadPayload,
    materializeSoulForWorkspace,
    materializeSoulForConfiguredWorkspaces,
    activeSoulWorkspaceIdsFromBody,
    soulWorkspaceActiveFromBody,
    soulMaterializationApprovalPaths,
    configuredSoulMaterializationApprovalPaths,
    globalSoulApprovalWorkspaceId,
    validateSoulScopeParam,
    readCachedSoulVersions,
    soulDenContext,
    requireSoulDenToken,
    requireSoulOrgId,
    requireSoulUserId,
    soulCanEdit,
    soulSummary,
    isSoulDenUnavailable,
    requireSoulText,
    optionalSoulBaseVersionId,
    soulVersionResponse,
    emptySoulDocument,
    soulActorId,
    soulVersionId,
    parseInteger,
    getSoulStatus,
    listSoulHeartbeats,
  } = dependencies;

  addRoute(routes, "GET", "/soul", "client", async (ctx) => {
    const organization = await readOrganizationSoulModel(ctx);
    const user = await readUserSoulModel(ctx);
    const workspaces = await Promise.all(ctx.config.workspaces.map(async (configuredWorkspace) => {
      const workspace = await resolveWorkspace(ctx.config, configuredWorkspace.id);
      return (await readWorkspaceSoulModel(ctx, workspace)).summary;
    }));
    return jsonResponse({
      organization: organization.summary,
      user: user.summary,
      workspaces,
    });
  });

  addRoute(routes, "GET", "/soul/organization", "client", async (ctx) => {
    return jsonResponse(soulReadPayload(await readOrganizationSoulModel(ctx)));
  });

  addRoute(routes, "GET", "/soul/user", "client", async (ctx) => {
    return jsonResponse(soulReadPayload(await readUserSoulModel(ctx)));
  });

  addRoute(routes, "GET", "/soul/workspaces", "client", async (ctx) => {
    const workspaces = await Promise.all(ctx.config.workspaces.map(async (configuredWorkspace) => {
      const workspace = await resolveWorkspace(ctx.config, configuredWorkspace.id);
      return (await readWorkspaceSoulModel(ctx, workspace)).summary;
    }));
    return jsonResponse({ workspaces });
  });

  addRoute(routes, "GET", "/workspace/:id/soul", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    return jsonResponse(soulReadPayload(await readWorkspaceSoulModel(ctx, workspace)));
  });

  addRoute(routes, "POST", "/workspace/:id/soul/materialization/sync", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    await requireSoulApproval(ctx, {
      workspaceId: workspace.id,
      action: "soul.materialization.sync",
      summary: `Sync Soul runtime files for ${workspace.name}`,
      paths: soulMaterializationApprovalPaths(workspace),
    });
    const result = await materializeSoulForWorkspace(serverDataDir, ctx, workspace, {}, {
      workspaceActive: soulWorkspaceActiveFromBody(body, workspace.id),
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "soul.materialization.sync",
      target: workspace.path,
      summary: result.pending
        ? "Soul runtime sync is pending because the workspace has an active run"
        : "Synced Soul runtime files",
      timestamp: Date.now(),
    });
    return jsonResponse(result, result.pending ? 202 : 200);
  });

  addRoute(routes, "GET", "/soul/:scope/versions", "client", async (ctx) => {
    const scope = validateSoulScopeParam(ctx.params.scope);
    if (scope === "workspace") {
      const workspaceId = ctx.url.searchParams.get("workspaceId")?.trim();
      if (!workspaceId) {
        throw new ApiError(400, "workspace_id_required", "workspaceId query parameter is required");
      }
      const workspace = await resolveWorkspace(ctx.config, workspaceId);
      const versions = await readCachedSoulVersions(serverDataDir, "workspace", workspace.id);
      return jsonResponse({ versions, nextCursor: null });
    }

    const den = soulDenContext(ctx);
    const ownerId = scope === "organization" ? den.orgId : den.userId;
    if (den.baseUrl && den.denToken && ownerId) {
      try {
        const response = await listSoulVersions({
          ...den,
          token: den.denToken,
          scope,
          cursor: ctx.url.searchParams.get("cursor")?.trim() || undefined,
          limit: parseInteger(ctx.url.searchParams.get("limit") ?? undefined) ?? undefined,
        });
        return jsonResponse(response);
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const versions = ownerId ? await readCachedSoulVersions(serverDataDir, scope, ownerId) : [];
    return jsonResponse({ versions, nextCursor: null, denSynced: false });
  });

  addRoute(routes, "GET", "/soul/:scope/versions/:versionId", "client", async (ctx) => {
    const scope = validateSoulScopeParam(ctx.params.scope);
    if (scope === "workspace") {
      const workspaceId = ctx.url.searchParams.get("workspaceId")?.trim();
      if (!workspaceId) {
        throw new ApiError(400, "workspace_id_required", "workspaceId query parameter is required");
      }
      const workspace = await resolveWorkspace(ctx.config, workspaceId);
      const document = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id });
      if (!document) throw new ApiError(404, "soul_not_found", "Soul document not found");
      return jsonResponse({ version: soulVersionResponse(document, ctx.params.versionId) });
    }

    const den = soulDenContext(ctx);
    const ownerId = scope === "organization" ? den.orgId : den.userId;
    if (den.baseUrl && den.denToken && ownerId) {
      try {
        const version = await getSoulVersion({ ...den, token: den.denToken, scope, versionId: ctx.params.versionId });
        return jsonResponse({ version });
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    if (!ownerId) throw new ApiError(404, "soul_not_found", "Soul document not found");
    const document = await readCachedSoulDocument({ dataDir: serverDataDir, scope, ownerId });
    if (!document) throw new ApiError(404, "soul_not_found", "Soul document not found");
    return jsonResponse({ version: soulVersionResponse(document, ctx.params.versionId), denSynced: false });
  });

  addRoute(routes, "PATCH", "/soul/organization", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const den = soulDenContext(ctx);
    const denToken = requireSoulDenToken(den);
    const orgId = requireSoulOrgId(den);
    if (!den.baseUrl) {
      throw new ApiError(503, "soul_den_misconfigured", "Soul Den base URL is missing");
    }
    const body = await readJsonBody(ctx.request);
    const content = requireSoulText(body, "content");
    const changeSummary = requireSoulText(body, "changeSummary");
    const baseVersionId = optionalSoulBaseVersionId(body);
    await requireSoulApproval(ctx, {
      workspaceId: globalSoulApprovalWorkspaceId(ctx.config),
      action: "soul.organization.update",
      summary: "Update Organization Soul",
      paths: await configuredSoulMaterializationApprovalPaths(ctx.config, [
        soulCachePath({ dataDir: serverDataDir, scope: "organization", ownerId: orgId }),
      ]),
    });
    const document = await updateOrganizationSoul({
      ...den,
      token: denToken,
      content,
      changeSummary,
      baseVersionId,
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document });
    const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, ctx.config, ctx, {
      organization: document,
    }, {
      activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
    });
    await recordConfiguredSoulAudit(ctx, materialization, {
      action: "soul.organization.update",
      target: `organization:${document.ownerId}`,
      summary: "Update Organization Soul",
    });
    return jsonResponse(soulReadPayload({
      document,
      summary: soulSummary({
        scope: "organization",
        ownerId: document.ownerId,
        document,
        canEdit: soulCanEdit(ctx, "organization"),
      }),
      denSynced: true,
      materialization,
    }));
  });

  addRoute(routes, "PATCH", "/soul/user", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const den = soulDenContext(ctx);
    const userId = requireSoulUserId(den);
    const body = await readJsonBody(ctx.request);
    const content = requireSoulText(body, "content");
    const changeSummary = requireSoulText(body, "changeSummary");
    const baseVersionId = optionalSoulBaseVersionId(body);
    await requireSoulApproval(ctx, {
      workspaceId: globalSoulApprovalWorkspaceId(ctx.config),
      action: "soul.user.update",
      summary: "Update User Soul",
      paths: await configuredSoulMaterializationApprovalPaths(ctx.config, [
        soulCachePath({ dataDir: serverDataDir, scope: "user", ownerId: userId }),
      ]),
    });

    if (den.baseUrl && den.denToken) {
      try {
        const document = await updateUserSoul({
          ...den,
          token: den.denToken,
          content,
          changeSummary,
          baseVersionId,
        });
        await cacheSoulDocument({ dataDir: serverDataDir, document });
        const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, ctx.config, ctx, {
          user: document,
        }, {
          activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
        });
        await recordConfiguredSoulAudit(ctx, materialization, {
          action: "soul.user.update",
          target: `user:${document.ownerId}`,
          summary: "Update User Soul",
        });
        return jsonResponse(soulReadPayload({
          document,
          summary: soulSummary({
            scope: "user",
            ownerId: document.ownerId,
            document,
            canEdit: soulCanEdit(ctx, "user"),
          }),
          denSynced: true,
          materialization,
        }));
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const cached = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "user", ownerId: userId });
    const document = createSoulVersion(cached ?? emptySoulDocument("user", userId), {
      id: soulVersionId("user_"),
      content,
      changeSummary,
      createdAt: new Date().toISOString(),
      createdBy: soulActorId(ctx),
      source: "api",
      baseVersionId,
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document });
    const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, ctx.config, ctx, {
      user: document,
    }, {
      activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
    });
    await recordConfiguredSoulAudit(ctx, materialization, {
      action: "soul.user.update",
      target: `user:${document.ownerId}`,
      summary: "Update User Soul",
    });
    return jsonResponse(soulReadPayload({
      document,
      summary: soulSummary({
        scope: "user",
        ownerId: userId,
        document,
        canEdit: soulCanEdit(ctx, "user"),
      }),
      denSynced: false,
      materialization,
    }));
  });

  addRoute(routes, "POST", "/soul/organization/versions/:versionId/restore", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const den = soulDenContext(ctx);
    const denToken = requireSoulDenToken(den);
    const orgId = requireSoulOrgId(den);
    if (!den.baseUrl) {
      throw new ApiError(503, "soul_den_misconfigured", "Soul Den base URL is missing");
    }
    const body = await readOptionalJsonBody(ctx.request);
    const changeSummary = typeof body.changeSummary === "string" && body.changeSummary.trim()
      ? body.changeSummary
      : "Restore Organization Soul version";
    await requireSoulApproval(ctx, {
      workspaceId: globalSoulApprovalWorkspaceId(ctx.config),
      action: "soul.organization.restore",
      summary: `Restore Organization Soul version ${ctx.params.versionId}`,
      paths: await configuredSoulMaterializationApprovalPaths(ctx.config, [
        soulCachePath({ dataDir: serverDataDir, scope: "organization", ownerId: orgId }),
      ]),
    });
    const document = await restoreDenSoulVersion({
      ...den,
      token: denToken,
      scope: "organization",
      versionId: ctx.params.versionId,
      changeSummary,
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document });
    const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, ctx.config, ctx, {
      organization: document,
    }, {
      activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
    });
    await recordConfiguredSoulAudit(ctx, materialization, {
      action: "soul.organization.restore",
      target: `organization:${document.ownerId}`,
      summary: `Restore Organization Soul version ${ctx.params.versionId}`,
    });
    return jsonResponse(soulReadPayload({
      document,
      summary: soulSummary({
        scope: "organization",
        ownerId: document.ownerId,
        document,
        canEdit: soulCanEdit(ctx, "organization"),
      }),
      denSynced: true,
      materialization,
    }));
  });

  addRoute(routes, "POST", "/soul/user/versions/:versionId/restore", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const den = soulDenContext(ctx);
    const userId = requireSoulUserId(den);
    const body = await readOptionalJsonBody(ctx.request);
    const changeSummary = typeof body.changeSummary === "string" && body.changeSummary.trim()
      ? body.changeSummary
      : "Restore User Soul version";
    await requireSoulApproval(ctx, {
      workspaceId: globalSoulApprovalWorkspaceId(ctx.config),
      action: "soul.user.restore",
      summary: `Restore User Soul version ${ctx.params.versionId}`,
      paths: await configuredSoulMaterializationApprovalPaths(ctx.config, [
        soulCachePath({ dataDir: serverDataDir, scope: "user", ownerId: userId }),
      ]),
    });
    if (den.baseUrl && den.denToken) {
      try {
        const document = await restoreDenSoulVersion({
          ...den,
          token: den.denToken,
          scope: "user",
          versionId: ctx.params.versionId,
          changeSummary,
        });
        await cacheSoulDocument({ dataDir: serverDataDir, document });
        const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, ctx.config, ctx, {
          user: document,
        }, {
          activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
        });
        await recordConfiguredSoulAudit(ctx, materialization, {
          action: "soul.user.restore",
          target: `user:${document.ownerId}`,
          summary: `Restore User Soul version ${ctx.params.versionId}`,
        });
        return jsonResponse(soulReadPayload({
          document,
          summary: soulSummary({
            scope: "user",
            ownerId: document.ownerId,
            document,
            canEdit: soulCanEdit(ctx, "user"),
          }),
          denSynced: true,
          materialization,
        }));
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const cached = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "user", ownerId: userId });
    if (!cached) throw new ApiError(404, "soul_not_found", "Soul document not found");
    const restored = restoreLocalSoulVersion(cached, {
      id: soulVersionId("user_restore_"),
      restoreSourceVersionId: ctx.params.versionId,
      changeSummary,
      createdAt: new Date().toISOString(),
      createdBy: soulActorId(ctx),
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document: restored });
    const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, ctx.config, ctx, {
      user: restored,
    }, {
      activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
    });
    await recordConfiguredSoulAudit(ctx, materialization, {
      action: "soul.user.restore",
      target: `user:${restored.ownerId}`,
      summary: `Restore User Soul version ${ctx.params.versionId}`,
    });
    return jsonResponse(soulReadPayload({
      document: restored,
      summary: soulSummary({
        scope: "user",
        ownerId: restored.ownerId,
        document: restored,
        canEdit: soulCanEdit(ctx, "user"),
      }),
      denSynced: false,
      materialization,
    }));
  });

  addRoute(routes, "PATCH", "/workspace/:id/soul", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const content = requireSoulText(body, "content");
    const changeSummary = requireSoulText(body, "changeSummary");
    const baseVersionId = optionalSoulBaseVersionId(body);
    await requireSoulApproval(ctx, {
      workspaceId: workspace.id,
      action: "soul.workspace.update",
      summary: `Update Workspace Soul for ${workspace.name}`,
      paths: [
        soulCachePath({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id }),
        ...soulMaterializationApprovalPaths(workspace),
      ],
    });
    const existing = await readCachedSoulDocument({
      dataDir: serverDataDir,
      scope: "workspace",
      ownerId: workspace.id,
    });
    const document = createSoulVersion(
      existing ?? { ...emptySoulDocument("workspace", workspace.id), heartbeatEnabled: true },
      {
        id: soulVersionId("workspace_"),
        content,
        changeSummary,
        createdAt: new Date().toISOString(),
        createdBy: soulActorId(ctx),
        source: "api",
        baseVersionId,
      },
    );
    const nextDocument = { ...document, heartbeatEnabled: existing?.heartbeatEnabled ?? true };
    await cacheSoulDocument({ dataDir: serverDataDir, document: nextDocument });
    const materialization = await materializeSoulForWorkspace(serverDataDir, ctx, workspace, {
      workspace: nextDocument,
    }, {
      workspaceActive: soulWorkspaceActiveFromBody(body, workspace.id),
    });
    await recordWorkspaceSoulAudit(ctx, workspace, {
      action: "soul.workspace.update",
      target: `workspace:${workspace.id}`,
      summary: `Update Workspace Soul for ${workspace.name}`,
    });
    return jsonResponse(soulReadPayload({
      document: nextDocument,
      summary: soulSummary({
        scope: "workspace",
        ownerId: workspace.id,
        document: nextDocument,
        canEdit: soulCanEdit(ctx, "workspace"),
        workspace,
      }),
      materialization,
    }));
  });

  addRoute(routes, "POST", "/workspace/:id/soul/versions/:versionId/restore", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const document = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id });
    if (!document) throw new ApiError(404, "soul_not_found", "Soul document not found");
    const body = await readOptionalJsonBody(ctx.request);
    const changeSummary = typeof body.changeSummary === "string" && body.changeSummary.trim()
      ? body.changeSummary
      : "Restore Workspace Soul version";
    await requireSoulApproval(ctx, {
      workspaceId: workspace.id,
      action: "soul.workspace.restore",
      summary: `Restore Workspace Soul version ${ctx.params.versionId}`,
      paths: [
        soulCachePath({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id }),
        ...soulMaterializationApprovalPaths(workspace),
      ],
    });
    const restored = restoreLocalSoulVersion(document, {
      id: soulVersionId("workspace_restore_"),
      restoreSourceVersionId: ctx.params.versionId,
      changeSummary,
      createdAt: new Date().toISOString(),
      createdBy: soulActorId(ctx),
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document: restored });
    const materialization = await materializeSoulForWorkspace(serverDataDir, ctx, workspace, {
      workspace: restored,
    }, {
      workspaceActive: soulWorkspaceActiveFromBody(body, workspace.id),
    });
    await recordWorkspaceSoulAudit(ctx, workspace, {
      action: "soul.workspace.restore",
      target: `workspace:${workspace.id}`,
      summary: `Restore Workspace Soul version ${ctx.params.versionId}`,
    });
    return jsonResponse(soulReadPayload({
      document: restored,
      summary: soulSummary({
        scope: "workspace",
        ownerId: workspace.id,
        document: restored,
        canEdit: soulCanEdit(ctx, "workspace"),
        workspace,
      }),
      materialization,
    }));
  });

  addRoute(routes, "POST", "/workspace/:id/soul/heartbeat-toggle", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    const existing = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id });
    const enabled = typeof body.enabled === "boolean" ? body.enabled : !(existing?.heartbeatEnabled ?? false);
    await requireSoulApproval(ctx, {
      workspaceId: workspace.id,
      action: "soul.workspace.heartbeat-toggle",
      summary: `${enabled ? "Enable" : "Disable"} Workspace Soul heartbeat`,
      paths: [
        soulCachePath({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id }),
      ],
    });
    const document = { ...(existing ?? emptySoulDocument("workspace", workspace.id)), heartbeatEnabled: enabled };
    await cacheSoulDocument({ dataDir: serverDataDir, document });
    await recordWorkspaceSoulAudit(ctx, workspace, {
      action: "soul.workspace.heartbeat-toggle",
      target: `workspace:${workspace.id}`,
      summary: `${enabled ? "Enable" : "Disable"} Workspace Soul heartbeat`,
    });
    return jsonResponse(soulReadPayload({
      document,
      summary: soulSummary({
        scope: "workspace",
        ownerId: workspace.id,
        document,
        canEdit: soulCanEdit(ctx, "workspace"),
        workspace,
      }),
    }));
  });

  addRoute(routes, "GET", "/workspace/:id/soul/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const status = await getSoulStatus(workspace.path);
    return jsonResponse(status);
  });

  addRoute(routes, "GET", "/workspace/:id/soul/heartbeats", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 20;
    const { items, total, path } = await listSoulHeartbeats(workspace.path, limit);
    return jsonResponse({ items, total, path });
  });
}

async function recordConfiguredSoulAudit(
  ctx: RequestContext,
  materialization: SoulMaterializationAuditSet,
  input: { action: string; target: string; summary: string },
): Promise<void> {
  const timestamp = Date.now();
  for (const item of materialization.workspaces) {
    const workspace = await resolveWorkspace(ctx.config, item.workspaceId);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: input.action,
      target: input.target,
      summary: item.result?.pending
        ? `${input.summary} (runtime sync pending)`
        : input.summary,
      timestamp,
    });
  }
}

async function recordWorkspaceSoulAudit(
  ctx: RequestContext,
  workspace: WorkspaceInfo,
  input: { action: string; target: string; summary: string },
): Promise<void> {
  await recordAudit(workspace.path, {
    id: shortId(),
    workspaceId: workspace.id,
    actor: ctx.actor ?? { type: "remote" },
    action: input.action,
    target: input.target,
    summary: input.summary,
    timestamp: Date.now(),
  });
}
