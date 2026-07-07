import { join } from "node:path";

import { recordAudit } from "../audit.js";
import { deleteCommand, listCommands, upsertCommand } from "../commands.js";
import { ApiError } from "../errors.js";
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
import type { Actor, ServerConfig, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import { sanitizeCommandName } from "../validators.js";
import type { TokenService } from "../tokens.js";

type RequireHost = (request: Request, config: ServerConfig, tokens: TokenService) => Promise<Actor>;

export type CommandRouteDependencies = {
  requireHost: RequireHost;
};

function requireRouteParam(params: Record<string, string>, field: string, label = field): string {
  const value = params[field]?.trim() ?? "";
  if (!value) {
    throw new ApiError(400, "invalid_payload", `${label} is required`);
  }
  return value;
}

const ownerForWorkspace = (workspace: WorkspaceInfo) =>
  workspaceResourceOwner({ workspaceId: workspace.id, root: workspace.path, label: workspace.name });

export function registerCommandRoutes(routes: Route[], dependencies: CommandRouteDependencies): void {
  addRoute(routes, "GET", "/workspace/:id/commands", "client", async (ctx) => {
    const config = ctx.config;
    const scope = ctx.url.searchParams.get("scope") === "global" ? "global" : "workspace";
    if (scope === "global") {
      await dependencies.requireHost(ctx.request, config, ctx.tokens);
    }
    const workspace = await resolveWorkspace(config, requireRouteParam(ctx.params, "id", "workspace id"));
    const items = await listCommands(workspace.path, scope, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/commands", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, requireRouteParam(ctx.params, "id", "workspace id"));
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const template = String(body.template ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.upsert",
      summary: `Upsert command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    const commandPayload: Parameters<typeof upsertCommand>[1] = {
      name,
      template,
    };
    const description = body.description ? String(body.description) : undefined;
    if (description) commandPayload.description = description;
    const agent = body.agent ? String(body.agent) : undefined;
    if (agent) commandPayload.agent = agent;
    const model = body.model ? String(body.model) : undefined;
    if (model) commandPayload.model = model;
    if (typeof body.subtask === "boolean") commandPayload.subtask = body.subtask;
    const path = await upsertCommand(workspace.path, commandPayload);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.upsert",
      target: path,
      summary: `Upserted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "updated",
      path,
    });
    const items = await listCommands(workspace.path, "workspace", { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/commands/:name", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, requireRouteParam(ctx.params, "id", "workspace id"));
    const name = requireRouteParam(ctx.params, "name", "command name");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.delete",
      summary: `Delete command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    await deleteCommand(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.delete",
      target: join(workspace.path, ".opencode", "commands"),
      summary: `Deleted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "removed",
      path: join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`),
    });
    return jsonResponse({ ok: true });
  });
}
