import express from "express";
import { pathToFileURL } from "node:url";

import { createDb } from "./db/index.js";
import { ensureAiGatewaySchema } from "./db/schema-reconcile.js";
import { env } from "./env.js";
import { createAdminRouter, createDefaultAdminService, type AdminService } from "./http/admin.js";
import { createProxyRouter, type ProxyDependencies } from "./http/proxy.js";
import { createReadinessRouter, type ReadinessDependencies } from "./http/readiness.js";
import { createUserCredentialsRouter, type UserCredentialDependencies } from "./http/user-credentials.js";
import {
  createDefaultProxyDependencies,
  createDefaultReadinessDependencies,
  createDefaultRuntimeState,
  createDefaultUserCredentialDependencies,
  type RuntimeState,
} from "./runtime/default-runtime.js";

export type AppDependencies = {
  admin?: AdminService;
  proxy?: ProxyDependencies;
  readiness?: ReadinessDependencies;
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

  app.use(createReadinessRouter(deps.readiness ?? createDefaultReadinessDependencies(runtime)));
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

  const app = createApp();
  return app.listen(env.port, env.host, () => {
    console.log(`ai-gateway listening on http://${env.host}:${env.port}`);
  });
}

export {
  createDefaultProxyDependencies,
  createDefaultReadinessDependencies,
  createDefaultRuntimeState,
  createDefaultUserCredentialDependencies,
};
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
