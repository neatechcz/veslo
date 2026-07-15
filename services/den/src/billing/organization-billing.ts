export type OrganizationBillingMode = "none" | "managed_ai" | "local_models" | "manual_access"

export type OrganizationBillingStatus =
  | "none"
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"

export type BillingBlockingReason =
  | "payment_required"
  | "payment_failed"
  | "insufficient_licenses"
  | "tier_not_allowed"
  | "organization_access_disabled"

export type OrganizationBillingWarning = "payment_past_due"

export interface OrganizationBillingQuantities {
  managedAiBasic: number
  managedAiExtended: number
  localModels: number
}

export interface OrganizationManualAccess {
  enabled: boolean
  allowManagedAi: boolean
  unlimited?: boolean
  licenseLimit: number
}

export interface OrganizationBillingPolicy {
  allowByokWithoutPaidAccess: boolean
  organizationAccessEnabled?: boolean
  tierAllowed?: boolean
}

export interface OrganizationBillingEntitlementInput {
  mode: OrganizationBillingMode
  status: OrganizationBillingStatus
  grace: boolean
  manualAccess: OrganizationManualAccess | null
  quantities: OrganizationBillingQuantities
  activeUserCount: number
  policy: OrganizationBillingPolicy
}

export interface OrganizationBillingEntitlement {
  mode: OrganizationBillingMode
  effectiveMode: OrganizationBillingMode
  status: OrganizationBillingStatus
  canUseManagedAi: boolean
  canUseByokOrLocalProvider: boolean
  canReadHistory: boolean
  licenseLimit: number | null
  isUnlimited: boolean
  activeUserCount: number
  isInGracePeriod: boolean
  warning: OrganizationBillingWarning | null
  managedAiBlockingReason: BillingBlockingReason | null
  byokOrLocalProviderBlockingReason: BillingBlockingReason | null
}

export type RequestedLicenseLimitValidation =
  | { ok: true }
  | {
    ok: false
    error: {
      code: "requested_license_limit_below_active_users"
      requestedLicenseLimit: number
      activeUserCount: number
    }
  }

export interface RequestedLicenseLimitValidationInput {
  requestedLicenseLimit: number
  activeUserCount: number
}

export function deriveOrganizationBillingEntitlement(
  input: OrganizationBillingEntitlementInput,
): OrganizationBillingEntitlement {
  const activeUserCount = normalizeCount(input.activeUserCount)
  const manualAccess = input.manualAccess?.enabled === true ? input.manualAccess : null
  const effectiveMode: OrganizationBillingMode = manualAccess ? "manual_access" : nonManualBillingMode(input.mode)
  const isUnlimited = effectiveMode === "manual_access" && manualAccess?.unlimited === true
  const licenseLimit = deriveLicenseLimit(input, effectiveMode, manualAccess)
  const hasEnoughLicenses = isUnlimited || (licenseLimit !== null && licenseLimit >= activeUserCount)
  const organizationAccessEnabled = input.policy.organizationAccessEnabled ?? true
  const tierAllowed = input.policy.tierAllowed ?? true
  const isInGracePeriod = input.status === "past_due" && input.grace
  const hasPaidAccess = hasCurrentPaidAccess(input.status, input.grace)

  const managedAiBlockingReason = deriveManagedAiBlockingReason({
    status: input.status,
    effectiveMode,
    manualAccess,
    hasPaidAccess,
    hasEnoughLicenses,
    organizationAccessEnabled,
    tierAllowed,
  })
  const byokOrLocalProviderBlockingReason = deriveByokOrLocalProviderBlockingReason({
    status: input.status,
    effectiveMode,
    hasPaidAccess,
    hasEnoughLicenses,
    organizationAccessEnabled,
    tierAllowed,
    allowByokWithoutPaidAccess: input.policy.allowByokWithoutPaidAccess,
  })

  return {
    mode: input.mode,
    effectiveMode,
    status: input.status,
    canUseManagedAi: managedAiBlockingReason === null,
    canUseByokOrLocalProvider: byokOrLocalProviderBlockingReason === null,
    canReadHistory: organizationAccessEnabled,
    licenseLimit,
    isUnlimited,
    activeUserCount,
    isInGracePeriod,
    warning: isInGracePeriod ? "payment_past_due" : null,
    managedAiBlockingReason,
    byokOrLocalProviderBlockingReason,
  }
}

export function validateRequestedLicenseLimit(
  input: RequestedLicenseLimitValidationInput,
): RequestedLicenseLimitValidation {
  const requestedLicenseLimit = normalizeCount(input.requestedLicenseLimit)
  const activeUserCount = normalizeCount(input.activeUserCount)

  if (requestedLicenseLimit < activeUserCount) {
    return {
      ok: false,
      error: {
        code: "requested_license_limit_below_active_users",
        requestedLicenseLimit,
        activeUserCount,
      },
    }
  }

  return { ok: true }
}

function deriveLicenseLimit(
  input: OrganizationBillingEntitlementInput,
  effectiveMode: OrganizationBillingMode,
  manualAccess: OrganizationManualAccess | null,
) {
  if (effectiveMode === "manual_access" && manualAccess) {
    return manualAccess.unlimited === true ? null : normalizeCount(manualAccess.licenseLimit)
  }

  if (effectiveMode === "managed_ai") {
    return normalizeCount(input.quantities.managedAiBasic) + normalizeCount(input.quantities.managedAiExtended)
  }

  if (effectiveMode === "local_models") {
    return normalizeCount(input.quantities.localModels)
  }

  return 0
}

function deriveManagedAiBlockingReason(input: {
  status: OrganizationBillingStatus
  effectiveMode: OrganizationBillingMode
  manualAccess: OrganizationManualAccess | null
  hasPaidAccess: boolean
  hasEnoughLicenses: boolean
  organizationAccessEnabled: boolean
  tierAllowed: boolean
}): BillingBlockingReason | null {
  if (!input.organizationAccessEnabled) {
    return "organization_access_disabled"
  }

  if (input.effectiveMode === "manual_access") {
    if (input.manualAccess?.allowManagedAi !== true) {
      return "tier_not_allowed"
    }
    return input.hasEnoughLicenses ? null : "insufficient_licenses"
  }

  if (input.effectiveMode === "none") {
    return "payment_required"
  }

  if (!input.tierAllowed || input.effectiveMode === "local_models") {
    return "tier_not_allowed"
  }

  if (!input.hasPaidAccess) {
    return paymentBlockingReason(input.status)
  }

  return input.hasEnoughLicenses ? null : "insufficient_licenses"
}

function deriveByokOrLocalProviderBlockingReason(input: {
  status: OrganizationBillingStatus
  effectiveMode: OrganizationBillingMode
  hasPaidAccess: boolean
  hasEnoughLicenses: boolean
  organizationAccessEnabled: boolean
  tierAllowed: boolean
  allowByokWithoutPaidAccess: boolean
}): BillingBlockingReason | null {
  if (!input.organizationAccessEnabled) {
    return "organization_access_disabled"
  }

  if (input.effectiveMode === "manual_access") {
    return input.hasEnoughLicenses ? null : "insufficient_licenses"
  }

  if (input.effectiveMode === "none") {
    return "payment_required"
  }

  if (!input.tierAllowed) {
    return "tier_not_allowed"
  }

  if (input.effectiveMode !== "local_models" && !input.hasPaidAccess && !input.allowByokWithoutPaidAccess) {
    return paymentBlockingReason(input.status)
  }

  return input.hasEnoughLicenses ? null : "insufficient_licenses"
}

function hasCurrentPaidAccess(status: OrganizationBillingStatus, grace: boolean) {
  return status === "active" || status === "trialing" || (status === "past_due" && grace)
}

function paymentBlockingReason(status: OrganizationBillingStatus): BillingBlockingReason {
  return status === "past_due" || status === "unpaid" ? "payment_failed" : "payment_required"
}

function normalizeCount(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.trunc(value))
}

function nonManualBillingMode(mode: OrganizationBillingMode): OrganizationBillingMode {
  return mode === "manual_access" ? "none" : mode
}
