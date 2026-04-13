import express from "express"
import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"

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

    res.json({ items: [] })
  }))

  return router
}

export const orgMcpCatalogRouter = createOrgMcpCatalogRouter()
