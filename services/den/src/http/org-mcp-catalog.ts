import express from "express"
import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"

const GOOGLE_MCP_OAUTH = {
  clientId: "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
  clientSecret: "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
}

const GOOGLE_MCP_CONNECTORS = [
  {
    id: "google-gmail",
    name: "Google Gmail",
    description: "Search Gmail threads and create draft email through Google MCP.",
    config: {
      type: "remote",
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      oauth: {
        ...GOOGLE_MCP_OAUTH,
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
      },
    },
    source: { scope: "platform" },
    provider: { id: "google", group: "Google" },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "List calendars, inspect availability, and manage events through Google MCP.",
    config: {
      type: "remote",
      url: "https://calendarmcp.googleapis.com/mcp/v1",
      oauth: {
        ...GOOGLE_MCP_OAUTH,
        scope: [
          "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          "https://www.googleapis.com/auth/calendar.events.freebusy",
          "https://www.googleapis.com/auth/calendar.events.readonly",
        ].join(" "),
      },
    },
    source: { scope: "platform" },
    provider: { id: "google", group: "Google" },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Find and work with Google Drive files through Google MCP.",
    config: {
      type: "remote",
      url: "https://drivemcp.googleapis.com/mcp/v1",
      oauth: {
        ...GOOGLE_MCP_OAUTH,
        scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
      },
    },
    source: { scope: "platform" },
    provider: { id: "google", group: "Google" },
  },
] as const

export type OrgMcpCatalogAuthorize = typeof requireOrganizationAccess

export type OrgMcpCatalogRouterOptions = {
  authorize?: OrgMcpCatalogAuthorize
}

export function createOrgMcpCatalogRouter(options: OrgMcpCatalogRouterOptions = {}) {
  const authorize = options.authorize ?? requireOrganizationAccess
  const router = express.Router()

  router.get("/:orgId/mcp/catalog", asyncRoute(async (req, res) => {
    const context = await authorize(req, res, {
      orgId: req.params.orgId,
      minimumRole: "member",
    })

    if (!context) {
      return
    }

    res.json({ items: GOOGLE_MCP_CONNECTORS })
  }))

  return router
}

export const orgMcpCatalogRouter = createOrgMcpCatalogRouter()
