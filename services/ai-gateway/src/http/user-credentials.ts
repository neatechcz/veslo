import { type NextFunction, type Request, type Response, Router } from "express";

import type { AutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js";
import type { AiAccessRepository } from "../access/repository.js";
import { readBearerToken, type UserSession, type UserSessionResolver } from "../auth/user-session.js";
import { asyncHandler, jsonErrorHandler } from "./async-handler.js";

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver;
  aiAccess?: AiAccessRepository;
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

  const getMyAiAccess = asyncHandler(async (_req: Request, res: Response) => {
    const session = res.locals.userSession as UserSession;
    let aiAccess = await deps.aiAccess?.getUserAiAccess(session.user.id);
    if (aiAccess?.provider === "codex_oauth" && deps.autoAssignedCodexCredentialRotation) {
      try {
        aiAccess = await deps.autoAssignedCodexCredentialRotation.repairCodexAccess({
          aiAccess,
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
            defaultModel: aiAccess.defaultModel,
            allowedModels: aiAccess.allowedModels,
            updatedAt: toIsoString(aiAccess.updatedAt),
          }
        : null,
    });
  });

  router.use("/api", requireUserSession);
  router.get("/api/me/ai-access", getMyAiAccess);
  router.get("/ai-gateway/me/ai-access", requireUserSession, getMyAiAccess);
  router.use(jsonErrorHandler("user_credentials_request_failed"));

  return router;
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}
