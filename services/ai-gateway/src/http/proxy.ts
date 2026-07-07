import { Router, type Request } from "express";

import type { UserAiAccessPolicyRecord } from "../access/repository.js";
import { readBearerToken } from "../auth/user-session.js";
import type { GatewaySession } from "../auth/gateway-session.js";
import { createAnthropicProxyRouter } from "./providers/anthropic.js";
import { createCodexOAuthProxyRouter } from "./providers/codex-oauth.js";
import { createOpenAiCompatibleProxyRouter } from "./providers/openai-compatible.js";
import { createOpenAiProxyRouter } from "./providers/openai.js";
import { asyncHandler, jsonErrorHandler } from "./async-handler.js";
import type { ProxyDependencies } from "./proxy-dependencies.js";

export type { ProxyDependencies } from "./proxy-dependencies.js";

export function createProxyRouter(deps: ProxyDependencies) {
  const router = Router();
  router.use("/providers", asyncHandler(async (req, res, next) => {
    const token = readGatewayAccessToken(req);
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    let session: GatewaySession | null;
    try {
      session = await deps.gatewaySessions.resolveSession(token);
    } catch (error) {
      console.error("gateway_auth_lookup_failed", error);
      res.status(502).json({ error: "gateway_auth_lookup_failed" });
      return;
    }
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    res.locals.gatewaySession = session;
    if (deps.aiAccess) {
      let aiAccess: UserAiAccessPolicyRecord | null;
      try {
        aiAccess = await deps.aiAccess.getUserAiAccess(session.user.id);
      } catch (error) {
        console.error("gateway_ai_access_lookup_failed", error);
        res.status(502).json({ error: "gateway_ai_access_lookup_failed" });
        return;
      }
      if (!aiAccess?.enabled) {
        res.status(403).json({ error: "ai_access_not_configured" });
        return;
      }
      res.locals.gatewayAiAccess = aiAccess;
    }
    next();
  }));

  router.use("/providers/openai", createOpenAiProxyRouter(deps));
  router.use("/providers/anthropic", createAnthropicProxyRouter(deps));
  router.use("/providers/codex_oauth", createCodexOAuthProxyRouter(deps));
  router.use("/providers/openai_compatible", createOpenAiCompatibleProxyRouter(deps));
  router.use(jsonErrorHandler("proxy_request_failed"));

  return router;
}

export function readGatewayAccessToken(req: Request) {
  const bearerToken = readBearerToken(req.header("authorization"));
  if (bearerToken) {
    return bearerToken;
  }

  const gatewayTokenHeader = req.header("x-veslo-gateway-token")?.trim() ?? "";
  if (!gatewayTokenHeader) {
    return null;
  }

  return readBearerToken(gatewayTokenHeader) ?? gatewayTokenHeader;
}
