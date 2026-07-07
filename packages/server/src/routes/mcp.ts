import { homedir } from "node:os";
import { join } from "node:path";

import { recordAudit } from "../audit.js";
import { createOrgMcpRuntimeToken, fetchOrgMcpCatalog } from "../den-catalog.js";
import { normalizeDenApiBaseUrl } from "../den-api-base.js";
import { ApiError } from "../errors.js";
import { addMcp, installHubMcp, listMcp, refreshMcpRuntimeToken, removeMcp } from "../mcp.js";
import { workspaceResourceOwner } from "../resource-owner.js";
import { addRoute, type Route } from "../routing.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  requireApproval,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import type { WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import { validateMcpName } from "../validators.js";
import { opencodeConfigPath } from "../workspace-files.js";

type FetchOpencodeJson = (
  workspace: WorkspaceInfo,
  path: string,
  init: {
    method: string;
    body?: unknown;
    directory?: string | null;
    maxResponseBytes?: number;
    timeoutMs?: number;
    sendTraceId?: string | null;
  },
) => Promise<unknown>;

export type McpRouteDependencies = {
  fetchOpencodeJson: FetchOpencodeJson;
};

const ownerForWorkspace = (workspace: WorkspaceInfo) =>
  workspaceResourceOwner({ workspaceId: workspace.id, root: workspace.path, label: workspace.name });

function requireRouteParam(params: Record<string, string>, field: string, label = field): string {
  const value = params[field]?.trim() ?? "";
  if (!value) {
    throw new ApiError(400, "invalid_payload", `${label} is required`);
  }
  return value;
}

const requireDenCatalogContext = (ctx: Parameters<Route["handler"]>[0]) => {
  const denToken = ctx.request.headers.get("x-veslo-den-token")?.trim() || "";
  if (!denToken) {
    throw new ApiError(401, "den_token_required", "Missing Den token header (x-veslo-den-token)");
  }

  const denOrgId = ctx.request.headers.get("x-veslo-den-org-id")?.trim() || "";
  if (!denOrgId) {
    throw new ApiError(400, "den_org_required", "Missing Den org header (x-veslo-den-org-id)");
  }

  const denApiBase = normalizeDenApiBaseUrl(ctx.config.denApiBase) ?? "";
  if (!denApiBase) {
    throw new ApiError(503, "den_catalog_misconfigured", "Den catalog base URL is missing");
  }

  return { denToken, denOrgId, denApiBase };
};

export function registerMcpRoutes(routes: Route[], dependencies: McpRouteDependencies): void {
  addRoute(routes, "GET", "/hub/mcp", "client", async (ctx) => {
    const denToken = ctx.request.headers.get("x-veslo-den-token")?.trim() || "";
    if (!denToken) {
      throw new ApiError(401, "den_token_required", "Missing Den token header (x-veslo-den-token)");
    }

    const denOrgId = ctx.request.headers.get("x-veslo-den-org-id")?.trim() || "";
    if (!denOrgId) {
      throw new ApiError(400, "den_org_required", "Missing Den org header (x-veslo-den-org-id)");
    }

    const denApiBase = normalizeDenApiBaseUrl(ctx.config.denApiBase) ?? "";
    if (!denApiBase) {
      return jsonResponse({ items: [] });
    }

    const items = await fetchOrgMcpCatalog({
      baseUrl: denApiBase,
      orgId: denOrgId,
      denToken,
    });

    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, requireRouteParam(ctx.params, "id", "workspace id"));
    const items = await listMcp(workspace.path, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/hub/:name", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, requireRouteParam(ctx.params, "id", "workspace id"));
    const catalogName = requireRouteParam(ctx.params, "name", "MCP name");

    const { denApiBase, denOrgId, denToken } = requireDenCatalogContext(ctx);
    const items = await fetchOrgMcpCatalog({
      baseUrl: denApiBase,
      orgId: denOrgId,
      denToken,
    });
    const item = items.find((entry) => entry.id === catalogName || entry.name === catalogName);
    if (!item) {
      throw new ApiError(404, "hub_mcp_not_found", `Hub MCP not found: ${catalogName}`);
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.install_hub",
      summary: `Install hub MCP ${catalogName}`,
      paths: [opencodeConfigPath(workspace.path)],
    });

    let installItem = item;
    if (item.authorization?.type === "veslo-server-oauth") {
      const runtimeToken = await createOrgMcpRuntimeToken({
        baseUrl: denApiBase,
        denToken,
        runtimeTokenPath: item.authorization.runtimeTokenPath,
      });
      installItem = {
        ...item,
        config: {
          ...item.config,
          headers: {
            ...(item.config.headers ?? {}),
            "X-Veslo-Connector-Token": runtimeToken.token,
          },
        },
      };
    }

    const result = await installHubMcp(workspace.path, installItem);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.install_hub",
      target: "opencode.json",
      summary: `Installed hub MCP ${result.name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name: result.name,
      action: result.action,
    });

    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/:name/runtime-token/refresh", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, requireRouteParam(ctx.params, "id", "workspace id"));
    const name = requireRouteParam(ctx.params, "name", "MCP name");
    validateMcpName(name);

    const { denApiBase, denOrgId, denToken } = requireDenCatalogContext(ctx);
    const items = await fetchOrgMcpCatalog({
      baseUrl: denApiBase,
      orgId: denOrgId,
      denToken,
    });
    const item = items.find((entry) => entry.id === name || entry.name === name);
    if (!item) {
      throw new ApiError(404, "hub_mcp_not_found", `Hub MCP not found: ${name}`);
    }
    if (item.authorization?.type !== "veslo-server-oauth") {
      throw new ApiError(400, "mcp_runtime_token_unavailable", "MCP does not use Veslo-managed runtime tokens");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.runtime_token.refresh",
      summary: `Refresh MCP runtime token ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });

    const runtimeToken = await createOrgMcpRuntimeToken({
      baseUrl: denApiBase,
      denToken,
      runtimeTokenPath: item.authorization.runtimeTokenPath,
    });
    const result = await refreshMcpRuntimeToken(workspace.path, name, runtimeToken.token);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.runtime_token.refresh",
      target: "opencode.json",
      summary: `Refreshed MCP runtime token ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: "updated",
    });

    return jsonResponse({ ok: true, ...result, expiresAt: runtimeToken.expiresAt });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, requireRouteParam(ctx.params, "id", "workspace id"));
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const configPayload = body.config as Record<string, unknown> | undefined;
    if (!configPayload) {
      throw new ApiError(400, "invalid_payload", "MCP config is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary: `Add MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const result = await addMcp(workspace.path, name, configPayload);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: "opencode.json",
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: result.action,
    });
    const items = await listMcp(workspace.path, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, requireRouteParam(ctx.params, "id", "workspace id"));
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.remove",
      summary: `Remove MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removeMcp(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.remove",
      target: "opencode.json",
      summary: `Removed MCP ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
        type: "mcp",
        name,
        action: "removed",
      });
    }
    const items = await listMcp(workspace.path, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name/auth", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, requireRouteParam(ctx.params, "id", "workspace id"));
    const name = requireRouteParam(ctx.params, "name", "MCP name");
    validateMcpName(name);

    const authStorePath = join(homedir(), ".config", "opencode", "mcp-auth.json");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.remove",
      summary: `Logout MCP ${name}`,
      paths: [authStorePath],
    });

    try {
      await dependencies.fetchOpencodeJson(workspace, `/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST" });
    } catch {
      // Best-effort disconnect so any active connection is torn down.
    }

    try {
      await dependencies.fetchOpencodeJson(workspace, `/mcp/${encodeURIComponent(name)}/auth`, { method: "DELETE" });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "opencode_request_failed" &&
        error.details &&
        typeof error.details === "object" &&
        "status" in (error.details as Record<string, unknown>) &&
        (error.details as { status?: unknown }).status === 404
      ) {
        // Treat missing credentials as a successful logout (idempotent).
      } else {
        throw error;
      }
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.auth.remove",
      target: authStorePath,
      summary: `Logged out MCP ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true });
  });
}
