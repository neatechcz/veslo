import { type NextFunction, type Request, type Response, Router } from "express";

import type { AutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js";
import type { AiAccessRepository } from "../access/repository.js";
import { readBearerToken, type UserSession, type UserSessionResolver } from "../auth/user-session.js";
import type { PlatformModelPolicyRepository } from "../model-policy/repository.js";
import { asyncHandler, jsonErrorHandler } from "./async-handler.js";

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver;
  aiAccess?: AiAccessRepository;
  modelPolicy?: Pick<PlatformModelPolicyRepository, "getPolicy">;
  autoAssignedCodexCredentialRotation?: AutoAssignedCodexCredentialRotationService;
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

    let modelPolicy;
    try {
      modelPolicy = await deps.modelPolicy?.getPolicy();
    } catch (error) {
      console.error("platform_model_policy_lookup_failed", error);
      res.status(502).json({ error: "platform_model_policy_lookup_failed" });
      return;
    }
    if (!modelPolicy) {
      res.status(503).json({ error: "platform_model_policy_not_configured" });
      return;
    }

    if (aiAccess?.provider === "codex_oauth" && deps.autoAssignedCodexCredentialRotation) {
      try {
        aiAccess = await deps.autoAssignedCodexCredentialRotation.repairCodexAccess({
          aiAccess,
          activeModel: modelPolicy.activeModel,
          reason: "user_ai_access_read",
        });
      } catch (error) {
        console.error("user_codex_assignment_repair_failed", error);
      }
    }

    res.json({
      aiAccess: aiAccess
        ? {
            id: aiAccess.id,
            userId: aiAccess.userId,
            enabled: aiAccess.enabled,
            provider: aiAccess.provider,
            credentialId: aiAccess.credentialId,
            effectiveModel: modelPolicy.activeModel,
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

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}
