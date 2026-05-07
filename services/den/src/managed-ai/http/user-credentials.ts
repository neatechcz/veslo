import { Router } from "express"

import type { AutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js"
import type { AiAccessRepository } from "../access/repository.js"
import { readBearerToken, type UserSession, type UserSessionResolver } from "../auth/user-session.js"

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver
  aiAccess?: AiAccessRepository
  autoAssignedCodexCredentialRotation?: AutoAssignedCodexCredentialRotationService
}

export function createUserCredentialsRouter(deps: UserCredentialDependencies) {
  const router = Router()

  router.use("/api", async (req, res, next) => {
    const token = readBearerToken(req.header("authorization"))
    if (!token) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const session = await deps.sessionResolver.resolveSession(token)
    if (!session) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    res.locals.userSession = session
    next()
  })

  router.get("/api/me/ai-access", async (_req, res) => {
    const session = res.locals.userSession as UserSession
    let aiAccess = await deps.aiAccess?.getUserAiAccess(session.user.id)
    if (aiAccess?.provider === "codex_oauth" && deps.autoAssignedCodexCredentialRotation) {
      try {
        aiAccess = await deps.autoAssignedCodexCredentialRotation.repairCodexAccess({
          aiAccess,
          reason: "user_ai_access_read",
        })
      } catch (error) {
        console.error("managed_ai_user_codex_assignment_repair_failed", error)
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
    })
  })

  return router
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value
}
