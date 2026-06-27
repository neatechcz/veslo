import { ApiError } from "../errors.js";
import {
  jsonResponse,
  resolveWorkspace,
} from "../route-helpers.js";
import { addRoute, type RequestContext, type Route } from "../routing.js";
import {
  TOY_UI_CSS,
  TOY_UI_HTML,
  TOY_UI_JS,
  cssResponse,
  htmlResponse,
  jsResponse,
} from "../toy-ui.js";
import type { Capabilities, ServerConfig, WorkspaceInfo } from "../types.js";

export type HealthStatusRouteDependencies = {
  serverVersion: string;
  buildCapabilities: (config: ServerConfig) => Capabilities;
  resolveToyUiEnabled: () => boolean;
  serializeWorkspaceForResponse: (workspace: WorkspaceInfo) => unknown;
};

function statusPayload(
  ctx: RequestContext,
  dependencies: HealthStatusRouteDependencies,
  workspace: WorkspaceInfo | null,
  workspaceCount: number,
) {
  const { serverVersion, serializeWorkspaceForResponse } = dependencies;
  return {
    ok: true,
    version: serverVersion,
    uptimeMs: Date.now() - ctx.config.startedAt,
    readOnly: ctx.config.readOnly,
    approval: ctx.config.approval,
    corsOrigins: ctx.config.corsOrigins,
    workspaceCount,
    activeWorkspaceId: workspace?.id ?? null,
    workspace: workspace ? serializeWorkspaceForResponse(workspace) : null,
    authorizedRoots: ctx.config.authorizedRoots,
    server: {
      host: ctx.config.host,
      port: ctx.config.port,
      configPath: ctx.config.configPath ?? null,
    },
    tokenSource: {
      client: ctx.config.tokenSource,
      host: ctx.config.hostTokenSource,
    },
  };
}

export function registerHealthStatusRoutes(
  routes: Route[],
  dependencies: HealthStatusRouteDependencies,
): void {
  const { serverVersion, buildCapabilities, resolveToyUiEnabled, serializeWorkspaceForResponse } = dependencies;

  const healthPayload = (ctx: RequestContext) => ({
    ok: true,
    version: serverVersion,
    uptimeMs: Date.now() - ctx.config.startedAt,
    pid: process.pid,
  });

  addRoute(routes, "GET", "/health", "none", async (ctx) => {
    return jsonResponse(healthPayload(ctx));
  });

  addRoute(routes, "GET", "/w/:id/health", "none", async (ctx) => {
    return jsonResponse(healthPayload(ctx));
  });

  addRoute(routes, "GET", "/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/w/:id/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/ui/assets/toy.css", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return cssResponse(TOY_UI_CSS);
  });

  addRoute(routes, "GET", "/ui/assets/toy.js", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return jsResponse(TOY_UI_JS);
  });

  addRoute(routes, "GET", "/w/:id/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    return jsonResponse(statusPayload(ctx, dependencies, workspace, 1));
  });

  addRoute(routes, "GET", "/w/:id/capabilities", "client", async (ctx) => {
    return jsonResponse(buildCapabilities(ctx.config));
  });

  addRoute(routes, "GET", "/w/:id/workspaces", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    return jsonResponse({ items: [serializeWorkspaceForResponse(workspace)], activeId: workspace.id });
  });

  addRoute(routes, "GET", "/status", "client", async (ctx) => {
    const active = ctx.config.workspaces[0] ?? null;
    return jsonResponse(statusPayload(ctx, dependencies, active, ctx.config.workspaces.length));
  });

  addRoute(routes, "GET", "/capabilities", "client", async (ctx) => {
    return jsonResponse(buildCapabilities(ctx.config));
  });
}
