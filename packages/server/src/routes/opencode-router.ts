import { createHash, randomInt } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { addRoute, type Route } from "../routing.js";
import {
  ensureWritable,
  jsonResponse,
  readJsonBody,
  requireApproval,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import { ensureDir, exists, shortId } from "../utils.js";

export function registerOpenCodeRouterRoutes(routes: Route[]): void {
  addRoute(routes, "POST", "/workspace/:id/opencode-router/telegram-token", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    logOpenCodeRouterDebug("telegram-token:request", {
      workspaceId: workspace.id,
      actor: ctx.actor?.type ?? "unknown",
      hasToken: Boolean(token),
      healthPort: healthPort ?? null,
      requestHost,
    });
    if (!token) {
      throw new ApiError(400, "token_required", "Telegram token is required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.set-token",
      summary: "Set Telegram bot token",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const identityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    await persistOpenCodeRouterTelegramIdentity({ id: identityId, token, enabled: true, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/telegram",
      { id: identityId, token, enabled: true, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const result: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      telegram: { configured: true, enabled: true },
    };

    const bot = await fetchTelegramBotInfo(token);
    if (bot) {
      (result.telegram as Record<string, unknown>).bot = bot;
    }

    // Reflect opencodeRouter apply status when available.
    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        const telegram = record.telegram as Record<string, unknown>;
        if (typeof telegram.applied === "boolean") {
          (result.telegram as Record<string, unknown>).applied = telegram.applied;
          result.applied = telegram.applied;
        }
        if (typeof telegram.starting === "boolean") {
          (result.telegram as Record<string, unknown>).starting = telegram.starting;
        }
        if (typeof telegram.error === "string" && telegram.error.trim()) {
          (result.telegram as Record<string, unknown>).error = telegram.error;
          result.applyError = telegram.error;
        }
      }
    }

    if (!apply.applied) {
      result.applyError = (typeof result.applyError === "string" && result.applyError.trim())
        ? result.applyError
        : apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") result.applyStatus = apply.status;
    }
    logOpenCodeRouterDebug("telegram-token:updated", {
      workspaceId: workspace.id,
      applied: typeof result.applied === "boolean" ? result.applied : null,
      applyError: typeof result.applyError === "string" ? result.applyError : null,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.set-token",
      target: "opencodeRouter.telegram",
      summary: "Updated Telegram bot token",
      timestamp: Date.now(),
    });

    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/telegram", "client", async (ctx) => {
    const config = ctx.config;
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const info = await readOpenCodeRouterTelegramInfo();
    return jsonResponse({ ok: true, ...info });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/telegram-enabled", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const enabled = body.enabled === true || body.enabled === "true";
    const clearToken = body.clearToken === true || body.clearToken === "true";

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.set-enabled",
      summary: enabled ? "Enable Telegram" : "Disable Telegram",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterTelegramEnabled(enabled, { clearToken: !enabled && clearToken });

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      enabled,
      applied: false,
      applyError: "Restart opencodeRouter to apply",
    };

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.set-enabled",
      target: "opencodeRouter.telegram",
      summary: enabled ? "Enabled Telegram" : "Disabled Telegram",
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/slack-tokens", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    logOpenCodeRouterDebug("slack-tokens:request", {
      workspaceId: workspace.id,
      actor: ctx.actor?.type ?? "unknown",
      hasBotToken: Boolean(botToken),
      hasAppToken: Boolean(appToken),
      healthPort: healthPort ?? null,
      requestHost,
    });
    if (!botToken || !appToken) {
      throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.set-tokens",
      summary: "Set Slack bot tokens",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const identityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    await persistOpenCodeRouterSlackIdentity({ id: identityId, botToken, appToken, enabled: true, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/slack",
      { id: identityId, botToken, appToken, enabled: true, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const result: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      slack: { configured: true, enabled: true },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        const slack = record.slack as Record<string, unknown>;
        if (typeof slack.applied === "boolean") {
          (result.slack as Record<string, unknown>).applied = slack.applied;
          result.applied = slack.applied;
        }
        if (typeof slack.starting === "boolean") {
          (result.slack as Record<string, unknown>).starting = slack.starting;
        }
        if (typeof slack.error === "string" && slack.error.trim()) {
          (result.slack as Record<string, unknown>).error = slack.error;
          result.applyError = slack.error;
        }
      }
    }

    if (!apply.applied) {
      result.applyError = (typeof result.applyError === "string" && result.applyError.trim())
        ? result.applyError
        : apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") result.applyStatus = apply.status;
    }
    logOpenCodeRouterDebug("slack-tokens:updated", {
      workspaceId: workspace.id,
      applied: typeof result.applied === "boolean" ? result.applied : null,
      applyError: typeof result.applyError === "string" ? result.applyError : null,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.set-tokens",
      target: "opencodeRouter.slack",
      summary: "Updated Slack bot tokens",
      timestamp: Date.now(),
    });

    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/identities/telegram", "client", async (ctx) => {
    const config = ctx.config;
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);

    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const apply = await tryFetchOpenCodeRouterHealth("GET", "/identities/telegram", {
      port,
      requestHost,
      timeoutMs: 2_000,
    });

    if (apply.applied && apply.body && typeof apply.body === "object") {
      const payload = apply.body as Record<string, unknown>;
      const rawItems = arrayField(payload, "items");
      if (rawItems.length) {
        const items = rawItems
          .filter(isPlainRecord)
          .map((entry) => {
            const id = normalizeOpenCodeRouterIdentityId(entry.id);
            const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
            const running = entry.running === true || entry.running === "true";
            const access = normalizeTelegramAccessMode(
              entry.access,
              entry.pairingRequired === true || entry.pairingRequired === "true" ? "private" : "public",
            );
            return { id, enabled, running, access, pairingRequired: access === "private" };
          })
          .filter((item) => item.id === workspaceIdentityId);
        return jsonResponse({ ...payload, items });
      }
      return jsonResponse(payload);
    }

    const current = await readOpenCodeRouterConfigFile(resolveOpenCodeRouterConfigPath());
    const channels = ensurePlainObject(current.channels);
    const telegram = ensurePlainObject(channels.telegram);
    const items = recordArrayField(telegram, "bots")
      .map((entry) => {
        const id = normalizeOpenCodeRouterIdentityId(entry.id);
        const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
        const { access } = resolveTelegramAccessFromRecord(entry);
        return { id, enabled, running: false, access, pairingRequired: access === "private" };
      })
      .filter((item) => item.id === workspaceIdentityId);
    return jsonResponse({ ok: true, items });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/identities/telegram", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const enabled = body.enabled === undefined ? true : body.enabled === true || body.enabled === "true";
    const access = normalizeTelegramAccessMode(body.access, "public");
    const pairingCodeInput = typeof body.pairingCode === "string" ? body.pairingCode : "";
    const normalizedPairingCodeInput = normalizeTelegramPairingCode(pairingCodeInput);
    if (
      access === "private" &&
      pairingCodeInput.trim() &&
      (normalizedPairingCodeInput.length < 6 || normalizedPairingCodeInput.length > 24)
    ) {
      throw new ApiError(
        400,
        "invalid_pairing_code",
        "Pairing code must be 6-24 letters or numbers",
      );
    }
    const pairingCode =
      access === "private"
        ? (normalizedPairingCodeInput || normalizeTelegramPairingCode(generateTelegramPairingCode()))
        : "";
    const pairingCodeHash = access === "private" ? hashTelegramPairingCode(pairingCode) : "";
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = typeof body.id === "string" ? normalizeOpenCodeRouterIdentityId(body.id) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    if (!token) {
      throw new ApiError(400, "token_required", "Telegram token is required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.identity.upsert",
      summary: `Upsert Telegram identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterTelegramIdentity({
      id: identityId,
      token,
      enabled,
      directory: workspace.path,
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/telegram",
      {
        id: identityId,
        token,
        enabled,
        directory: workspace.path,
        access,
        ...(access === "private" ? { pairingCodeHash } : {}),
      },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      telegram: {
        id: identityId,
        enabled,
        access,
        pairingRequired: access === "private",
        ...(access === "private" ? { pairingCode } : {}),
      },
    };

    const bot = await fetchTelegramBotInfo(token);
    if (bot) {
      (response.telegram as Record<string, unknown>).bot = bot;
    }

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        response.telegram = {
          ...(response.telegram as Record<string, unknown>),
          ...(record.telegram as Record<string, unknown>),
          access,
          pairingRequired: access === "private",
          ...(access === "private" ? { pairingCode } : {}),
        };
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.identity.upsert",
      target: "opencodeRouter.telegram",
      summary: `Upserted Telegram identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "DELETE", "/workspace/:id/opencode-router/identities/telegram/:identityId", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = normalizeOpenCodeRouterIdentityId(ctx.params.identityId);
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.identity.delete",
      summary: `Delete Telegram identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const deleted = await deleteOpenCodeRouterTelegramIdentity(identityId);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;
    const apply = await tryFetchOpenCodeRouterHealth(
      "DELETE",
      `/identities/telegram/${encodeURIComponent(identityId)}`,
      {
        port,
        requestHost,
        timeoutMs: 3_000,
      },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      deleted,
      applied: apply.applied,
      telegram: { id: identityId, deleted },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        response.telegram = record.telegram;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.identity.delete",
      target: "opencodeRouter.telegram",
      summary: `Deleted Telegram identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/identities/slack", "client", async (ctx) => {
    const config = ctx.config;
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);

    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const apply = await tryFetchOpenCodeRouterHealth("GET", "/identities/slack", {
      port,
      requestHost,
      timeoutMs: 2_000,
    });

    if (apply.applied && apply.body && typeof apply.body === "object") {
      const payload = apply.body as Record<string, unknown>;
      const rawItems = arrayField(payload, "items");
      if (rawItems.length) {
        const items = rawItems
          .filter(isPlainRecord)
          .map((entry) => {
            const id = normalizeOpenCodeRouterIdentityId(entry.id);
            const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
            const running = entry.running === true || entry.running === "true";
            return { id, enabled, running };
          })
          .filter((item) => item.id === workspaceIdentityId);
        return jsonResponse({ ...payload, items });
      }
      return jsonResponse(payload);
    }

    const current = await readOpenCodeRouterConfigFile(resolveOpenCodeRouterConfigPath());
    const channels = ensurePlainObject(current.channels);
    const slack = ensurePlainObject(channels.slack);
    const items = recordArrayField(slack, "apps")
      .map((entry) => {
        const id = normalizeOpenCodeRouterIdentityId(entry.id);
        const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
        return { id, enabled, running: false };
      })
      .filter((item) => item.id === workspaceIdentityId);
    return jsonResponse({ ok: true, items });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/identities/slack", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
    const enabled = body.enabled === undefined ? true : body.enabled === true || body.enabled === "true";
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = typeof body.id === "string" ? normalizeOpenCodeRouterIdentityId(body.id) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    if (!botToken || !appToken) {
      throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.identity.upsert",
      summary: `Upsert Slack identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterSlackIdentity({ id: identityId, botToken, appToken, enabled, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/slack",
      { id: identityId, botToken, appToken, enabled, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      slack: { id: identityId, enabled },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        response.slack = record.slack;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.identity.upsert",
      target: "opencodeRouter.slack",
      summary: `Upserted Slack identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "DELETE", "/workspace/:id/opencode-router/identities/slack/:identityId", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = normalizeOpenCodeRouterIdentityId(ctx.params.identityId);
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.identity.delete",
      summary: `Delete Slack identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const deleted = await deleteOpenCodeRouterSlackIdentity(identityId);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;
    const apply = await tryFetchOpenCodeRouterHealth(
      "DELETE",
      `/identities/slack/${encodeURIComponent(identityId)}`,
      {
        port,
        requestHost,
        timeoutMs: 3_000,
      },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      deleted,
      applied: apply.applied,
      slack: { id: identityId, deleted },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        response.slack = record.slack;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.identity.delete",
      target: "opencodeRouter.slack",
      summary: `Deleted Slack identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/bindings", "client", async (ctx) => {
    const config = ctx.config;
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const search = new URLSearchParams();
    const channel = (ctx.url.searchParams.get("channel") ?? "").trim();
    const identityIdParam = (ctx.url.searchParams.get("identityId") ?? "").trim();
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    if (channel) search.set("channel", channel);
    search.set("identityId", workspaceIdentityId);
    const suffix = search.toString();
    const pathname = suffix ? `/bindings?${suffix}` : "/bindings";

    const apply = await tryFetchOpenCodeRouterHealth("GET", pathname, { port, requestHost, timeoutMs: 2_000 });
    if (apply.applied && apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter is not reachable on this host", {
      port,
      error: apply.error,
      status: apply.status,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/bindings", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const body = await readJsonBody(ctx.request);
    const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
    const identityIdParam = typeof body.identityId === "string" ? body.identityId.trim() : "";
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    const peerId = typeof body.peerId === "string" ? body.peerId.trim() : "";
    const directory = typeof body.directory === "string" ? body.directory.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    if (channel !== "telegram" && channel !== "slack") {
      throw new ApiError(400, "invalid_channel", "channel must be 'telegram' or 'slack'");
    }
    if (!peerId) {
      throw new ApiError(400, "peer_required", "peerId is required");
    }

    const action = directory ? "opencodeRouter.binding.set" : "opencodeRouter.binding.clear";
    const summary = directory
      ? `Bind ${channel}/${identityId}:${peerId} -> ${directory}`
      : `Clear binding for ${channel}/${identityId}:${peerId}`;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action,
      summary,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const payload: Record<string, unknown> = {
      channel,
      identityId,
      peerId,
      ...(directory ? { directory } : {}),
    };
    const apply = await tryPostOpenCodeRouterHealth("/bindings", payload, { port, requestHost, timeoutMs: 3_000 });
    if (!apply.applied) {
      throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter did not apply binding update", {
        port,
        error: apply.error,
        status: apply.status,
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action,
      target: "opencodeRouter.binding",
      summary,
      timestamp: Date.now(),
    });

    if (apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/send", "client", async (ctx) => {
    const config = ctx.config;
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const body = await readJsonBody(ctx.request);
    const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
    const text = typeof body.text === "string" ? body.text : "";
    const peerId = typeof body.peerId === "string" ? body.peerId.trim() : "";
    const autoBind = body.autoBind === true || body.autoBind === "true";
    const directoryInput = typeof body.directory === "string" ? body.directory.trim() : "";
    const directory = directoryInput || workspace.path;
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    const identityIdParam = typeof body.identityId === "string" ? body.identityId.trim() : "";
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = requestedId || undefined;

    if (channel !== "telegram" && channel !== "slack") {
      throw new ApiError(400, "invalid_channel", "channel must be 'telegram' or 'slack'");
    }
    if (!directory.trim() && !peerId) {
      throw new ApiError(400, "directory_required", "directory is required when peerId is not provided");
    }
    if (!text.trim()) {
      throw new ApiError(400, "text_required", "text is required");
    }

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/send",
      {
        channel,
        ...(identityId ? { identityId } : {}),
        ...(directory.trim() ? { directory } : {}),
        ...(peerId ? { peerId } : {}),
        ...(autoBind ? { autoBind: true } : {}),
        text,
      },
      { port, requestHost, timeoutMs: 5_000 },
    );

    if (!apply.applied) {
      throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter did not send the message", {
        port,
        error: apply.error,
        status: apply.status,
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.send",
      target: `opencodeRouter.${channel}`,
      summary: `Sent outbound ${channel} message${identityId ? ` for ${identityId}` : ""}${peerId ? ` to ${peerId}` : ""}`,
      timestamp: Date.now(),
    });

    if (apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    return jsonResponse({
      ok: true,
      channel,
      identityId,
      directory,
      attempted: 0,
      sent: 0,
    });
  });
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveOpenCodeRouterConfigPath(): string {
  const override = process.env.OPENCODE_ROUTER_CONFIG_PATH?.trim();
  if (override) return expandHome(override);
  const dataDir = process.env.OPENCODE_ROUTER_DATA_DIR?.trim() || join(homedir(), ".veslo", "opencode-router");
  return join(expandHome(dataDir), "opencode-router.json");
}

function resolveOpenCodeRouterHealthPort(): number {
  return parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT) ?? 3005;
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function normalizeHealthPort(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const port = Math.trunc(value);
  if (port <= 0 || port > 65535) return null;
  return port;
}

type OpenCodeRouterConfigFile = Record<string, unknown> & {
  version?: number;
  channels?: Record<string, unknown> & {
    telegram?: Record<string, unknown>;
    slack?: Record<string, unknown>;
  };
};

type TelegramBotInfo = {
  id: number;
  username?: string;
  name?: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ensurePlainObject(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function recordArrayField(record: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  return arrayField(record, key).filter(isPlainRecord);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeOpenCodeRouterIdentityId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "default";
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const cleaned = safe.replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "default";
}

type TelegramAccessMode = "public" | "private";

const TELEGRAM_PAIRING_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const TELEGRAM_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeTelegramAccessMode(value: unknown, fallback: TelegramAccessMode = "public"): TelegramAccessMode {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "private") return "private";
  if (raw === "public") return "public";
  return fallback;
}

function normalizeTelegramPairingCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTelegramPairingCodeHash(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!TELEGRAM_PAIRING_CODE_HASH_PATTERN.test(raw)) return "";
  return raw;
}

function hashTelegramPairingCode(value: string): string {
  return createHash("sha256").update(normalizeTelegramPairingCode(value)).digest("hex");
}

function generateTelegramPairingCode(): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += TELEGRAM_PAIRING_CODE_ALPHABET[randomInt(0, TELEGRAM_PAIRING_CODE_ALPHABET.length)] ?? "";
  }
  if (code.length !== 8) {
    throw new ApiError(500, "pairing_code_generation_failed", "Failed to generate Telegram pairing code");
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function resolveTelegramAccessFromRecord(record: Record<string, unknown>): {
  access: TelegramAccessMode;
  pairingCodeHash: string;
} {
  const pairingCodeHash = normalizeTelegramPairingCodeHash(record.pairingCodeHash);
  const access = normalizeTelegramAccessMode(record.access, pairingCodeHash ? "private" : "public");
  return {
    access,
    pairingCodeHash: access === "private" ? pairingCodeHash : "",
  };
}

async function readOpenCodeRouterConfigFile(configPath: string): Promise<OpenCodeRouterConfigFile> {
  if (!(await exists(configPath))) {
    return { version: 1 };
  }

  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ApiError(500, "opencodeRouter_config_read_failed", "Failed to read opencode-router.json", {
      path: configPath,
      error: String(error),
    });
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return ensurePlainObject(parsed) as OpenCodeRouterConfigFile;
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse opencode-router.json", {
      path: configPath,
      error: String(error),
    });
  }
}

async function writeOpenCodeRouterConfigFile(configPath: string, config: OpenCodeRouterConfigFile): Promise<void> {
  await ensureDir(dirname(configPath));
  const next: OpenCodeRouterConfigFile = {
    ...config,
    version: typeof config.version === "number" && Number.isFinite(config.version) ? config.version : 1,
  };
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
  } finally {
    try {
      await rm(tmpPath);
    } catch {
      // ignore
    }
  }
}

async function persistOpenCodeRouterTelegramIdentity(identity: {
  id: string;
  token: string;
  enabled: boolean;
  directory?: string;
  access?: TelegramAccessMode;
  pairingCodeHash?: string;
}): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const id = normalizeOpenCodeRouterIdentityId(identity.id);
  const token = identity.token.trim();
  const directory = typeof identity.directory === "string" ? identity.directory.trim() : "";
  const requestedAccess = identity.access ? normalizeTelegramAccessMode(identity.access, "public") : undefined;
  const requestedPairingCodeHash = normalizeTelegramPairingCodeHash(identity.pairingCodeHash);
  if (!token) {
    throw new ApiError(400, "token_required", "Telegram token is required");
  }

  const nextBots: Array<Record<string, unknown>> = [];
  let found = false;
  for (const record of recordArrayField(telegram, "bots")) {
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId !== id) {
      nextBots.push(record);
      continue;
    }
    found = true;
    const prevDir = typeof record.directory === "string" ? record.directory.trim() : "";
    const nextDir = directory || prevDir;
    const existingAccessState = resolveTelegramAccessFromRecord(record);
    const access = requestedAccess ?? existingAccessState.access;
    const pairingCodeHash = access === "private"
      ? (requestedPairingCodeHash || existingAccessState.pairingCodeHash)
      : "";
    if (access === "private" && !pairingCodeHash) {
      throw new ApiError(400, "pairing_code_required", "Telegram private access requires a pairing code hash");
    }
    nextBots.push({
      id,
      token,
      enabled: identity.enabled,
      ...(nextDir ? { directory: nextDir } : {}),
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });
  }
  if (!found) {
    const access = requestedAccess ?? "public";
    const pairingCodeHash = access === "private" ? requestedPairingCodeHash : "";
    if (access === "private" && !pairingCodeHash) {
      throw new ApiError(400, "pairing_code_required", "Telegram private access requires a pairing code hash");
    }
    nextBots.push({
      id,
      token,
      enabled: identity.enabled,
      ...(directory ? { directory } : {}),
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    enabled: true,
    bots: nextBots,
  };
  if (id === "default") {
    nextTelegram.token = token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function deleteOpenCodeRouterTelegramIdentity(idRaw: string): Promise<boolean> {
  const id = normalizeOpenCodeRouterIdentityId(idRaw);
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const nextBots: Array<Record<string, unknown>> = [];
  let deleted = false;
  for (const record of recordArrayField(telegram, "bots")) {
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId === id) {
      deleted = true;
      continue;
    }
    nextBots.push(record);
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    bots: nextBots,
  };
  if (id === "default") {
    delete nextTelegram.token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
  return deleted;
}

async function persistOpenCodeRouterTelegramEnabled(enabled: boolean, options?: { clearToken?: boolean }) {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const bots = recordArrayField(telegram, "bots");
  const nextBots: Array<Record<string, unknown>> = [];
  for (const record of bots) {
    const id = stringField(record, "id")?.trim() ?? "";
    if (!id) {
      nextBots.push(record);
      continue;
    }
    if (!enabled && options?.clearToken && id === "default") {
      const nextRecord = { ...record };
      delete nextRecord.token;
      nextBots.push(nextRecord);
      continue;
    }
    nextBots.push(record);
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    enabled,
    ...(bots.length ? { bots: nextBots } : {}),
  };
  if (!enabled && options?.clearToken) {
    delete nextTelegram.token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function fetchTelegramBotInfo(token: string): Promise<TelegramBotInfo | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
      method: "GET",
      signal: controller.signal,
    });
    const json = ensurePlainObject(await response.json().catch(() => null));
    const result = ensurePlainObject(json.result);
    if (!response.ok || json.ok !== true || !Object.keys(result).length) return null;
    const id = typeof result.id === "number" ? result.id : null;
    if (id == null) return null;
    const username = stringField(result, "username");
    const name = stringField(result, "first_name");
    return { id, username, name };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readOpenCodeRouterTelegramInfo(): Promise<{
  configured: boolean;
  enabled: boolean;
  bot: TelegramBotInfo | null;
}> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const channelEnabled = telegram.enabled === undefined ? true : telegram.enabled === true || telegram.enabled === "true";

  let token = "";
  let identityEnabled = true;
  for (const record of recordArrayField(telegram, "bots")) {
    const id = stringField(record, "id")?.trim() ?? "";
    if (id !== "default") continue;
    token = stringField(record, "token")?.trim() ?? "";
    identityEnabled = record.enabled === undefined ? true : record.enabled === true || record.enabled === "true";
    break;
  }
  if (!token) {
    token = stringField(telegram, "token")?.trim() ?? "";
  }

  const configured = Boolean(token);
  const bot = configured ? await fetchTelegramBotInfo(token) : null;
  const enabled = configured ? channelEnabled && identityEnabled : false;
  return { configured, enabled, bot };
}

async function persistOpenCodeRouterSlackIdentity(identity: {
  id: string;
  botToken: string;
  appToken: string;
  enabled: boolean;
  directory?: string;
}): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const slack = ensurePlainObject(channels.slack);

  const id = normalizeOpenCodeRouterIdentityId(identity.id);
  const botToken = identity.botToken.trim();
  const appToken = identity.appToken.trim();
  const directory = typeof identity.directory === "string" ? identity.directory.trim() : "";
  if (!botToken || !appToken) {
    throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
  }

  const nextApps: Array<Record<string, unknown>> = [];
  let found = false;
  for (const record of recordArrayField(slack, "apps")) {
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId !== id) {
      nextApps.push(record);
      continue;
    }
    found = true;
    const prevDir = typeof record.directory === "string" ? record.directory.trim() : "";
    const nextDir = directory || prevDir;
    nextApps.push({ id, botToken, appToken, enabled: identity.enabled, ...(nextDir ? { directory: nextDir } : {}) });
  }
  if (!found) {
    nextApps.push({ id, botToken, appToken, enabled: identity.enabled, ...(directory ? { directory } : {}) });
  }

  const nextSlack: Record<string, unknown> = {
    ...slack,
    enabled: true,
    apps: nextApps,
  };
  if (id === "default") {
    nextSlack.botToken = botToken;
    nextSlack.appToken = appToken;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      slack: nextSlack,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function deleteOpenCodeRouterSlackIdentity(idRaw: string): Promise<boolean> {
  const id = normalizeOpenCodeRouterIdentityId(idRaw);
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const slack = ensurePlainObject(channels.slack);

  const nextApps: Array<Record<string, unknown>> = [];
  let deleted = false;
  for (const record of recordArrayField(slack, "apps")) {
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId === id) {
      deleted = true;
      continue;
    }
    nextApps.push(record);
  }

  const nextSlack: Record<string, unknown> = {
    ...slack,
    apps: nextApps,
  };
  if (id === "default") {
    delete nextSlack.botToken;
    delete nextSlack.appToken;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      slack: nextSlack,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
  return deleted;
}

type OpenCodeRouterApplyAttempt = {
  applied: boolean;
  port: number;
  hosts: string[];
  host?: string;
  status?: number;
  error?: string;
  body?: unknown;
};

async function tryPostOpenCodeRouterHealth(
  pathname: string,
  payload: unknown,
  options: { port: number; requestHost?: string | null; timeoutMs: number },
): Promise<OpenCodeRouterApplyAttempt> {
  const candidates = Array.from(
    new Set(
      ["127.0.0.1", options.requestHost].filter(
        (host): host is string => Boolean(host && host.trim()),
      ),
    ),
  );
  const port = options.port;

  let lastError: OpenCodeRouterApplyAttempt | null = null;
  for (const host of candidates) {
    const url = `http://${host}:${port}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const parsed = parseJsonResponse(text);

      if (response.ok) {
        return {
          applied: true,
          port,
          hosts: candidates,
          host,
          status: response.status,
          body: parsed,
        };
      }

      const detail =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || "OpenCodeRouter request failed";
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        status: response.status,
        error: detail,
        body: parsed,
      };
    } catch (error) {
      clearTimeout(timer);
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timeout after ${options.timeoutMs}ms`
          : String(error);
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        error: message,
      };
    }
  }

  return (
    lastError ?? {
      applied: false,
      port,
      hosts: candidates,
      error: "OpenCodeRouter health server is unavailable",
    }
  );
}

async function tryFetchOpenCodeRouterHealth(
  method: "GET" | "DELETE",
  pathname: string,
  options: { port: number; requestHost?: string | null; timeoutMs: number },
): Promise<OpenCodeRouterApplyAttempt> {
  const candidates = Array.from(
    new Set(
      ["127.0.0.1", options.requestHost].filter(
        (host): host is string => Boolean(host && host.trim()),
      ),
    ),
  );
  const port = options.port;

  let lastError: OpenCodeRouterApplyAttempt | null = null;
  for (const host of candidates) {
    const url = `http://${host}:${port}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const parsed = parseJsonResponse(text);

      if (response.ok) {
        return {
          applied: true,
          port,
          hosts: candidates,
          host,
          status: response.status,
          body: parsed,
        };
      }

      const detail =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || "OpenCodeRouter request failed";
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        status: response.status,
        error: detail,
        body: parsed,
      };
    } catch (error) {
      clearTimeout(timer);
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timeout after ${options.timeoutMs}ms`
          : String(error);
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        error: message,
      };
    }
  }

  return (
    lastError ?? {
      applied: false,
      port,
      hosts: candidates,
      error: "OpenCodeRouter health server is unavailable",
    }
  );
}

function opencodeRouterDebugEnabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.VESLO_DEBUG_OPENCODE_ROUTER ?? "").toLowerCase());
}

function logOpenCodeRouterDebug(message: string, details?: Record<string, unknown>) {
  if (!opencodeRouterDebugEnabled()) return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[opencodeRouter] ${message}${payload}`);
}
