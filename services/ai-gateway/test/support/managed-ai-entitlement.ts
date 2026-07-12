import type { ManagedAiEntitlementResolver } from "../../src/billing/den-managed-ai-entitlement-resolver.js"

export const allowManagedAiEntitlement: ManagedAiEntitlementResolver = {
  async resolve(input) {
    return {
      orgId: input.requestedOrgId ?? "org_test",
      canUseManagedAi: true,
    }
  },
}
