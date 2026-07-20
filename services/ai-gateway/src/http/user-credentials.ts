import { type NextFunction, type Request, type Response, Router } from "express";

import type { AiAccessRepository, UserAiAccessPolicyRecord } from "../access/repository.js";
import { resolveAuthorizedModelRoster } from "../access/authorized-model-roster.js";
import { readBearerToken, type UserSession, type UserSessionResolver } from "../auth/user-session.js";
import type { PlatformModelPolicyRepository, PlatformModelRef } from "../model-policy/repository.js";
import { resolveGatewayModelCapabilityDescriptor } from "../providers/model-capability-registry.js";
import { asyncHandler, jsonErrorHandler } from "./async-handler.js";

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver;
  aiAccess?: AiAccessRepository;
  modelPolicy?: PlatformModelPolicyRepository;
};

export function createUserCredentialsRouter(deps: UserCredentialDependencies) {
  const router = Router();

  const requireUserSession = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const token = readBearerToken(req.header("authorization"));
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    let session: UserSession | null;
    try {
      session = await deps.sessionResolver.resolveSession(token);
    } catch (error) {
      console.error("user_session_lookup_failed", error);
      res.status(502).json({ error: "user_session_lookup_failed" });
      return;
    }
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    res.locals.userSession = session;
    next();
  });

  const requireMatchingRouteUser = (req: Request, res: Response, next: NextFunction) => {
    const session = res.locals.userSession as UserSession;
    const requestedUserId = typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    if (!requestedUserId || requestedUserId !== session.user.id) {
      res.status(403).json({ error: "user_identity_mismatch" });
      return;
    }
    next();
  };

  const getUserAiAccess = asyncHandler(async (_req: Request, res: Response) => {
    const session = res.locals.userSession as UserSession;
    let aiAccess = await deps.aiAccess?.getUserAiAccess(session.user.id);
    if (!aiAccess) {
      res.json({ aiAccess: null });
      return;
    }
    const platformPolicy = await deps.modelPolicy?.getPolicy();
    const allowedModels = resolveAuthorizedModelRoster({ aiAccess, platformPolicy });
    const effectiveModel = toEffectiveModel(aiAccess.provider, aiAccess.defaultModel);

    res.json({
      aiAccess: aiAccess
        ? {
            id: aiAccess.id,
            userId: aiAccess.userId,
            enabled: aiAccess.enabled,
            provider: aiAccess.provider,
            credentialId: aiAccess.credentialId,
            defaultModel: aiAccess.defaultModel,
            allowedModels,
            selectableModels: selectableModelsForAccess(aiAccess.provider, allowedModels),
            effectiveModel,
            updatedAt: toIsoString(aiAccess.updatedAt),
          }
        : null,
    });
  });

  router.use("/api", requireUserSession);
  router.get("/api/me/ai-access", getUserAiAccess);
  router.get("/api/users/:userId/ai-access", requireMatchingRouteUser, getUserAiAccess);
  router.get("/ai-gateway/me/ai-access", requireUserSession, getUserAiAccess);
  router.get(
    "/ai-gateway/users/:userId/ai-access",
    requireUserSession,
    requireMatchingRouteUser,
    getUserAiAccess,
  );
  router.use(jsonErrorHandler("user_credentials_request_failed"));

  return router;
}

function selectableModelsForAccess(
  provider: UserAiAccessPolicyRecord["provider"],
  allowedModels: string[],
) {
  if (!provider) return [];
  return allowedModels.map((model) => resolveGatewayModelCapabilityDescriptor({ provider, model }));
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function toEffectiveModel(provider: string | null, model: string | null): PlatformModelRef | null {
  if (
    (provider === "openai" || provider === "anthropic" || provider === "codex_oauth" || provider === "openai_compatible")
    && model?.trim()
  ) {
    return { provider, model: model.trim() };
  }
  return null;
}
