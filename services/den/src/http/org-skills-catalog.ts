import express from "express"
import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"

export type OrgSkillsCatalogAuthorize = typeof requireOrganizationAccess

export type OrgSkillsCatalogRouterOptions = {
  authorize?: OrgSkillsCatalogAuthorize
}

export function createOrgSkillsCatalogRouter(options: OrgSkillsCatalogRouterOptions = {}) {
  const authorize = options.authorize ?? requireOrganizationAccess
  const router = express.Router()

  router.get("/:orgId/skills/catalog", asyncRoute(async (req, res) => {
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

export const orgSkillsCatalogRouter = createOrgSkillsCatalogRouter()
