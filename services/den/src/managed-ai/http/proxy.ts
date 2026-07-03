import { Router } from "express"

import type { OrganizationBillingEntitlement } from "../../billing/organization-billing.js"
import type { OrganizationBillingRepository } from "../../billing/repository.js"
import { pickActiveOrganization } from "../../http/access.js"
import {
  findUserOrganization,
  readRequestedOrganizationId,
  resolveActiveUserOrganizations,
  type OrganizationSummary,
} from "../../http/org-auth.js"
import type { AiAccessRepository } from "../access/repository.js"
import type { AutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js"
import { readBearerToken } from "../auth/user-session.js"
import type { GatewaySessionResolver } from "../auth/gateway-session.js"
import type { CredentialRepository } from "../credentials/repository.js"
import type { SecretStore } from "../credentials/secret-store.js"
import type { TokenBroker } from "../credentials/token-broker.js"
import type { LeaseBroker } from "../leases/lease-broker.js"
import type {
  AnthropicProviderTransport,
  CodexOAuthProviderTransport,
  OpenAiCompatibleProviderTransport,
  OpenAiProviderTransport,
} from "../providers/transport.js"
import type { UsageRepository } from "../usage/repository.js"
import { createAnthropicProxyRouter } from "./providers/anthropic.js"
import { createCodexOAuthProxyRouter } from "./providers/codex-oauth.js"
import { createOpenAiCompatibleProxyRouter } from "./providers/openai-compatible.js"
import { createOpenAiProxyRouter } from "./providers/openai.js"

export type ProxyDependencies = {
  aiAccess?: AiAccessRepository
  autoAssignedCodexCredentialRotation?: AutoAssignedCodexCredentialRotationService
  gatewaySessions: GatewaySessionResolver
  organizationAccess?: {
    listUserOrganizations(userId: string): Promise<OrganizationSummary[]>
    findUserOrganization?(userId: string, orgId: string): Promise<OrganizationSummary | null>
  }
  organizationBilling?: Pick<OrganizationBillingRepository, "deriveEntitlement">
  credentials: CredentialRepository
  secrets: SecretStore
  usageRepository: UsageRepository
  leaseBroker: LeaseBroker
  tokenBroker: TokenBroker
  openAiTransport: OpenAiProviderTransport
  anthropicTransport: AnthropicProviderTransport
  codexOAuthTransport: CodexOAuthProviderTransport
  openAiCompatibleTransport: OpenAiCompatibleProviderTransport
}

const defaultOrganizationAccess = {
  listUserOrganizations: resolveActiveUserOrganizations,
  findUserOrganization,
}

export function createProxyRouter(deps: ProxyDependencies) {
  const router = Router()

  router.use("/providers", async (req, res, next) => {
    const token = readBearerToken(req.header("authorization"))
    if (!token) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const session = await deps.gatewaySessions.resolveSession(token)
    if (!session) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    res.locals.gatewaySession = session

    if (deps.organizationBilling) {
      const organizationAccess = deps.organizationAccess ?? defaultOrganizationAccess
      const requestedOrgId = readRequestedOrganizationId(req)
      const listedOrganizations = await organizationAccess.listUserOrganizations(session.user.id)
      if (requestedOrgId) {
        const requestedOrganization = listedOrganizations.find((organization) => organization.id === requestedOrgId)
          ?? await organizationAccess.findUserOrganization?.(session.user.id, requestedOrgId)
          ?? null
        if (requestedOrganization && requestedOrganization.status !== undefined && requestedOrganization.status !== "active") {
          res.status(403).json({ error: "organization_forbidden" })
          return
        }
      }
      const activeOrganizations = listedOrganizations
        .filter((organization) => organization.status === undefined || organization.status === "active")
      const picked = pickActiveOrganization(activeOrganizations, requestedOrgId)

      if (!picked.ok) {
        res.status(picked.status).json({ error: picked.error })
        return
      }

      const entitlement = await deps.organizationBilling.deriveEntitlement(picked.organization.id)
      res.locals.gatewayOrganization = picked.organization
      res.locals.gatewayBillingEntitlement = entitlement

      if (!entitlement.canUseManagedAi) {
        res.status(402).json(buildPaymentRequiredResponse(picked.organization.id, entitlement))
        return
      }
    }

    if (deps.aiAccess) {
      const aiAccess = await deps.aiAccess.getUserAiAccess(session.user.id)
      if (!aiAccess?.enabled) {
        res.status(403).json({ error: "ai_access_not_configured" })
        return
      }
      res.locals.gatewayAiAccess = aiAccess
    }
    next()
  })

  router.use("/providers/openai", createOpenAiProxyRouter(deps))
  router.use("/providers/anthropic", createAnthropicProxyRouter(deps))
  router.use("/providers/codex_oauth", createCodexOAuthProxyRouter(deps))
  router.use("/providers/openai_compatible", createOpenAiCompatibleProxyRouter(deps))

  return router
}

function buildPaymentRequiredResponse(orgId: string, entitlement: OrganizationBillingEntitlement) {
  return {
    error: "payment_required",
    message: "Managed AI billing access is required for this organization.",
    reason: entitlement.managedAiBlockingReason ?? "payment_required",
    orgId,
    entitlement: {
      effectiveMode: entitlement.effectiveMode,
      status: entitlement.status,
      canUseManagedAi: entitlement.canUseManagedAi,
      canUseByokOrLocalProvider: entitlement.canUseByokOrLocalProvider,
      canReadHistory: entitlement.canReadHistory,
      managedAiBlockingReason: entitlement.managedAiBlockingReason,
      byokOrLocalProviderBlockingReason: entitlement.byokOrLocalProviderBlockingReason,
    },
  }
}
