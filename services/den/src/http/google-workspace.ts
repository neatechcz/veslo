import express from "express"

import { GoogleWorkspaceConnectors, getGoogleWorkspaceConnector } from "../google-workspace/connectors.js"
import {
  downloadGmailAttachment,
  GoogleGmailAttachmentError,
} from "../google-workspace/gmail-attachments.js"
import type { GoogleWorkspaceOAuthClient } from "../google-workspace/oauth.js"
import type { GoogleWorkspaceConnectionStore } from "../google-workspace/store.js"
import {
  createSignedGoogleWorkspaceAttachmentToken,
  createSignedGoogleWorkspaceRuntimeToken,
  createSignedGoogleWorkspaceOAuthState,
  verifySignedGoogleWorkspaceAttachmentToken,
  verifySignedGoogleWorkspaceRuntimeToken,
  verifySignedGoogleWorkspaceOAuthState,
} from "../google-workspace/state.js"
import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"

type GoogleWorkspaceAuthorize = typeof requireOrganizationAccess

const GMAIL_ATTACHMENT_TOOL_NAME = "download_attachment"
const GMAIL_ATTACHMENT_DOWNLOAD_PATH = "/v1/integrations/google/gmail/attachment-download"

const GMAIL_ATTACHMENT_TOOL = {
  name: GMAIL_ATTACHMENT_TOOL_NAME,
  description: [
    "Download the original bytes of one Gmail message attachment.",
    "Call get_message or get_thread first to obtain the message id and attachment metadata.",
    "Then use the returned short-lived downloadUrl with a shell or HTTP downloader to save the file into the current workspace.",
    "Do not ask the user to re-upload the attachment when this tool is available.",
  ].join(" "),
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Download Gmail attachment",
  },
  inputSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", description: "Gmail message id containing the attachment." },
      attachmentId: { type: "string", description: "Attachment id returned by Gmail message metadata." },
      filename: { type: "string", description: "Original attachment filename returned by Gmail." },
      mimeType: { type: "string", description: "Attachment MIME type returned by Gmail." },
    },
    required: ["messageId", "attachmentId", "filename", "mimeType"],
  },
}

export type GoogleWorkspaceRouterOptions = {
  authorize?: GoogleWorkspaceAuthorize
  oauth: GoogleWorkspaceOAuthClient
  store: GoogleWorkspaceConnectionStore
  stateSecret: string
  redirectUri?: string | null
  successRedirectUrl: string
  now?: () => number
  runtimeTokenTtlMs?: number
  attachmentDownloadTtlMs?: number
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

  router.get("/integrations/google/gmail/attachment-download", asyncRoute(async (req, res) => {
    res.setHeader("cache-control", "private, no-store")
    res.setHeader("content-security-policy", "sandbox; default-src 'none'; base-uri 'none'")
    res.setHeader("referrer-policy", "no-referrer")
    res.setHeader("x-content-type-options", "nosniff")

    const token = firstQueryValue(req.query.token)?.trim() || ""
    const verified = verifySignedGoogleWorkspaceAttachmentToken(token, {
      secret: options.stateSecret,
      now: options.now,
    })
    if (!verified) {
      res.status(401).json({ error: "google_gmail_attachment_token_invalid" })
      return
    }

    const connector = getGoogleWorkspaceConnector(verified.connectorId)
    if (!connector) {
      res.status(400).json({ error: "unknown_google_workspace_connector" })
      return
    }
    const grant = await resolveUsableGrant({
      store: options.store,
      oauth: options.oauth,
      orgId: verified.orgId,
      userId: verified.userId,
      connectorId: verified.connectorId,
      scopes: connector.scopes,
      now: options.now,
    })
    if (!grant?.accessToken) {
      res.status(401).json({ error: "google_workspace_connection_required", connectorId: connector.id })
      return
    }

    try {
      const attachment = await downloadGmailAttachment({
        accessToken: grant.accessToken,
        messageId: verified.messageId,
        attachmentId: verified.attachmentId,
        fetchImpl: options.fetchImpl,
      })
      res.setHeader("content-type", safeAttachmentContentType(verified.mimeType))
      res.setHeader("content-disposition", contentDispositionAttachment(verified.filename))
      res.setHeader("content-length", String(attachment.size))
      res.send(Buffer.from(attachment.bytes))
    } catch (error) {
      if (error instanceof GoogleGmailAttachmentError) {
        res.status(error.status).json({
          error: error.code,
          ...(error.maxBytes === null ? {} : { maxBytes: error.maxBytes }),
        })
        return
      }
      throw error
    }
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

    const mcpRequest = parseMcpRequest(req.body)
    if (
      connector.id === "google-gmail" &&
      mcpRequest?.method === "tools/call" &&
      mcpToolName(mcpRequest.params) === GMAIL_ATTACHMENT_TOOL_NAME
    ) {
      const args = gmailAttachmentToolArguments(mcpRequest.params)
      if (!args.ok) {
        res.json(jsonRpcError(mcpRequest.id, -32602, "invalid_params", { invalid: args.invalid }))
        return
      }

      const issuedAt = options.now?.() ?? Date.now()
      const ttlMs = options.attachmentDownloadTtlMs ?? 5 * 60 * 1000
      const token = createSignedGoogleWorkspaceAttachmentToken({
        orgId: verified.orgId,
        userId: verified.userId,
        messageId: args.value.messageId,
        attachmentId: args.value.attachmentId,
        filename: args.value.filename,
        mimeType: args.value.mimeType,
        secret: options.stateSecret,
        ttlMs,
        now: () => issuedAt,
      })
      const download = {
        downloadUrl: buildRedirectUrl(`${resolvePublicBaseUrl(req)}${GMAIL_ATTACHMENT_DOWNLOAD_PATH}`, { token }),
        filename: args.value.filename,
        mimeType: args.value.mimeType,
        expiresAt: new Date(issuedAt + ttlMs).toISOString(),
      }
      res.json(jsonRpcResult(mcpRequest.id, {
        content: [{
          type: "text",
          text: `Use the downloadUrl to save ${args.value.filename} into the current workspace. The URL expires at ${download.expiresAt}.`,
        }],
        structuredContent: download,
      }))
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

    const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer())
    const toolListResponse = upstreamResponse.ok && connector.id === "google-gmail" && mcpRequest?.method === "tools/list"
      ? augmentGmailToolsList(upstreamBody)
      : { body: upstreamBody, augmented: false }
    res.status(upstreamResponse.status)
    upstreamResponse.headers.forEach((value, key) => {
      if (
        !isHopByHopHeader(key) &&
        !(toolListResponse.augmented && isRepresentationMetadataHeader(key))
      ) {
        res.setHeader(key, value)
      }
    })
    res.send(toolListResponse.body)
  }))

  return router
}

type JsonRpcId = string | number | null

type McpRequest = {
  jsonrpc: "2.0"
  method: string
  params: unknown
  id: JsonRpcId
}

type GmailAttachmentToolArguments = {
  messageId: string
  attachmentId: string
  filename: string
  mimeType: string
}

function parseMcpRequest(body: unknown): McpRequest | null {
  const request = asRecord(body)
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return null
  }
  return {
    jsonrpc: "2.0",
    method: request.method,
    params: request.params,
    id: jsonRpcId(request.id),
  }
}

function mcpToolName(params: unknown) {
  const payload = asRecord(params)
  return typeof payload?.name === "string" ? payload.name : ""
}

function gmailAttachmentToolArguments(params: unknown):
  | { ok: true; value: GmailAttachmentToolArguments }
  | { ok: false; invalid: keyof GmailAttachmentToolArguments } {
  const payload = asRecord(params)
  const args = asRecord(payload?.arguments)
  const limits: Record<keyof GmailAttachmentToolArguments, number> = {
    messageId: 512,
    attachmentId: 4096,
    filename: 512,
    mimeType: 255,
  }

  for (const field of ["messageId", "attachmentId", "filename", "mimeType"] as const) {
    const value = args?.[field]
    if (typeof value !== "string" || !value.trim() || value.length > limits[field]) {
      return { ok: false, invalid: field }
    }
  }

  return {
    ok: true,
    value: {
      messageId: args?.messageId as string,
      attachmentId: args?.attachmentId as string,
      filename: args?.filename as string,
      mimeType: args?.mimeType as string,
    },
  }
}

function augmentGmailToolsList(body: Buffer) {
  try {
    const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>
    const result = asRecord(payload.result)
    if (!result || !Array.isArray(result.tools)) {
      return { body, augmented: false }
    }
    const hasDownloadTool = result.tools.some((tool) => asRecord(tool)?.name === GMAIL_ATTACHMENT_TOOL_NAME)
    if (hasDownloadTool) {
      return { body, augmented: false }
    }
    result.tools = [...result.tools, GMAIL_ATTACHMENT_TOOL]
    return {
      body: Buffer.from(JSON.stringify(payload), "utf8"),
      augmented: true,
    }
  } catch {
    return { body, augmented: false }
  }
}

function isRepresentationMetadataHeader(name: string) {
  return [
    "content-digest",
    "content-encoding",
    "content-length",
    "content-md5",
    "digest",
    "etag",
    "repr-digest",
  ].includes(name.toLowerCase())
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return {
    jsonrpc: "2.0" as const,
    result,
    id,
  }
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
    id,
  }
}

function jsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeAttachmentContentType(value: string) {
  const normalized = value.trim()
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : "application/octet-stream"
}

function contentDispositionAttachment(value: string) {
  const safeFilename = safeAttachmentFilename(value)
  const asciiFilename = safeFilename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
  if (asciiFilename === safeFilename) {
    return `attachment; filename="${asciiFilename}"`
  }
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
}

function safeAttachmentFilename(value: string) {
  const basename = value.replace(/\\/g, "/").split("/").at(-1) ?? ""
  const normalized = basename
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/"/g, "_")
    .trim()
  const truncated = Array.from(normalized).slice(0, 255).join("")
  return truncated && truncated !== "." && truncated !== ".."
    ? truncated
    : "gmail-attachment.bin"
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
