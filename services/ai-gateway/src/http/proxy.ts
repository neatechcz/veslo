import { Router, type Request } from "express";

import type { AiAccessRepository } from "../access/repository.js";
import { readBearerToken } from "../auth/user-session.js";
import type { GatewaySessionResolver } from "../auth/gateway-session.js";
import type { CredentialRepository } from "../credentials/repository.js";
import type { SecretStore } from "../credentials/secret-store.js";
import type { TokenBroker } from "../credentials/token-broker.js";
import type { LeaseBroker } from "../leases/lease-broker.js";
import type { AnthropicProviderTransport, CodexOAuthProviderTransport, OpenAiProviderTransport } from "../providers/transport.js";
import type { UsageRepository } from "../usage/repository.js";
import { createAnthropicProxyRouter } from "./providers/anthropic.js";
import { createCodexOAuthProxyRouter } from "./providers/codex-oauth.js";
import { createOpenAiProxyRouter } from "./providers/openai.js";

export type ProxyDependencies = {
  aiAccess?: AiAccessRepository;
  gatewaySessions: GatewaySessionResolver;
  credentials: CredentialRepository;
  secrets: SecretStore;
  usageRepository: UsageRepository;
  leaseBroker: LeaseBroker;
  tokenBroker: TokenBroker;
  openAiTransport: OpenAiProviderTransport;
  anthropicTransport: AnthropicProviderTransport;
  codexOAuthTransport: CodexOAuthProviderTransport;
};

export function createProxyRouter(deps: ProxyDependencies) {
  const router = Router();
  router.use("/providers", async (req, res, next) => {
    const token = readGatewayAccessToken(req);
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const session = await deps.gatewaySessions.resolveSession(token);
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    res.locals.gatewaySession = session;
    if (deps.aiAccess) {
      const aiAccess = await deps.aiAccess.getUserAiAccess(session.user.id);
      if (!aiAccess?.enabled) {
        res.status(403).json({ error: "ai_access_not_configured" });
        return;
      }
      res.locals.gatewayAiAccess = aiAccess;
    }
    next();
  });

  router.use("/providers/openai", createOpenAiProxyRouter(deps));
  router.use("/providers/anthropic", createAnthropicProxyRouter(deps));
  router.use("/providers/codex_oauth", createCodexOAuthProxyRouter(deps));

  return router;
}

function readGatewayAccessToken(req: Request) {
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
