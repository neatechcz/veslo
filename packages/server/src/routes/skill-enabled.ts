import { ApiError } from "../errors.js";
import {
  invalidateActiveRuntimeSkillView,
  readServingRuntimeSkillBinding,
} from "../active-runtime-skill-view.js";
import { fenceRuntimeSkillAuthorization } from "../runtime-skill-revocation-fence.js";
import { addRoute, type Route } from "../routing.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import {
  listDisabledSkills,
  setSkillEnabledState,
} from "../skill-enabled-overrides.js";
import type {
  DisabledSkillTarget,
  ReloadTrigger,
  WorkspaceInfo,
} from "../types.js";
import {
  withWorkspaceSkillLease,
  workspaceSkillLeaseKey,
} from "../workspace-skill-lease.js";

export type SkillEnabledRouteDependencies = {
  serverDataDir: string;
};

function trimmedSearchParam(
  params: URLSearchParams,
  key: string,
): string | undefined {
  const value = params.get(key)?.trim();
  return value || undefined;
}

function optionalBodyBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];
  return typeof value === "boolean" ? value : undefined;
}

function requireBodyObject(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = body[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_payload", `${field} is required`);
  }
  return value as Record<string, unknown>;
}

export function registerSkillEnabledRoutes(
  routes: Route[],
  dependencies: SkillEnabledRouteDependencies,
): void {
  const { serverDataDir } = dependencies;
  const refreshWorkspaceRuntimeSkillView = async (
    workspace: WorkspaceInfo,
  ): Promise<void> => {
    invalidateActiveRuntimeSkillView(workspace);
  };
  const withWorkspaceSkillLeases = async <T>(
    workspaces: WorkspaceInfo[],
    task: () => Promise<T>,
  ): Promise<T> => {
    // Deduplicate and order by the lease key, not by workspace id: two ids can
    // point at the same root, and nesting the same lease twice would deadlock.
    // The shared ordering also keeps concurrent processes from acquiring
    // multi-workspace leases in opposite directions.
    const uniqueWorkspaces = [
      ...new Map(
        workspaces.map((workspace) => [
          workspaceSkillLeaseKey(workspace.path),
          workspace,
        ]),
      ).entries(),
    ]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, workspace]) => workspace);
    const visit = async (index: number): Promise<T> => {
      if (index >= uniqueWorkspaces.length) return task();
      const workspace = uniqueWorkspaces[index]!;
      return withWorkspaceSkillLease(
        workspace.path,
        "skill-enabled-state",
        () => visit(index + 1),
      );
    };
    return visit(0);
  };

  addRoute(routes, "GET", "/skills/disabled", "client", async (ctx) => {
    const workspaceId = trimmedSearchParam(ctx.url.searchParams, "workspaceId");
    if (workspaceId) {
      await resolveWorkspace(ctx.config, workspaceId);
    }
    const items = await listDisabledSkills({
      dataDir: serverDataDir,
      workspaceId,
      includeGlobal: true,
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "PATCH", "/skills/enabled-state", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const target = requireBodyObject(
      body,
      "target",
    ) as unknown as DisabledSkillTarget;
    const enabled = optionalBodyBoolean(body, "enabled");
    if (enabled === undefined) {
      throw new ApiError(400, "invalid_enabled", "enabled is required");
    }

    const workspaceId =
      typeof target.workspaceId === "string" ? target.workspaceId.trim() : "";
    const workspace = workspaceId
      ? await resolveWorkspace(ctx.config, workspaceId)
      : null;
    const affectedWorkspaces = workspace
      ? [workspace]
      : target.scope === "user-global" ||
          target.scope === "organization" ||
          target.scope === "platform"
        ? ctx.config.workspaces.filter(
            (configuredWorkspace) =>
              configuredWorkspace.workspaceType === "local",
          )
        : [];
    const result = await withWorkspaceSkillLeases(
      affectedWorkspaces,
      async () => {
        if (!enabled) {
          for (const affectedWorkspace of affectedWorkspaces) {
            const binding = await readServingRuntimeSkillBinding(affectedWorkspace, { dataDir: serverDataDir });
            if (binding) await fenceRuntimeSkillAuthorization({
              dataDir: serverDataDir,
              workspaceId: affectedWorkspace.id,
              authorizationRevision: binding.authorizationRevision,
            });
          }
        }
        const result = await setSkillEnabledState({
          dataDir: serverDataDir,
          target,
          enabled,
          actor: ctx.actor ?? { type: "remote" },
        });
        for (const affectedWorkspace of affectedWorkspaces) {
          await refreshWorkspaceRuntimeSkillView(affectedWorkspace);
        }
        return result;
      },
    );

    const reloadTrigger: ReloadTrigger = {
      type: "skill",
      name:
        typeof target.name === "string"
          ? target.name.trim() || undefined
          : undefined,
      action: "updated",
      path:
        typeof target.path === "string"
          ? target.path.trim() || undefined
          : undefined,
    };
    if (workspace) {
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", reloadTrigger);
    } else if (
      target.scope === "user-global" ||
      target.scope === "organization" ||
      target.scope === "platform"
    ) {
      for (const configuredWorkspace of ctx.config.workspaces) {
        emitReloadEvent(
          ctx.reloadEvents,
          configuredWorkspace,
          "skills",
          reloadTrigger,
        );
      }
    }

    return jsonResponse(result);
  });
}
