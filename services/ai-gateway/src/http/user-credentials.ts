import { type NextFunction, type Request, type Response, Router } from "express";

import type { AiAccessRepository } from "../access/repository.js";
import { readBearerToken, type UserSession, type UserSessionResolver } from "../auth/user-session.js";

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver;
  aiAccess?: AiAccessRepository;
};

export function createUserCredentialsRouter(deps: UserCredentialDependencies) {
  const router = Router();

  const requireUserSession = async (req: Request, res: Response, next: NextFunction) => {
    const token = readBearerToken(req.header("authorization"));
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const session = await deps.sessionResolver.resolveSession(token);
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    res.locals.userSession = session;
    next();
  };

  const getMyAiAccess = async (_req: Request, res: Response) => {
    const session = res.locals.userSession as UserSession;
    const aiAccess = await deps.aiAccess?.getUserAiAccess(session.user.id);

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
  };

  router.use("/api", requireUserSession);
  router.get("/api/me/ai-access", getMyAiAccess);
  router.get("/ai-gateway/me/ai-access", requireUserSession, getMyAiAccess);

  return router;
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}
