import express from "express"
import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"

type GoogleConnectorDefinition = {
  id: "google-gmail" | "google-calendar" | "google-drive"
  name: string
  description: string
  scopes: string[]
}

const GOOGLE_MCP_CONNECTORS: GoogleConnectorDefinition[] = [
  {
    id: "google-gmail",
    name: "Google Gmail",
    description: "Search Gmail threads and create draft email through Google MCP.",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "List calendars, inspect availability, and manage events through Google MCP.",
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Find and work with Google Drive files through Google MCP.",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
  },
]

function resolvePublicBaseUrl(req: express.Request) {
  const configured = process.env.GOOGLE_WORKSPACE_CONNECTOR_BASE_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    ""
  if (configured) {
    return configured.replace(/\/+$/, "")
  }
  return `${req.protocol}://${req.get("host") || "api.veslo.work"}`.replace(/\/+$/, "")
}

function buildGoogleMcpConnectors(input: { baseUrl: string; orgId: string }) {
  const orgPath = `/v1/orgs/${encodeURIComponent(input.orgId)}`
  return GOOGLE_MCP_CONNECTORS.map((connector) => ({
    id: connector.id,
    name: connector.name,
    description: connector.description,
    config: {
      type: "remote",
      url: `${input.baseUrl}${orgPath}/integrations/google/${connector.id}/mcp`,
      oauth: false,
      headers: {
        "X-Veslo-Connector": connector.id,
      },
    },
    authorization: {
      type: "veslo-server-oauth",
      provider: "google",
      connectorId: connector.id,
      scopes: connector.scopes,
      startPath: `${orgPath}/integrations/google/${connector.id}/oauth/start`,
      runtimeTokenPath: `${orgPath}/integrations/google/${connector.id}/runtime-token`,
      statusPath: `${orgPath}/integrations/google/connections`,
      disconnectPath: `${orgPath}/integrations/google/${connector.id}/connection`,
    },
    source: { scope: "platform" },
    provider: { id: "google", group: "Google" },
  }))
}

export type OrgMcpCatalogAuthorize = typeof requireOrganizationAccess

export type OrgMcpCatalogRouterOptions = {
  authorize?: OrgMcpCatalogAuthorize
  connectorBaseUrl?: string
}

export function createOrgMcpCatalogRouter(options: OrgMcpCatalogRouterOptions = {}) {
  const authorize = options.authorize ?? requireOrganizationAccess
  const connectorBaseUrl = options.connectorBaseUrl?.trim().replace(/\/+$/, "") || null
  const router = express.Router()

  router.get("/:orgId/mcp/catalog", asyncRoute(async (req, res) => {
    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })

    if (!context) {
      return
    }

    res.json({
      items: buildGoogleMcpConnectors({
        baseUrl: connectorBaseUrl ?? resolvePublicBaseUrl(req),
        orgId: req.params.orgId,
      }),
    })
  }))

  return router
}

export const orgMcpCatalogRouter = createOrgMcpCatalogRouter()
