import assert from "node:assert/strict"
import test from "node:test"
import {
  deriveOrganizationBillingEntitlement,
  validateRequestedLicenseLimit,
} from "../src/billing/organization-billing.js"

test("active managed-ai billing allows managed inference and sums seats", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "managed_ai",
    status: "active",
    grace: false,
    manualAccess: null,
    quantities: { managedAiBasic: 3, managedAiExtended: 2, localModels: 0 },
    activeUserCount: 5,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(entitlement.canUseManagedAi, true)
  assert.equal(entitlement.canUseByokOrLocalProvider, true)
  assert.equal(entitlement.canReadHistory, true)
  assert.equal(entitlement.licenseLimit, 5)
  assert.equal(entitlement.activeUserCount, 5)
  assert.equal(entitlement.managedAiBlockingReason, null)
  assert.equal(entitlement.byokOrLocalProviderBlockingReason, null)
  assert.equal(entitlement.warning, null)
})

test("unpaid managed-ai billing blocks managed inference but keeps history readable", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "managed_ai",
    status: "unpaid",
    grace: false,
    manualAccess: null,
    quantities: { managedAiBasic: 1, managedAiExtended: 0, localModels: 0 },
    activeUserCount: 1,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(entitlement.canUseManagedAi, false)
  assert.equal(entitlement.canUseByokOrLocalProvider, false)
  assert.equal(entitlement.canReadHistory, true)
  assert.equal(entitlement.managedAiBlockingReason, "payment_failed")
  assert.equal(entitlement.byokOrLocalProviderBlockingReason, "payment_failed")
})

test("past-due managed-ai billing in grace still allows managed inference with warning", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "managed_ai",
    status: "past_due",
    grace: true,
    manualAccess: null,
    quantities: { managedAiBasic: 2, managedAiExtended: 0, localModels: 0 },
    activeUserCount: 2,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(entitlement.canUseManagedAi, true)
  assert.equal(entitlement.canReadHistory, true)
  assert.equal(entitlement.isInGracePeriod, true)
  assert.equal(entitlement.warning, "payment_past_due")
  assert.equal(entitlement.managedAiBlockingReason, null)
  assert.equal(entitlement.byokOrLocalProviderBlockingReason, null)
})

test("manual access overrides absent Stripe billing", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "none",
    status: "none",
    grace: false,
    manualAccess: {
      enabled: true,
      allowManagedAi: true,
      licenseLimit: 4,
    },
    quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
    activeUserCount: 4,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(entitlement.effectiveMode, "manual_access")
  assert.equal(entitlement.canUseManagedAi, true)
  assert.equal(entitlement.canUseByokOrLocalProvider, true)
  assert.equal(entitlement.licenseLimit, 4)
  assert.equal(entitlement.managedAiBlockingReason, null)
  assert.equal(entitlement.byokOrLocalProviderBlockingReason, null)
})

test("manual-access mode without an enabled manual grant behaves like no billing access", () => {
  const withoutGrant = deriveOrganizationBillingEntitlement({
    mode: "manual_access",
    status: "none",
    grace: false,
    manualAccess: null,
    quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
    activeUserCount: 1,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  const disabledGrant = deriveOrganizationBillingEntitlement({
    mode: "manual_access",
    status: "none",
    grace: false,
    manualAccess: {
      enabled: false,
      allowManagedAi: true,
      licenseLimit: 1,
    },
    quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
    activeUserCount: 1,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(withoutGrant.effectiveMode, "none")
  assert.equal(withoutGrant.canUseManagedAi, false)
  assert.equal(withoutGrant.canUseByokOrLocalProvider, false)
  assert.equal(withoutGrant.licenseLimit, 0)
  assert.equal(withoutGrant.managedAiBlockingReason, "payment_required")
  assert.equal(withoutGrant.byokOrLocalProviderBlockingReason, "payment_required")

  assert.equal(disabledGrant.effectiveMode, "none")
  assert.equal(disabledGrant.canUseManagedAi, false)
  assert.equal(disabledGrant.canUseByokOrLocalProvider, false)
  assert.equal(disabledGrant.licenseLimit, 0)
  assert.equal(disabledGrant.managedAiBlockingReason, "payment_required")
  assert.equal(disabledGrant.byokOrLocalProviderBlockingReason, "payment_required")
})

test("disabled or absent manual access blocks even with active raw status and zero active users", () => {
  for (const manualAccess of [
    null,
    { enabled: false, allowManagedAi: true, licenseLimit: 1 },
  ]) {
    const entitlement = deriveOrganizationBillingEntitlement({
      mode: "manual_access",
      status: "active",
      grace: false,
      manualAccess,
      quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
      activeUserCount: 0,
      policy: {
        allowByokWithoutPaidAccess: false,
        organizationAccessEnabled: true,
        tierAllowed: true,
      },
    })

    assert.equal(entitlement.effectiveMode, "none")
    assert.equal(entitlement.canUseManagedAi, false)
    assert.equal(entitlement.canUseByokOrLocalProvider, false)
    assert.equal(entitlement.managedAiBlockingReason, "payment_required")
    assert.equal(entitlement.byokOrLocalProviderBlockingReason, "payment_required")
  }
})

test("local models enforces seat count but does not grant Veslo-managed AI usage", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "local_models",
    status: "active",
    grace: false,
    manualAccess: null,
    quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 2 },
    activeUserCount: 3,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(entitlement.canUseManagedAi, false)
  assert.equal(entitlement.canUseByokOrLocalProvider, false)
  assert.equal(entitlement.licenseLimit, 2)
  assert.equal(entitlement.managedAiBlockingReason, "tier_not_allowed")
  assert.equal(entitlement.byokOrLocalProviderBlockingReason, "insufficient_licenses")
})

test("local models with enough licenses allows BYOK or local provider but blocks Veslo-managed AI", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "local_models",
    status: "active",
    grace: false,
    manualAccess: null,
    quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 3 },
    activeUserCount: 3,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(entitlement.canUseManagedAi, false)
  assert.equal(entitlement.canUseByokOrLocalProvider, true)
  assert.equal(entitlement.licenseLimit, 3)
  assert.equal(entitlement.managedAiBlockingReason, "tier_not_allowed")
  assert.equal(entitlement.byokOrLocalProviderBlockingReason, null)
})

test("local models payment failure states still allow BYOK or local provider with enough licenses", () => {
  for (const status of ["unpaid", "canceled", "incomplete"] as const) {
    const entitlement = deriveOrganizationBillingEntitlement({
      mode: "local_models",
      status,
      grace: false,
      manualAccess: null,
      quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 3 },
      activeUserCount: 3,
      policy: {
        allowByokWithoutPaidAccess: false,
        organizationAccessEnabled: true,
        tierAllowed: true,
      },
    })

    assert.equal(entitlement.canUseManagedAi, false, status)
    assert.equal(entitlement.canUseByokOrLocalProvider, true, status)
    assert.equal(entitlement.licenseLimit, 3, status)
    assert.equal(entitlement.managedAiBlockingReason, "tier_not_allowed", status)
    assert.equal(entitlement.byokOrLocalProviderBlockingReason, null, status)
  }
})

test("unpaid organization allows BYOK or local provider only when policy enables it", () => {
  const enabled = deriveOrganizationBillingEntitlement({
    mode: "managed_ai",
    status: "unpaid",
    grace: false,
    manualAccess: null,
    quantities: { managedAiBasic: 2, managedAiExtended: 0, localModels: 0 },
    activeUserCount: 2,
    policy: {
      allowByokWithoutPaidAccess: true,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  const disabled = deriveOrganizationBillingEntitlement({
    mode: "managed_ai",
    status: "unpaid",
    grace: false,
    manualAccess: null,
    quantities: { managedAiBasic: 2, managedAiExtended: 0, localModels: 0 },
    activeUserCount: 2,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(enabled.canUseManagedAi, false)
  assert.equal(enabled.canUseByokOrLocalProvider, true)
  assert.equal(enabled.byokOrLocalProviderBlockingReason, null)
  assert.equal(disabled.canUseByokOrLocalProvider, false)
  assert.equal(disabled.byokOrLocalProviderBlockingReason, "payment_failed")
})

test("payment blocking reasons distinguish failed payments from missing payment", () => {
  const cases = [
    { mode: "managed_ai", status: "unpaid", reason: "payment_failed" },
    { mode: "managed_ai", status: "past_due", reason: "payment_failed" },
    { mode: "managed_ai", status: "incomplete", reason: "payment_required" },
    { mode: "managed_ai", status: "canceled", reason: "payment_required" },
    { mode: "none", status: "none", reason: "payment_required" },
  ] as const

  for (const { mode, status, reason } of cases) {
    const entitlement = deriveOrganizationBillingEntitlement({
      mode,
      status,
      grace: false,
      manualAccess: null,
      quantities: { managedAiBasic: 1, managedAiExtended: 0, localModels: 0 },
      activeUserCount: 1,
      policy: {
        allowByokWithoutPaidAccess: false,
        organizationAccessEnabled: true,
        tierAllowed: true,
      },
    })

    assert.equal(entitlement.managedAiBlockingReason, reason, `${mode}:${status}`)
    assert.equal(entitlement.byokOrLocalProviderBlockingReason, reason, `${mode}:${status}`)
  }
})

test("entitlement exposes scoped blocking reasons instead of an aggregate blocking reason", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "local_models",
    status: "active",
    grace: false,
    manualAccess: null,
    quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 1 },
    activeUserCount: 1,
    policy: {
      allowByokWithoutPaidAccess: false,
      organizationAccessEnabled: true,
      tierAllowed: true,
    },
  })

  assert.equal(Object.prototype.hasOwnProperty.call(entitlement, "blockingReason"), false)
  assert.equal(entitlement.managedAiBlockingReason, "tier_not_allowed")
  assert.equal(entitlement.byokOrLocalProviderBlockingReason, null)
})

test("requested license count below active users returns a stable validation error", () => {
  const validation = validateRequestedLicenseLimit({
    requestedLicenseLimit: 2,
    activeUserCount: 3,
  })

  assert.deepEqual(validation, {
    ok: false,
    error: {
      code: "requested_license_limit_below_active_users",
      requestedLicenseLimit: 2,
      activeUserCount: 3,
    },
  })
})

test("requested license validation normalizes fractional, negative, and non-finite counts", () => {
  const cases = [
    {
      input: { requestedLicenseLimit: 2.9, activeUserCount: 3.1 },
      expected: {
        ok: false,
        error: {
          code: "requested_license_limit_below_active_users",
          requestedLicenseLimit: 2,
          activeUserCount: 3,
        },
      },
    },
    {
      input: { requestedLicenseLimit: -1, activeUserCount: 1 },
      expected: {
        ok: false,
        error: {
          code: "requested_license_limit_below_active_users",
          requestedLicenseLimit: 0,
          activeUserCount: 1,
        },
      },
    },
    {
      input: { requestedLicenseLimit: Number.POSITIVE_INFINITY, activeUserCount: 1 },
      expected: {
        ok: false,
        error: {
          code: "requested_license_limit_below_active_users",
          requestedLicenseLimit: 0,
          activeUserCount: 1,
        },
      },
    },
    {
      input: { requestedLicenseLimit: 0, activeUserCount: Number.NaN },
      expected: { ok: true },
    },
  ] as const

  for (const { input, expected } of cases) {
    assert.deepEqual(validateRequestedLicenseLimit(input), expected)
  }
})
