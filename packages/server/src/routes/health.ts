import { ApiError } from "../errors.js";
import {
  buildOrchestratorWorkspaceOpencodeBaseUrl,
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

export type RuntimeChainStatus =
  | "server_running"
  | "runtime_chain_ready"
  | "orchestrator_unavailable"
  | "shared_engine_unhealthy"
  | "proxy_unreachable";

export type RuntimeChainPayload = {
  status: RuntimeChainStatus;
  checkedAt: number;
  orchestrator: {
    configured: boolean;
    daemonUrl: string | null;
    ok: boolean | null;
    engineTopology: string | null;
    error: string | null;
  };
  sharedEngine: {
    running: boolean | null;
    pending: boolean | null;
    engineState: string | null;
    baseUrl: string | null;
  };
  proxy: {
    workspaceId: string | null;
    ok: boolean | null;
    status: number | null;
    error: string | null;
  };
};

type RuntimeChainFetch = typeof fetch;

const runtimeChainTimeoutMs = 1_500;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJsonWithTimeout(
  fetchImpl: RuntimeChainFetch,
  url: string,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtimeChainTimeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sharedEngineSummary(value: unknown): RuntimeChainPayload["sharedEngine"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { running: null, pending: null, engineState: null, baseUrl: null };
  }
  const record = value as Record<string, unknown>;
  return {
    running: booleanField(record.running),
    pending: booleanField(record.pending),
    engineState: stringField(record.engineState),
    baseUrl: stringField(record.baseUrl),
  };
}

function isSharedEngineReady(shared: RuntimeChainPayload["sharedEngine"]): boolean {
  return shared.running === true && (shared.engineState === "ready" || shared.engineState === "process_ready");
}

function requireRouteParam(params: Record<string, string>, field: string, label = field): string {
  const value = params[field]?.trim() ?? "";
  if (!value) {
    throw new ApiError(400, "invalid_payload", `${label} is required`);
  }
  return value;
}

export async function resolveRuntimeChainPayload(
  config: ServerConfig,
  workspace: WorkspaceInfo | null,
  fetchImpl: RuntimeChainFetch = fetch,
): Promise<RuntimeChainPayload> {
  const checkedAt = Date.now();
  const daemonUrl = config.orchestratorDaemonUrl?.trim().replace(/\/+$/, "") || null;
  const base: RuntimeChainPayload = {
    status: "server_running",
    checkedAt,
    orchestrator: {
      configured: Boolean(daemonUrl),
      daemonUrl,
      ok: null,
      engineTopology: null,
      error: null,
    },
    sharedEngine: { running: null, pending: null, engineState: null, baseUrl: null },
    proxy: { workspaceId: workspace?.id ?? null, ok: null, status: null, error: null },
  };
  if (!daemonUrl) return base;

  let health: { ok: boolean; status: number; body: Record<string, unknown> | null };
  try {
    health = await fetchJsonWithTimeout(fetchImpl, `${daemonUrl}/health`);
  } catch (error) {
    return {
      ...base,
      status: "orchestrator_unavailable",
      orchestrator: { ...base.orchestrator, ok: false, error: messageFromError(error) },
    };
  }
  if (!health.ok || health.body?.ok !== true) {
    return {
      ...base,
      status: "orchestrator_unavailable",
      orchestrator: {
        ...base.orchestrator,
        ok: false,
        error: `HTTP ${health.status}`,
      },
    };
  }

  const engineTopology = stringField(health.body.engineTopology);
  const sharedEngine = sharedEngineSummary(health.body.sharedEngine);
  const withDaemon = {
    ...base,
    orchestrator: {
      ...base.orchestrator,
      ok: true,
      engineTopology,
      error: null,
    },
    sharedEngine,
  };

  if (engineTopology === "shared-unsandboxed" && !isSharedEngineReady(sharedEngine)) {
    return { ...withDaemon, status: "shared_engine_unhealthy" };
  }

  if (workspace && engineTopology === "shared-unsandboxed") {
    const proxyBase = buildOrchestratorWorkspaceOpencodeBaseUrl(config, workspace);
    try {
      const proxy = await fetchJsonWithTimeout(fetchImpl, `${proxyBase}/global/health`);
      if (!proxy.ok) {
        return {
          ...withDaemon,
          status: "proxy_unreachable",
          proxy: { workspaceId: workspace.id, ok: false, status: proxy.status, error: null },
        };
      }
      return {
        ...withDaemon,
        status: "runtime_chain_ready",
        proxy: { workspaceId: workspace.id, ok: true, status: proxy.status, error: null },
      };
    } catch (error) {
      return {
        ...withDaemon,
        status: "proxy_unreachable",
        proxy: { workspaceId: workspace.id, ok: false, status: null, error: messageFromError(error) },
      };
    }
  }

  return { ...withDaemon, status: "runtime_chain_ready" };
}

async function statusPayload(
  ctx: RequestContext,
  dependencies: HealthStatusRouteDependencies,
  workspace: WorkspaceInfo | null,
  workspaceCount: number,
) {
  const { serverVersion, serializeWorkspaceForResponse } = dependencies;
  const runtimeChain = await resolveRuntimeChainPayload(ctx.config, workspace);
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
    runtimeChain,
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
    instanceId: ctx.config.instanceId ?? null,
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
    const workspace = await resolveWorkspace(ctx.config, requireRouteParam(ctx.params, "id", "workspace id"));
    return jsonResponse(await statusPayload(ctx, dependencies, workspace, 1));
  });

  addRoute(routes, "GET", "/w/:id/capabilities", "client", async (ctx) => {
    return jsonResponse(buildCapabilities(ctx.config));
  });

  addRoute(routes, "GET", "/w/:id/workspaces", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, requireRouteParam(ctx.params, "id", "workspace id"));
    return jsonResponse({ items: [serializeWorkspaceForResponse(workspace)], activeId: workspace.id });
  });

  addRoute(routes, "GET", "/status", "client", async (ctx) => {
    const active = ctx.config.workspaces[0] ?? null;
    return jsonResponse(await statusPayload(ctx, dependencies, active, ctx.config.workspaces.length));
  });

  addRoute(routes, "GET", "/capabilities", "client", async (ctx) => {
    return jsonResponse(buildCapabilities(ctx.config));
  });
}
