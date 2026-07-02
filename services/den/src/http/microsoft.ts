import express from "express"

import { MicrosoftConnectors, getMicrosoftConnector, type MicrosoftConnectorId } from "../microsoft/connectors.js"
import { MicrosoftGraphClient } from "../microsoft/graph.js"
import type { MicrosoftOAuthClient } from "../microsoft/oauth.js"
import { dispatchSharePointMcpRequest } from "../microsoft/sharepoint-mcp.js"
import type { MicrosoftConnectionStore } from "../microsoft/store.js"
import {
  createSignedMicrosoftOAuthState,
  createSignedMicrosoftRuntimeToken,
  verifySignedMicrosoftOAuthState,
  verifySignedMicrosoftRuntimeToken,
} from "../microsoft/state.js"
import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"

type MicrosoftAuthorize = typeof requireOrganizationAccess

export type MicrosoftRouterOptions = {
  authorize?: MicrosoftAuthorize
  oauth: MicrosoftOAuthClient
  store: MicrosoftConnectionStore
  stateSecret: string
  redirectUri?: string | null
  successRedirectUrl: string
  now?: () => number
  runtimeTokenTtlMs?: number
  fetchImpl?: typeof fetch
  microsoftGraphBaseUrl?: string
  microsoftGraphMaxContentBytes?: number
}

export function createMicrosoftRouter(options: MicrosoftRouterOptions) {
  const authorize = options.authorize ?? requireOrganizationAccess
  const router = express.Router()

  router.get("/orgs/:orgId/integrations/microsoft/:connectorId/oauth/start", asyncRoute(async (req, res) => {
    const connector = getMicrosoftConnector(req.params.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_microsoft_connector" })
      return
    }

    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })
    if (!context) {
      return
    }

    const redirectUri = options.redirectUri?.trim() || `${resolvePublicBaseUrl(req)}/v1/integrations/microsoft/oauth/callback`
    const state = createSignedMicrosoftOAuthState({
      orgId: context.organization.id,
      userId: context.session.user.id,
      connectorId: connector.id,
      redirectUri,
      secret: options.stateSecret,
      now: options.now,
    })
    const authorization = await options.oauth.startAuthorization({
      state,
      scopes: connector.scopes,
      redirectUri,
      connectorId: connector.id,
    }).catch((error) => {
      if (sendMicrosoftUnavailableError(res, error, connector.id)) {
        return null
      }
      throw error
    })
    if (!authorization) {
      return
    }

    res.json({
      authorizeUrl: authorization.authorizeUrl,
      state,
      connectorId: connector.id,
      scopes: connector.scopes,
    })
  }))

  router.post("/orgs/:orgId/integrations/microsoft/:connectorId/runtime-token", asyncRoute(async (req, res) => {
    const connector = getMicrosoftConnector(req.params.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_microsoft_connector" })
      return
    }

    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })
    if (!context) {
      return
    }

    const storeAvailable = await assertMicrosoftConnectionStoreAvailable({
      store: options.store,
      orgId: context.organization.id,
      userId: context.session.user.id,
      connectorId: connector.id,
    }).catch((error) => {
      if (sendMicrosoftUnavailableError(res, error, connector.id)) {
        return false
      }
      throw error
    })
    if (!storeAvailable) {
      return
    }

    const token = createSignedMicrosoftRuntimeToken({
      orgId: context.organization.id,
      userId: context.session.user.id,
      connectorId: connector.id,
      secret: options.stateSecret,
      ttlMs: options.runtimeTokenTtlMs,
      now: options.now,
    })

    const decoded = verifySignedMicrosoftRuntimeToken(token, {
      secret: options.stateSecret,
      now: options.now,
    })

    res.json({
      token,
      connectorId: connector.id,
      expiresAt: decoded ? new Date(decoded.expiresAt).toISOString() : null,
    })
  }))

  router.get("/integrations/microsoft/oauth/callback", asyncRoute(async (req, res) => {
    const stateValue = firstQueryValue(req.query.state)
    const code = firstQueryValue(req.query.code)
    const error = firstQueryValue(req.query.error)

    if (error) {
      res.redirect(buildRedirectUrl(options.successRedirectUrl, {
        status: "error",
        error,
      }))
      return
    }

    if (!stateValue || !code) {
      res.status(400).json({ error: "microsoft_oauth_callback_invalid" })
      return
    }

    const verified = verifySignedMicrosoftOAuthState(stateValue, {
      secret: options.stateSecret,
      now: options.now,
    })
    if (!verified) {
      res.status(400).json({ error: "microsoft_oauth_state_invalid" })
      return
    }

    const connector = getMicrosoftConnector(verified.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_microsoft_connector" })
      return
    }

    const grant = await options.oauth.exchangeCode({
      code,
      redirectUri: verified.redirectUri,
      connectorId: connector.id,
      scopes: connector.scopes,
    }).catch((error) => {
      if (sendMicrosoftUnavailableError(res, error, connector.id)) {
        return null
      }
      throw error
    })
    if (!grant) {
      return
    }

    await options.store.upsertConnection({
      orgId: verified.orgId,
      userId: verified.userId,
      connectorId: connector.id,
      scopes: connector.scopes,
      grant,
    }).catch((error) => {
      if (sendMicrosoftUnavailableError(res, error, connector.id)) {
        return null
      }
      throw error
    })
    if (res.headersSent) {
      return
    }

    res.redirect(buildRedirectUrl(options.successRedirectUrl, {
      status: "connected",
      provider: "microsoft",
      connectorId: connector.id,
    }))
  }))

  router.get("/orgs/:orgId/integrations/microsoft/connections", asyncRoute(async (req, res) => {
    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })
    if (!context) {
      return
    }

    const connections = await options.store.listConnections({
      orgId: context.organization.id,
      userId: context.session.user.id,
    }).catch((error) => {
      if (sendMicrosoftUnavailableError(res, error, defaultMicrosoftConnectorId())) {
        return null
      }
      throw error
    })
    if (!connections) {
      return
    }
    const byConnector = new Map(connections.map((connection) => [connection.connectorId, connection]))

    res.json({
      items: MicrosoftConnectors.map((connector) => {
        const connection = byConnector.get(connector.id)
        return {
          connectorId: connector.id,
          name: connector.name,
          connected: connection?.state === "connected",
          state: connection?.state ?? "disconnected",
          scopes: connector.scopes,
          connectedAt: connection?.connectedAt ?? null,
          revokedAt: connection?.revokedAt ?? null,
          accessTokenExpiresAt: connection?.accessTokenExpiresAt ?? null,
        }
      }),
    })
  }))

  router.delete("/orgs/:orgId/integrations/microsoft/:connectorId/connection", asyncRoute(async (req, res) => {
    const connector = getMicrosoftConnector(req.params.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_microsoft_connector" })
      return
    }

    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })
    if (!context) {
      return
    }

    await options.store.getGrant({
      orgId: context.organization.id,
      userId: context.session.user.id,
      connectorId: connector.id,
    }).catch((error) => {
      if (sendMicrosoftUnavailableError(res, error, connector.id)) {
        return null
      }
      throw error
    })
    if (res.headersSent) {
      return
    }
    const revokeOk: boolean | null = null

    await options.store.disconnectConnection({
      orgId: context.organization.id,
      userId: context.session.user.id,
      connectorId: connector.id,
    }).catch((error) => {
      if (sendMicrosoftUnavailableError(res, error, connector.id)) {
        return null
      }
      throw error
    })
    if (res.headersSent) {
      return
    }

    res.json({ ok: true, connectorId: connector.id, revokeOk })
  }))

  router.all("/orgs/:orgId/integrations/microsoft/:connectorId/mcp", asyncRoute(async (req, res) => {
    const connector = getMicrosoftConnector(req.params.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_microsoft_connector" })
      return
    }

    const runtimeToken = req.get("x-veslo-connector-token")?.trim() || ""
    const verified = verifySignedMicrosoftRuntimeToken(runtimeToken, {
      secret: options.stateSecret,
      now: options.now,
    })
    if (
      !verified ||
      verified.orgId !== req.params.orgId ||
      verified.connectorId !== connector.id
    ) {
      res.status(401).json({ error: "microsoft_runtime_token_invalid" })
      return
    }

    const grant = await resolveUsableGrant({
      store: options.store,
      oauth: options.oauth,
      orgId: verified.orgId,
      userId: verified.userId,
      connectorId: connector.id,
      scopes: connector.scopes,
      now: options.now,
    }).catch((error) => {
      if (sendMicrosoftUnavailableError(res, error, connector.id)) {
        return null
      }
      throw error
    })
    if (res.headersSent) {
      return
    }
    if (!grant?.accessToken) {
      res.status(401).json({ error: "microsoft_connection_required", connectorId: connector.id })
      return
    }

    const graph = new MicrosoftGraphClient({
      accessToken: grant.accessToken,
      baseUrl: options.microsoftGraphBaseUrl ?? connector.mcpUrl,
      fetchImpl: options.fetchImpl,
      maxContentBytes: options.microsoftGraphMaxContentBytes,
    })
    const response = await dispatchSharePointMcpRequest({
      graph,
      body: req.body,
    })

    res.json(response)
  }))

  return router
}

async function assertMicrosoftConnectionStoreAvailable(input: {
  store: MicrosoftConnectionStore
  orgId: string
  userId: string
  connectorId: MicrosoftConnectorId
}) {
  await input.store.getGrant({
    orgId: input.orgId,
    userId: input.userId,
    connectorId: input.connectorId,
  })
  return true
}

async function resolveUsableGrant(input: {
  store: MicrosoftConnectionStore
  oauth: MicrosoftOAuthClient
  orgId: string
  userId: string
  connectorId: MicrosoftConnectorId
  scopes: string[]
  now?: () => number
}) {
  const grant = await input.store.getGrant({
    orgId: input.orgId,
    userId: input.userId,
    connectorId: input.connectorId,
  })
  if (!grant) {
    return null
  }

  const expiresAt = Date.parse(grant.expiresAt)
  const now = input.now?.() ?? Date.now()
  if (Number.isFinite(expiresAt) && expiresAt - now > 60_000) {
    return grant
  }

  if (!grant.refreshToken) {
    return grant
  }

  const refreshed = await input.oauth.refreshToken({
    refreshToken: grant.refreshToken,
    connectorId: input.connectorId,
  })
  await input.store.upsertConnection({
    orgId: input.orgId,
    userId: input.userId,
    connectorId: input.connectorId,
    scopes: input.scopes,
    grant: refreshed,
  })
  return refreshed
}

function firstQueryValue(value: unknown) {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : null
  }
  return typeof value === "string" ? value : null
}

function sendMicrosoftUnavailableError(
  res: express.Response,
  error: unknown,
  connectorId?: MicrosoftConnectorId,
) {
  const errorCode = microsoftUnavailableErrorCode(error)
  if (!errorCode) {
    return false
  }

  res.status(503).json(connectorId
    ? { error: errorCode, connectorId }
    : { error: errorCode })
  return true
}

function microsoftUnavailableErrorCode(error: unknown) {
  if (!(error instanceof Error)) {
    return null
  }
  if (
    error.message === "microsoft_oauth_not_configured" ||
    error.message === "microsoft_token_secret_not_configured"
  ) {
    return error.message
  }
  return null
}

function defaultMicrosoftConnectorId() {
  return MicrosoftConnectors[0]?.id
}

function buildRedirectUrl(baseUrl: string, params: Record<string, string>) {
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function resolvePublicBaseUrl(req: express.Request) {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim()
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim()
  const proto = forwardedProto || req.protocol
  const host = forwardedHost || req.get("host") || "api.veslo.work"
  return `${proto}://${host}`.replace(/\/+$/, "")
}
