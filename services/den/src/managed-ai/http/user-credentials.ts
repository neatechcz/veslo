import { Router } from "express"

import type { AiAccessProvider, AiAccessRepository } from "../access/repository.js"
import { readBearerToken, type UserSession, type UserSessionResolver } from "../auth/user-session.js"

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver
  aiAccess?: AiAccessRepository
  modelPolicy?: {
    getPolicy(): Promise<{
      activeModel: { provider: AiAccessProvider; model: string }
    } | null>
  }
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
    const aiAccess = await deps.aiAccess?.getUserAiAccess(session.user.id)

    if (!aiAccess) {
      res.json({ aiAccess: null })
      return
    }

    let modelPolicy
    try {
      modelPolicy = await deps.modelPolicy?.getPolicy()
    } catch (error) {
      console.error("platform_model_policy_lookup_failed", error)
      res.status(502).json({ error: "platform_model_policy_lookup_failed" })
      return
    }
    const effectiveProvider = modelPolicy?.activeModel.provider?.trim() ?? ""
    const effectiveModel = modelPolicy?.activeModel.model?.trim() ?? ""
    if (!modelPolicy || !effectiveProvider || !effectiveModel) {
      res.status(503).json({ error: "platform_model_policy_not_configured" })
      return
    }

    res.json({
      aiAccess: {
        id: aiAccess.id,
        userId: aiAccess.userId,
        enabled: aiAccess.enabled,
        provider: aiAccess.provider,
        credentialId: aiAccess.credentialId,
        effectiveModel: {
          provider: effectiveProvider,
          model: effectiveModel,
        },
        updatedAt: toIsoString(aiAccess.updatedAt),
      },
    })
  })

  return router
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value
}
