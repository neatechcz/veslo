import express, { Router } from "express"

import type { OrganizationBillingEntitlement } from "../billing/organization-billing.js"
import { asyncRoute } from "./errors.js"
import { pickActiveOrganization } from "./access.js"
import type { OrganizationSummary } from "./org-auth.js"
import type { SessionContext } from "./session.js"

export type ManagedAiRuntimeEntitlementDependencies = {
  requireSession(req: express.Request, res: express.Response): Promise<SessionContext | null>
  listOrganizations(session: SessionContext): Promise<OrganizationSummary[]>
  readRequestedOrganizationId(req: express.Request): string | null
  deriveEntitlement(orgId: string): Promise<Pick<OrganizationBillingEntitlement, "canUseManagedAi">>
}

export function createManagedAiRuntimeEntitlementRouter(
  deps: ManagedAiRuntimeEntitlementDependencies,
) {
  const router = Router()

  router.get("/v1/managed-ai/entitlement", asyncRoute(async (req, res) => {
    try {
      const session = await deps.requireSession(req, res)
      if (!session) return

      const organizations = await deps.listOrganizations(session)
      const requestedOrgId = deps.readRequestedOrganizationId(req)
      const picked = pickActiveOrganization(organizations, requestedOrgId)
      if (!picked.ok) {
        res.status(picked.status).json({ error: picked.error })
        return
      }

      const entitlement = await deps.deriveEntitlement(picked.organization.id)
      res.json({
        orgId: picked.organization.id,
        canUseManagedAi: entitlement.canUseManagedAi === true,
      })
    } catch {
      console.error("managed_ai_entitlement_lookup_failed")
      res.status(503).json({ error: "managed_ai_entitlement_unavailable" })
    }
  }))

  return router
}
