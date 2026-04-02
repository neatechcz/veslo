import { Router } from "express"

import { readBearerToken, type UserSession, type UserSessionResolver } from "../auth/user-session.js"
import type { OpenAiOAuthClient } from "../credentials/openai-oauth.js"
import type { CredentialRecord, CredentialRepository } from "../credentials/repository.js"
import type { SecretStore } from "../credentials/secret-store.js"

export type UserCredentialMetadata = {
  id: string
  provider: string
  credentialType: CredentialRecord["credentialType"]
  state: CredentialRecord["state"]
  createdAt: string
  updatedAt: string
  lastFailureAt: string | null
}

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver
  openAiOAuth: OpenAiOAuthClient
  credentials: CredentialRepository
  secrets: SecretStore
}

export function createUserCredentialsRouter(deps: UserCredentialDependencies) {
  const router = Router()

  router.use("/api/providers", async (req, res, next) => {
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

  router.post("/api/providers/openai/oauth/start", async (_req, res) => {
    const session = res.locals.userSession as UserSession
    const payload = await deps.openAiOAuth.startAuthorization({ userId: session.user.id })
    res.json(payload)
  })

  router.post("/api/providers/openai/oauth/callback", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : ""
    if (!code) {
      res.status(400).json({ error: "invalid_oauth_callback" })
      return
    }

    const session = res.locals.userSession as UserSession
    const credentials = getUserCredentialWriteRepository(deps.credentials)
    const secret = await deps.openAiOAuth.exchangeCode({
      code,
      userId: session.user.id,
    })
    const stored = await deps.secrets.put({
      kind: "openai_oauth",
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
      expiresAt: secret.expiresAt,
    })
    const record = await credentials.createUserCredential({
      ownerUserId: session.user.id,
      provider: "openai",
      credentialType: "oauth",
      secretRef: stored.secretRef,
    })

    res.json({ credential: toUserCredentialMetadata(record) })
  })

  router.post("/api/providers/anthropic/api-keys", async (req, res) => {
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : ""
    if (!apiKey) {
      res.status(400).json({ error: "invalid_api_key" })
      return
    }

    const session = res.locals.userSession as UserSession
    const credentials = getUserCredentialWriteRepository(deps.credentials)
    const stored = await deps.secrets.put({
      kind: "api_key",
      apiKey,
    })
    const record = await credentials.createUserCredential({
      ownerUserId: session.user.id,
      provider: "anthropic",
      credentialType: "api_key",
      secretRef: stored.secretRef,
    })

    res.json({ credential: toUserCredentialMetadata(record) })
  })

  router.get("/api/providers/:provider/credentials", async (req, res) => {
    const provider = parseProvider(req.params.provider)
    if (!provider) {
      res.status(400).json({ error: "invalid_provider" })
      return
    }

    const session = res.locals.userSession as UserSession
    const credentials = getUserCredentialListRepository(deps.credentials)
    const records = await credentials.listUserCredentials({
      ownerUserId: session.user.id,
      provider,
    })

    res.json({
      credentials: records.map(toUserCredentialMetadata),
    })
  })

  router.delete("/api/providers/:provider/credentials/:credentialId", async (req, res) => {
    const provider = parseProvider(req.params.provider)
    const credentialId = typeof req.params.credentialId === "string" ? req.params.credentialId.trim() : ""
    if (!provider || !credentialId) {
      res.status(400).json({ error: "invalid_provider" })
      return
    }

    const session = res.locals.userSession as UserSession
    const credentials = getUserCredentialRevokeRepository(deps.credentials)
    const record = await credentials.revokeUserCredential({
      ownerUserId: session.user.id,
      provider,
      credentialId,
    })

    if (!record) {
      res.status(404).json({ error: "credential_not_found" })
      return
    }

    res.json({ credential: toUserCredentialMetadata(record) })
  })

  return router
}

function parseProvider(value: string | undefined) {
  return value === "openai" || value === "anthropic" ? value : null
}

function toUserCredentialMetadata(record: CredentialRecord): UserCredentialMetadata {
  return {
    id: record.id,
    provider: record.provider,
    credentialType: record.credentialType,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    lastFailureAt: record.lastFailureAt instanceof Date ? record.lastFailureAt.toISOString() : null,
  }
}

function getUserCredentialWriteRepository(credentials: CredentialRepository) {
  if (!credentials.createUserCredential) {
    throw new Error("create_user_credential_not_supported")
  }

  return {
    createUserCredential: credentials.createUserCredential.bind(credentials),
  }
}

function getUserCredentialListRepository(credentials: CredentialRepository) {
  if (!credentials.listUserCredentials) {
    throw new Error("list_user_credentials_not_supported")
  }

  return {
    listUserCredentials: credentials.listUserCredentials.bind(credentials),
  }
}

function getUserCredentialRevokeRepository(credentials: CredentialRepository) {
  if (!credentials.revokeUserCredential) {
    throw new Error("revoke_user_credential_not_supported")
  }

  return {
    revokeUserCredential: credentials.revokeUserCredential.bind(credentials),
  }
}
