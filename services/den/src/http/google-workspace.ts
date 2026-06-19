import express from "express"

import { GoogleWorkspaceConnectors, getGoogleWorkspaceConnector } from "../google-workspace/connectors.js"
import type { GoogleWorkspaceOAuthClient } from "../google-workspace/oauth.js"
import type { GoogleWorkspaceConnectionStore } from "../google-workspace/store.js"
import {
  createSignedGoogleWorkspaceRuntimeToken,
  createSignedGoogleWorkspaceOAuthState,
  verifySignedGoogleWorkspaceRuntimeToken,
  verifySignedGoogleWorkspaceOAuthState,
} from "../google-workspace/state.js"
import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"

type GoogleWorkspaceAuthorize = typeof requireOrganizationAccess

export type GoogleWorkspaceRouterOptions = {
  authorize?: GoogleWorkspaceAuthorize
  oauth: GoogleWorkspaceOAuthClient
  store: GoogleWorkspaceConnectionStore
  stateSecret: string
  redirectUri?: string | null
  successRedirectUrl: string
  now?: () => number
  runtimeTokenTtlMs?: number
  fetchImpl?: typeof fetch
}

export function createGoogleWorkspaceRouter(options: GoogleWorkspaceRouterOptions) {
  const authorize = options.authorize ?? requireOrganizationAccess
  const router = express.Router()

  router.get("/orgs/:orgId/integrations/google/:connectorId/oauth/start", asyncRoute(async (req, res) => {
    const connector = getGoogleWorkspaceConnector(req.params.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_google_workspace_connector" })
      return
    }

    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })
    if (!context) {
      return
    }

    const redirectUri = options.redirectUri?.trim() || `${resolvePublicBaseUrl(req)}/v1/integrations/google/oauth/callback`
    const state = createSignedGoogleWorkspaceOAuthState({
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
    })

    res.json({
      authorizeUrl: authorization.authorizeUrl,
      state,
      connectorId: connector.id,
      scopes: connector.scopes,
    })
  }))

  router.post("/orgs/:orgId/integrations/google/:connectorId/runtime-token", asyncRoute(async (req, res) => {
    const connector = getGoogleWorkspaceConnector(req.params.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_google_workspace_connector" })
      return
    }

    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })
    if (!context) {
      return
    }

    const token = createSignedGoogleWorkspaceRuntimeToken({
      orgId: context.organization.id,
      userId: context.session.user.id,
      connectorId: connector.id,
      secret: options.stateSecret,
      ttlMs: options.runtimeTokenTtlMs,
      now: options.now,
    })

    const decoded = verifySignedGoogleWorkspaceRuntimeToken(token, {
      secret: options.stateSecret,
      now: options.now,
    })

    res.json({
      token,
      connectorId: connector.id,
      expiresAt: decoded ? new Date(decoded.expiresAt).toISOString() : null,
    })
  }))

  router.get("/integrations/google/oauth/callback", asyncRoute(async (req, res) => {
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
      res.status(400).json({ error: "google_workspace_oauth_callback_invalid" })
      return
    }

    const verified = verifySignedGoogleWorkspaceOAuthState(stateValue, {
      secret: options.stateSecret,
      now: options.now,
    })
    if (!verified) {
      res.status(400).json({ error: "google_workspace_oauth_state_invalid" })
      return
    }

    const connector = getGoogleWorkspaceConnector(verified.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_google_workspace_connector" })
      return
    }

    const grant = await options.oauth.exchangeCode({
      code,
      redirectUri: verified.redirectUri,
      connectorId: connector.id,
      scopes: connector.scopes,
    })

    await options.store.upsertConnection({
      orgId: verified.orgId,
      userId: verified.userId,
      connectorId: connector.id,
      scopes: connector.scopes,
      grant,
    })

    res.redirect(buildRedirectUrl(options.successRedirectUrl, {
      status: "connected",
      provider: "google",
      connectorId: connector.id,
    }))
  }))

  router.get("/orgs/:orgId/integrations/google/connections", asyncRoute(async (req, res) => {
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
    })
    const byConnector = new Map(connections.map((connection) => [connection.connectorId, connection]))

    res.json({
      items: GoogleWorkspaceConnectors.map((connector) => {
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

  router.delete("/orgs/:orgId/integrations/google/:connectorId/connection", asyncRoute(async (req, res) => {
    const connector = getGoogleWorkspaceConnector(req.params.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_google_workspace_connector" })
      return
    }

    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })
    if (!context) {
      return
    }

    const grant = await options.store.getGrant({
      orgId: context.organization.id,
      userId: context.session.user.id,
      connectorId: connector.id,
    })
    let revokeOk: boolean | null = grant?.refreshToken ? true : null
    if (grant?.refreshToken) {
      await options.oauth.revokeToken(grant.refreshToken).catch((error) => {
        revokeOk = false
        const message = error instanceof Error ? error.message : String(error)
        console.warn("[google-workspace] revoke token failed", {
          connectorId: connector.id,
          orgId: context.organization.id,
          userId: context.session.user.id,
          error: message,
        })
      })
    }

    await options.store.disconnectConnection({
      orgId: context.organization.id,
      userId: context.session.user.id,
      connectorId: connector.id,
    })

    res.json({ ok: true, connectorId: connector.id, revokeOk })
  }))

  router.all("/orgs/:orgId/integrations/google/:connectorId/mcp", asyncRoute(async (req, res) => {
    const connector = getGoogleWorkspaceConnector(req.params.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_google_workspace_connector" })
      return
    }

    const runtimeToken = req.get("x-veslo-connector-token")?.trim() || ""
    const verified = verifySignedGoogleWorkspaceRuntimeToken(runtimeToken, {
      secret: options.stateSecret,
      now: options.now,
    })
    if (
      !verified ||
      verified.orgId !== req.params.orgId ||
      verified.connectorId !== connector.id
    ) {
      res.status(401).json({ error: "google_workspace_runtime_token_invalid" })
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
    })
    if (!grant?.accessToken) {
      res.status(401).json({ error: "google_workspace_connection_required", connectorId: connector.id })
      return
    }

    const upstreamUrl = new URL(connector.mcpUrl)
    const requestUrl = new URL(req.originalUrl, "http://localhost")
    upstreamUrl.search = requestUrl.search

    const upstreamResponse = await (options.fetchImpl ?? fetch)(upstreamUrl.toString(), {
      method: req.method,
      headers: buildGoogleMcpProxyHeaders(req, grant.accessToken),
      body: shouldForwardBody(req.method) ? serializeProxyBody(req.body) : undefined,
    })

    res.status(upstreamResponse.status)
    upstreamResponse.headers.forEach((value, key) => {
      if (!isHopByHopHeader(key)) {
        res.setHeader(key, value)
      }
    })
    const body = Buffer.from(await upstreamResponse.arrayBuffer())
    res.send(body)
  }))

  return router
}

async function resolveUsableGrant(input: {
  store: GoogleWorkspaceConnectionStore
  oauth: GoogleWorkspaceOAuthClient
  orgId: string
  userId: string
  connectorId: "google-gmail" | "google-calendar" | "google-drive"
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

function buildGoogleMcpProxyHeaders(req: express.Request, accessToken: string) {
  const headers = new Headers()
  const accept = req.get("accept")
  const contentType = req.get("content-type")
  if (accept) {
    headers.set("accept", accept)
  }
  if (contentType) {
    headers.set("content-type", contentType)
  }
  headers.set("authorization", `Bearer ${accessToken}`)
  return headers
}

function shouldForwardBody(method: string) {
  const normalized = method.toUpperCase()
  return normalized !== "GET" && normalized !== "HEAD"
}

function serializeProxyBody(body: unknown): BodyInit | undefined {
  if (body === undefined) {
    return undefined
  }
  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body)
  }
  if (typeof body === "string") {
    return body
  }
  return JSON.stringify(body ?? {})
}

function isHopByHopHeader(name: string) {
  return [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "content-encoding",
  ].includes(name.toLowerCase())
}

function firstQueryValue(value: unknown) {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : null
  }
  return typeof value === "string" ? value : null
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
