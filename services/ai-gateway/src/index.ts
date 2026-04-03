import express from "express";
import { pathToFileURL } from "node:url";

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

export function createApp(deps: AppDependencies = {}) {
  const app = express();
  const runtime = deps.runtime ?? createDefaultRuntimeState();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "ai-gateway" });
  });

  app.use(createAdminRouter(deps.admin ?? createDefaultAdminService(env.denApiBase)));
  app.use(createUserCredentialsRouter(deps.userCredentials ?? createDefaultUserCredentialDependencies(runtime)));
  app.use(createProxyRouter(deps.proxy ?? createDefaultProxyDependencies(runtime)));

  return app;
}

export function startServer() {
  const app = createApp();
  return app.listen(env.port, env.host, () => {
    console.log(`ai-gateway listening on http://${env.host}:${env.port}`);
  });
}

export { createDefaultProxyDependencies, createDefaultRuntimeState, createDefaultUserCredentialDependencies };
export type { RuntimeState };

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startServer();
}
