import express from "express";
import { pathToFileURL } from "node:url";

import { createDb } from "./db/index.js";
import { ensureAiGatewaySchema } from "./db/schema-reconcile.js";
import { isAdminAlertEmailConfigured } from "./email/admin-alert-mailer.js";
import { env } from "./env.js";
import { createAdminRouter, createDefaultAdminService, type AdminService } from "./http/admin.js";
import { createProxyRouter, type ProxyDependencies } from "./http/proxy.js";
import { createUserCredentialsRouter, type UserCredentialDependencies } from "./http/user-credentials.js";
import {
  createDefaultProxyDependencies,
  createDefaultRuntimeState,
  createDefaultUserCredentialDependencies,
  type RuntimeState,
} from "./runtime/default-runtime.js";

export type AppDependencies = {
  admin?: AdminService;
  proxy?: ProxyDependencies;
  userCredentials?: UserCredentialDependencies;
  runtime?: RuntimeState;
};

const MANAGED_AI_PROXY_JSON_LIMIT = "10mb";

export function createApp(deps: AppDependencies = {}) {
  const app = express();
  const runtime = deps.runtime ?? createDefaultRuntimeState();
  const managedAiProxyJsonParser = express.json({ limit: MANAGED_AI_PROXY_JSON_LIMIT });
  app.use("/providers", managedAiProxyJsonParser);
  app.use("/ai-gateway/providers", managedAiProxyJsonParser);
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "ai-gateway" });
  });

  app.use(createAdminRouter(deps.admin ?? createDefaultAdminService(env.denApiBase)));
  app.use(createUserCredentialsRouter(deps.userCredentials ?? createDefaultUserCredentialDependencies(runtime)));
  const proxyDeps = deps.proxy ?? createDefaultProxyDependencies(runtime);
  app.use(createProxyRouter(proxyDeps));
  app.use("/ai-gateway", createProxyRouter(proxyDeps));

  return app;
}

export async function startServer() {
  const schemaDb = createDb(env.databaseUrl);
  try {
    await ensureAiGatewaySchema(schemaDb.client);
  } finally {
    await schemaDb.close();
  }

  const adminService = createDefaultAdminService(env.denApiBase);
  const app = createApp({ admin: adminService });
  const server = app.listen(env.port, env.host, () => {
    console.log(`ai-gateway listening on http://${env.host}:${env.port}`);
  });
  startCodexCapacityAlertEmailLoop(adminService);
  startCredentialAlertEmailLoop(adminService);
  return server;
}

export { createDefaultProxyDependencies, createDefaultRuntimeState, createDefaultUserCredentialDependencies };
export type { RuntimeState };

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  void startServer().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[ai-gateway] bootstrap failed: ${message}`);
    process.exit(1);
  });
}

function startCodexCapacityAlertEmailLoop(adminService: AdminService) {
  if (!adminService.runCodexCapacityAlertEmailMonitor) {
    return;
  }

  if (!isAdminAlertEmailConfigured()) {
    console.warn("[ai-gateway] Codex capacity alert emails disabled: Lettr email env is not configured");
    return;
  }

  if (env.alertEmail.recipients.length === 0) {
    console.warn("[ai-gateway] Codex capacity alert emails disabled: AI_GATEWAY_ALERT_EMAIL_RECIPIENTS is empty");
    return;
  }

  const runMonitorBestEffort = () => {
    void adminService.runCodexCapacityAlertEmailMonitor?.().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[ai-gateway] Codex capacity alert email monitor failed: ${message}`);
    });
  };

  runMonitorBestEffort();
  const interval = setInterval(runMonitorBestEffort, env.alertEmail.codexCapacityIntervalMs);
  unrefTimer(interval);
}

function startCredentialAlertEmailLoop(adminService: AdminService) {
  if (!adminService.runCredentialAlertEmailMonitor) {
    return;
  }

  if (!isAdminAlertEmailConfigured()) {
    console.warn("[ai-gateway] credential alert emails disabled: Lettr email env is not configured");
    return;
  }

  const runMonitorBestEffort = () => {
    void adminService.runCredentialAlertEmailMonitor?.().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[ai-gateway] credential alert email monitor failed: ${message}`);
    });
  };

  runMonitorBestEffort();
  const interval = setInterval(runMonitorBestEffort, env.alertEmail.credentialAlertIntervalMs);
  unrefTimer(interval);
}

function unrefTimer(handle: unknown) {
  if (!handle || typeof handle !== "object") {
    return;
  }

  const unref = (handle as { unref?: unknown }).unref;
  if (typeof unref === "function") {
    unref.call(handle);
  }
}
