import { Router, type Request } from "express";

import type { UserAiAccessPolicyRecord } from "../access/repository.js";
import { AutomaticUserAiAccessInfrastructureError } from "../access/automatic-user-access.js";
import { readBearerToken } from "../auth/user-session.js";
import type { GatewaySession } from "../auth/gateway-session.js";
import { ManagedAiEntitlementLookupError } from "../billing/den-managed-ai-entitlement-resolver.js";
import { VESLO_DEN_ORG_ID_HEADER, VESLO_ORG_ID_HEADER } from "../headers.js";
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
    try {
      const entitlement = await deps.managedAiEntitlement.resolve({
        token: session.token,
        requestedOrgId: readRequestedOrganizationId(req),
      });
      if (!entitlement.canUseManagedAi) {
        res.status(402).json({ error: "managed_ai_entitlement_denied" });
        return;
      }
      res.locals.gatewayOrganizationId = entitlement.orgId;
    } catch (error) {
      if (error instanceof ManagedAiEntitlementLookupError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      res.status(503).json({ error: "managed_ai_entitlement_unavailable" });
      return;
    }

    let accessResolvedPlatformPolicy = false;
    if (deps.automaticUserAiAccess || deps.aiAccess) {
      let aiAccess: UserAiAccessPolicyRecord | null;
      try {
        if (deps.automaticUserAiAccess) {
          const resolved = await deps.automaticUserAiAccess.resolveUserAiAccess(session.user.id);
          aiAccess = resolved.aiAccess;
          if (resolved.platformPolicy) {
            res.locals.gatewayPlatformModelPolicy = resolved.platformPolicy;
            accessResolvedPlatformPolicy = true;
          }
        } else {
          aiAccess = await deps.aiAccess!.getUserAiAccess(session.user.id);
        }
      } catch (error) {
        if (error instanceof AutomaticUserAiAccessInfrastructureError) {
          res.status(error.status).json({ error: error.code });
          return;
        }
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

    if (!accessResolvedPlatformPolicy) {
      try {
        res.locals.gatewayPlatformModelPolicy = await deps.modelPolicy.getPolicy();
      } catch (error) {
        console.error("gateway_platform_model_policy_lookup_failed", error);
        res.status(502).json({ error: "gateway_platform_model_policy_lookup_failed" });
        return;
      }
    }
    if (!res.locals.gatewayPlatformModelPolicy) {
      res.status(503).json({ error: "gateway_platform_model_policy_unavailable" });
      return;
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

function readRequestedOrganizationId(req: Request): string | null {
  return req.header(VESLO_ORG_ID_HEADER)?.trim()
    || req.header(VESLO_DEN_ORG_ID_HEADER)?.trim()
    || null;
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
