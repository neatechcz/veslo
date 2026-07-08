import type { OrgRole, OrganizationMembershipStatus } from "../db/schema.js"

export type CurrentOrgRole = (typeof OrgRole)[number]
type LegacyOrgRole = "owner"
export type CompatibleOrgRole = CurrentOrgRole | LegacyOrgRole

export type OrganizationAccessSummary = {
  id: string
  name: string
  slug: string
  ownerUserId: string
  membershipId: string
  role: CompatibleOrgRole
  status?: (typeof OrganizationMembershipStatus)[number]
}

type ActiveOrganizationResult =
  | {
      ok: true
      organization: OrganizationAccessSummary
    }
  | {
      ok: false
      error: "organization_required" | "org_context_required" | "organization_forbidden"
      status: 400 | 403 | 404
    }

export function isOrganizationAdminRole(role: CompatibleOrgRole | null | undefined) {
  return role === "organization_admin" || role === "owner"
}

export function toCurrentOrgRole(role: CompatibleOrgRole): CurrentOrgRole {
  return isOrganizationAdminRole(role) ? "organization_admin" : "member"
}

export function hasRequiredOrgRole(actual: CompatibleOrgRole, required: CompatibleOrgRole) {
  if (isOrganizationAdminRole(actual)) {
    return true
  }

  return required === "member"
}

export function pickActiveOrganization(
  organizations: OrganizationAccessSummary[],
  requestedOrgId: string | null,
): ActiveOrganizationResult {
  const activeOrganizations = organizations.filter((entry) => entry.status === undefined || entry.status === "active")

  if (requestedOrgId) {
    const organization = activeOrganizations.find((entry) => entry.id === requestedOrgId)
    if (!organization) {
      return {
        ok: false,
        error: "organization_forbidden",
        status: 403,
      }
    }

    return {
      ok: true,
      organization,
    }
  }

  if (activeOrganizations.length === 0) {
    return {
      ok: false,
      error: "organization_required",
      status: 404,
    }
  }

  if (activeOrganizations.length === 1) {
    return {
      ok: true,
      organization: activeOrganizations[0],
    }
  }

  return {
    ok: false,
    error: "org_context_required",
    status: 400,
  }
}

export function canDeleteWorker(input: {
  actorUserId: string
  actorRole: CompatibleOrgRole | null
  createdByUserId: string | null
  isPlatformAdmin: boolean
}) {
  if (input.isPlatformAdmin) {
    return true
  }

  if (isOrganizationAdminRole(input.actorRole)) {
    return true
  }

  return input.createdByUserId === input.actorUserId
}

export function canRevealWorkerHostToken(input: {
  actorUserId: string
  actorRole: CompatibleOrgRole | null
  createdByUserId: string | null
  isPlatformAdmin: boolean
}) {
  return canDeleteWorker(input)
}

export function wouldLeaveOrganizationWithoutOwner(input: {
  ownerCount: number
  targetRole: CompatibleOrgRole
  nextRole: CompatibleOrgRole | null
}) {
  void input
  return false
}
