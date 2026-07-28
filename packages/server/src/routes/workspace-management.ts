import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { recordAudit, readAuditEntries, readLastAudit } from "../audit.js";
import {
  evictActiveRuntimeSkillView,
  invalidateActiveRuntimeSkillView,
  type RuntimeSkillViewInvalidationReason,
} from "../active-runtime-skill-view.js";
import { ApiError } from "../errors.js";
import {
  provisionWorkspaceInternalSystem,
  resolveVesloAppDataDir,
} from "../internal-system.js";
import { updateJsoncTopLevel } from "../jsonc.js";
import {
  emitReloadEvent,
  buildOrchestratorWorkspaceOpencodeBaseUrl,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  readOptionalJsonBody,
  requireApproval,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import { addRoute, type RequestContext, type Route } from "../routing.js";
import type { ReloadTrigger, ServerConfig, WorkspaceInfo } from "../types.js";
import { materializeUserGlobalSkillsForWorkspace } from "../user-skill-store.js";
import { shortId } from "../utils.js";
import { withWorkspaceSkillLease } from "../workspace-skill-lease.js";
import { opencodeConfigPath, vesloConfigPath } from "../workspace-files.js";
import {
  persistServerWorkspaceState,
  workspaceIdForPath,
} from "../workspaces.js";

export type WorkspaceManagementRouteDependencies = {
  serverDataDir: string;
  serializeWorkspaceForResponse: (workspace: WorkspaceInfo) => unknown;
  optionalBodyHttpUrl: (
    body: Record<string, unknown>,
    field: string,
  ) => string | undefined;
  optionalBodyString: (
    body: Record<string, unknown>,
    field: string,
  ) => string | undefined;
  persistWorkspaceDeletion: (
    configPath: string,
    workspaceId: string,
    workspacePath: string,
  ) => Promise<boolean>;
  redactSensitiveConfig: (
    config: Record<string, unknown>,
  ) => Record<string, unknown>;
  readOpencodeConfig: (
    workspaceRoot: string,
  ) => Promise<Record<string, unknown>>;
  readVesloConfig: (workspaceRoot: string) => Promise<Record<string, unknown>>;
  materializeSoulForWorkspace: (
    dataDir: string,
    ctx: RequestContext,
    workspace: WorkspaceInfo,
  ) => Promise<unknown>;
  writeVesloConfig: (
    workspaceRoot: string,
    updates: Record<string, unknown>,
    merge: boolean,
  ) => Promise<void>;
  buildConfigTrigger: (path: string) => ReloadTrigger;
  reloadOpencodeEngine: (
    workspace: WorkspaceInfo,
    options?: {
      fallbackBaseUrl?: string;
      ifRunning?: boolean;
    },
  ) => Promise<{ kind: "reloaded" | "not-running" | "starting" }>;
  reloadWorkspaceEngineIfIdle: (input: {
    workspaceId: string;
    reload: () => Promise<void>;
  }) => Promise<
    | { kind: "reloaded" }
    | { kind: "blocked"; reason: "active-runs" | "reconciliation-pending" }
  >;
  exportWorkspace: (workspace: WorkspaceInfo) => Promise<unknown>;
  importWorkspace: (
    workspace: WorkspaceInfo,
    body: Record<string, unknown>,
  ) => Promise<void>;
};

const trimmedSearchParam = (
  params: URLSearchParams,
  key: string,
): string | undefined => {
  const value = params.get(key)?.trim();
  return value || undefined;
};

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

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

export function registerWorkspaceManagementRoutes(
  routes: Route[],
  dependencies: WorkspaceManagementRouteDependencies,
): void {
  const {
    serverDataDir,
    serializeWorkspaceForResponse,
    optionalBodyHttpUrl,
    optionalBodyString,
    persistWorkspaceDeletion,
    redactSensitiveConfig,
    readOpencodeConfig,
    readVesloConfig,
    materializeSoulForWorkspace,
    writeVesloConfig,
    buildConfigTrigger,
    reloadOpencodeEngine,
    reloadWorkspaceEngineIfIdle,
    exportWorkspace,
    importWorkspace,
  } = dependencies;
  const refreshWorkspaceRuntimeSkillView = async (
    workspace: WorkspaceInfo,
    reason: RuntimeSkillViewInvalidationReason,
  ): Promise<void> => {
    invalidateActiveRuntimeSkillView(workspace, reason);
  };

  addRoute(routes, "GET", "/workspaces", "client", async (ctx) => {
    const active = ctx.config.workspaces[0] ?? null;
    const items = ctx.config.workspaces.map(serializeWorkspaceForResponse);
    return jsonResponse({ items, activeId: active?.id ?? null });
  });

  addRoute(routes, "POST", "/workspaces/local", "host", async (ctx) => {
    ensureWritable(ctx.config);
    const body = await readJsonBody(ctx.request);
    const folderPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!folderPath) {
      throw new ApiError(400, "invalid_payload", "path is required");
    }
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : basename(folderPath);
    const baseUrl = optionalBodyHttpUrl(body, "baseUrl");
    const directory = optionalBodyString(body, "directory");
    const opencodeUsername = optionalBodyString(body, "opencodeUsername");
    const opencodePassword = optionalBodyString(body, "opencodePassword");

    const workspacePath = resolve(folderPath);
    await mkdir(workspacePath, { recursive: true });

    const id = workspaceIdForPath(workspacePath);
    const existing = ctx.config.workspaces.find((entry) => entry.id === id);
    if (existing) {
      const hasOpencodeMetadata = Boolean(
        baseUrl || directory || opencodeUsername || opencodePassword,
      );
      const nextWorkspace: WorkspaceInfo = {
        ...existing,
        ...(name && existing.name !== name ? { name } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(directory ? { directory } : {}),
        ...(opencodeUsername ? { opencodeUsername } : {}),
        ...(opencodePassword ? { opencodePassword } : {}),
      };
      const changed =
        nextWorkspace.name !== existing.name ||
        nextWorkspace.baseUrl !== existing.baseUrl ||
        nextWorkspace.directory !== existing.directory ||
        nextWorkspace.opencodeUsername !== existing.opencodeUsername ||
        nextWorkspace.opencodePassword !== existing.opencodePassword;
      if (
        changed &&
        (baseUrl || directory || opencodeUsername || opencodePassword)
      ) {
        invalidateActiveRuntimeSkillView(existing, "workspace-config-patch");
        ctx.config.workspaces = ctx.config.workspaces.map((entry) =>
          entry.id === id ? nextWorkspace : entry,
        );
        const persisted = await persistServerWorkspaceState(ctx.config);
        const updatedWorkspace =
          ctx.config.workspaces.find((entry) => entry.id === id) ??
          nextWorkspace;
        return jsonResponse({
          activeId: ctx.config.workspaces[0]?.id ?? null,
          workspace: serializeWorkspaceForResponse(updatedWorkspace),
          items: ctx.config.workspaces.map(serializeWorkspaceForResponse),
          persisted,
        });
      }
      if (hasOpencodeMetadata) {
        return jsonResponse({
          activeId: ctx.config.workspaces[0]?.id ?? null,
          workspace: serializeWorkspaceForResponse(existing),
          items: ctx.config.workspaces.map(serializeWorkspaceForResponse),
          persisted: false,
        });
      }
      throw new ApiError(409, "workspace_exists", "Workspace already exists", {
        id,
        path: workspacePath,
      });
    }

    const workspace: WorkspaceInfo = {
      id,
      name,
      path: workspacePath,
      workspaceType: "local",
      ...(baseUrl ? { baseUrl } : {}),
      ...(directory ? { directory } : {}),
      ...(opencodeUsername ? { opencodeUsername } : {}),
      ...(opencodePassword ? { opencodePassword } : {}),
    };

    ctx.config.workspaces = [workspace, ...ctx.config.workspaces];
    if (
      !ctx.config.authorizedRoots.some(
        (root) => resolve(root) === workspacePath,
      )
    ) {
      ctx.config.authorizedRoots = [
        ...ctx.config.authorizedRoots,
        workspacePath,
      ];
    }
    const persisted = await persistServerWorkspaceState(ctx.config);
    await ctx.automationRunner.upsertWorkspace({
      id: workspace.id,
      path: workspacePath,
    });

    return jsonResponse(
      {
        activeId: workspace.id,
        workspace: serializeWorkspaceForResponse(workspace),
        items: ctx.config.workspaces.map(serializeWorkspaceForResponse),
        persisted,
      },
      201,
    );
  });

  addRoute(routes, "PATCH", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(ctx.config);
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const body = await readJsonBody(ctx.request);
    const nextName =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : undefined;

    if (!nextName) {
      throw new ApiError(
        400,
        "invalid_payload",
        "name must be a non-empty string",
      );
    }

    ctx.config.workspaces = ctx.config.workspaces.map((entry) =>
      entry.id === workspace.id ? { ...entry, name: nextName } : entry,
    );
    const persisted = await persistServerWorkspaceState(ctx.config);

    return jsonResponse({
      items: ctx.config.workspaces.map(serializeWorkspaceForResponse),
      persisted,
    });
  });

  addRoute(routes, "POST", "/workspaces/:id/activate", "host", async (ctx) => {
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    ctx.config.workspaces = [
      workspace,
      ...ctx.config.workspaces.filter((entry) => entry.id !== workspace.id),
    ];

    let provision: {
      version: string;
      status: "updated" | "unchanged";
      written: number;
      unchanged: number;
    } | null = null;
    let userGlobalSkills: Awaited<
      ReturnType<typeof materializeUserGlobalSkillsForWorkspace>
    > | null = null;
    try {
      const materialized = await withWorkspaceSkillLease(
        workspace.path,
        "workspace-activation-provision",
        async () => {
          const provision = await provisionWorkspaceInternalSystem(
            workspace.path,
            resolveVesloAppDataDir(),
          );
          const userGlobalSkills =
            await materializeUserGlobalSkillsForWorkspace({
              workspaceRoot: workspace.path,
              workspaceId: workspace.id,
              dataDir: serverDataDir,
            });
          await refreshWorkspaceRuntimeSkillView(workspace, "workspace-activate");
          return { provision, userGlobalSkills };
        },
      );
      provision = materialized.provision;
      userGlobalSkills = materialized.userGlobalSkills;
      if (provision.written > 0) {
        emitReloadEvent(ctx.reloadEvents, workspace, "agents", {
          type: "agent",
          action: "updated",
          path: ".opencode/agents/veslo.md",
        });
      }
      if (userGlobalSkills.reloadRequired) {
        emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
          type: "skill",
          name: "veslo-user",
          action: "updated",
          path: userGlobalSkills.rootDir,
        });
      }
    } catch (error) {
      console.warn("[veslo-server] workspace activation provisioning failed", {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.activate",
      target: "workspace",
      summary: "Switched active workspace",
      timestamp: Date.now(),
    });
    return jsonResponse({
      activeId: workspace.id,
      workspace: serializeWorkspaceForResponse(workspace),
      provision,
      userGlobalSkills,
    });
  });

  addRoute(routes, "DELETE", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(ctx.config);

    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );

    const configPath = ctx.config.configPath?.trim() ?? "";
    const persisted = configPath
      ? await persistWorkspaceDeletion(configPath, workspace.id, workspace.path)
      : false;

    const before = ctx.config.workspaces.length;
    ctx.config.workspaces = ctx.config.workspaces.filter(
      (entry) => entry.id !== workspace.id,
    );
    const deleted = before !== ctx.config.workspaces.length;

    if (deleted) {
      evictActiveRuntimeSkillView(workspace.id, workspace.path);
      ctx.config.authorizedRoots = ctx.config.authorizedRoots.filter(
        (root) => resolve(root) !== resolve(workspace.path),
      );
      ctx.automationRunner.removeWorkspace(workspace.id);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.delete",
      target: "workspace",
      summary: "Deleted workspace from Veslo server",
      timestamp: Date.now(),
    });

    const active = ctx.config.workspaces[0] ?? null;
    return jsonResponse({
      ok: true,
      deleted,
      persisted,
      activeId: active?.id ?? null,
      items: ctx.config.workspaces.map(serializeWorkspaceForResponse),
    });
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const opencode = redactSensitiveConfig(
      await readOpencodeConfig(workspace.path),
    );
    const veslo = redactSensitiveConfig(await readVesloConfig(workspace.path));
    const lastAudit = await readLastAudit(workspace.path, workspace.id);
    return jsonResponse({
      opencode,
      veslo,
      updatedAt: lastAudit?.timestamp ?? null,
    });
  });

  addRoute(
    routes,
    "POST",
    "/workspace/:id/system/provision",
    "client",
    async (ctx) => {
      ensureWritable(ctx.config);
      requireClientScope(ctx, "collaborator");
      const workspace = await resolveWorkspace(
        ctx.config,
        requireRouteParam(ctx.params, "id", "workspace id"),
      );

      const { soulMaterialization, result, userGlobalSkills } =
        await withWorkspaceSkillLease(
          workspace.path,
          "workspace-system-provision",
          async () => {
            const soulMaterialization = await materializeSoulForWorkspace(
              serverDataDir,
              ctx,
              workspace,
            );
            const result = await provisionWorkspaceInternalSystem(
              workspace.path,
              resolveVesloAppDataDir(),
            );
            const userGlobalSkills =
              await materializeUserGlobalSkillsForWorkspace({
                workspaceRoot: workspace.path,
                workspaceId: workspace.id,
                dataDir: serverDataDir,
              });
            await refreshWorkspaceRuntimeSkillView(workspace, "workspace-provision");
            return { soulMaterialization, result, userGlobalSkills };
          },
        );

      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: "system.provision",
        target: ".opencode/agents/veslo.md",
        summary: `Updated Veslo workspace instructions (${result.status})`,
        timestamp: Date.now(),
      });

      if (result.written > 0) {
        emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
          type: "skill",
          action: "updated",
          path: ".opencode/veslo/internal",
        });
      }
      if (userGlobalSkills.reloadRequired) {
        emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
          type: "skill",
          name: "veslo-user",
          action: "updated",
          path: userGlobalSkills.rootDir,
        });
      }
      if (result.written > 0) {
        emitReloadEvent(ctx.reloadEvents, workspace, "agents", {
          type: "agent",
          action: "updated",
          path: ".opencode/agents/veslo.md",
        });
      }

      return jsonResponse({
        ok: true,
        workspaceId: workspace.id,
        version: result.version,
        status: result.status,
        written: result.written,
        unchanged: result.unchanged,
        userGlobalSkills,
        soulMaterialization,
      });
    },
  );

  addRoute(routes, "GET", "/workspace/:id/audit", "client", async (ctx) => {
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const limitParam = ctx.url.searchParams.get("limit");
    const parsed = limitParam ? Number(limitParam) : NaN;
    const limit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await readAuditEntries(workspace.path, workspace.id, limit);
    return jsonResponse({ items });
  });

  addRoute(routes, "PATCH", "/workspace/:id/config", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const body = await readJsonBody(ctx.request);
    const opencode = body.opencode as Record<string, unknown> | undefined;
    const veslo = body.veslo as Record<string, unknown> | undefined;

    if (!opencode && !veslo) {
      throw new ApiError(
        400,
        "invalid_payload",
        "opencode or veslo updates required",
      );
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.patch",
      summary: "Patch workspace config",
      paths: [
        opencode ? opencodeConfigPath(workspace.path) : null,
        veslo ? vesloConfigPath(workspace.path) : null,
      ].filter(Boolean) as string[],
    });

    await withWorkspaceSkillLease(
      workspace.path,
      "workspace-config-patch",
      async () => {
        if (opencode) {
          await updateJsoncTopLevel(
            opencodeConfigPath(workspace.path),
            opencode,
          );
        }
        if (veslo) {
          await writeVesloConfig(workspace.path, veslo, true);
        }
        if (opencode) await refreshWorkspaceRuntimeSkillView(workspace, "workspace-config-patch");
      },
    );

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.patch",
      target: "opencode.json",
      summary: "Patched workspace config",
      timestamp: Date.now(),
    });

    if (opencode) {
      emitReloadEvent(
        ctx.reloadEvents,
        workspace,
        "config",
        buildConfigTrigger(opencodeConfigPath(workspace.path)),
      );
    }

    return jsonResponse({ updatedAt: Date.now() });
  });

  addRoute(routes, "GET", "/workspace/:id/events", "client", async (ctx) => {
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const since = parseInteger(
      trimmedSearchParam(ctx.url.searchParams, "since"),
    );
    return jsonResponse({
      items: ctx.reloadEvents.list(workspace.id, since ?? undefined),
      cursor: ctx.reloadEvents.cursor(),
      workspaceId: workspace.id,
    });
  });

  addRoute(
    routes,
    "POST",
    "/workspace/:id/engine/reload",
    "client",
    async (ctx) => {
      const workspace = await resolveWorkspace(
        ctx.config,
        requireRouteParam(ctx.params, "id", "workspace id"),
      );
      requireClientScope(ctx, "collaborator");
      const body = await readOptionalJsonBody(ctx.request);
      const ifIdle = body?.ifIdle === true;
      // An idle reload means "refresh an existing engine". A stopped engine will
      // read its persisted config on first launch, so starting it here is pure
      // background fan-out.
      const ifRunning = body?.ifRunning === true || ifIdle;
      let reloadResult: { kind: "reloaded" | "not-running" | "starting" } = {
        kind: "reloaded",
      };
      if (ifIdle) {
        const result = await reloadWorkspaceEngineIfIdle({
          workspaceId: workspace.id,
          reload: async () => {
            reloadResult = await reloadOpencodeEngine(workspace, {
              fallbackBaseUrl: buildOrchestratorWorkspaceOpencodeBaseUrl(
                ctx.config,
                workspace,
              ),
              ifRunning,
            });
          },
        });
        if (result.kind === "blocked") {
          throw new ApiError(
            409,
            "reload_blocked_active_runs",
            "Workspace engine reload is blocked by an active or reconciling run",
            {
              workspaceId: workspace.id,
              reason: result.reason,
            },
          );
        }
      } else {
        reloadResult = await reloadOpencodeEngine(workspace, {
          fallbackBaseUrl: buildOrchestratorWorkspaceOpencodeBaseUrl(
            ctx.config,
            workspace,
          ),
          ifRunning,
        });
      }

      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: "engine.reload",
        target: workspace.baseUrl ?? "opencode",
        summary:
          reloadResult.kind === "reloaded"
            ? "Reloaded workspace engine"
            : "Skipped workspace engine reload because the engine is not ready",
        timestamp: Date.now(),
      });

      return jsonResponse({
        ok: true,
        reloadedAt: Date.now(),
        ifIdle,
        reloaded: reloadResult.kind === "reloaded",
        skipped: reloadResult.kind === "reloaded" ? null : reloadResult.kind,
      });
    },
  );

  addRoute(routes, "GET", "/workspace/:id/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const exportPayload = await exportWorkspace(workspace);
    return jsonResponse(exportPayload);
  });

  addRoute(routes, "POST", "/workspace/:id/import", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(
      ctx.config,
      requireRouteParam(ctx.params, "id", "workspace id"),
    );
    const body = await readJsonBody(ctx.request);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.import",
      summary: "Import workspace config",
      paths: [
        opencodeConfigPath(workspace.path),
        vesloConfigPath(workspace.path),
      ],
    });
    await withWorkspaceSkillLease(
      workspace.path,
      "workspace-import",
      async () => {
        await importWorkspace(workspace, body);
        await refreshWorkspaceRuntimeSkillView(workspace, "workspace-import");
      },
    );
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.import",
      target: "workspace",
      summary: "Imported workspace config",
      timestamp: Date.now(),
    });
    emitReloadEvent(
      ctx.reloadEvents,
      workspace,
      "config",
      buildConfigTrigger(opencodeConfigPath(workspace.path)),
    );
    return jsonResponse({ ok: true });
  });
}
