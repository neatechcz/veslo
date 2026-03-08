import type { OrgRole } from "../db/schema.js"

export type OrganizationAccessSummary = {
  id: string
  name: string
  slug: string
  ownerUserId: string
  membershipId: string
  role: (typeof OrgRole)[number]
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

export function hasRequiredOrgRole(actual: (typeof OrgRole)[number], required: (typeof OrgRole)[number]) {
  if (actual === "owner") {
    return true
  }

  return required === "member"
}

export function pickActiveOrganization(
  organizations: OrganizationAccessSummary[],
  requestedOrgId: string | null,
): ActiveOrganizationResult {
  if (organizations.length === 0) {
    return {
      ok: false,
      error: "organization_required",
      status: 404,
    }
  }

  if (requestedOrgId) {
    const organization = organizations.find((entry) => entry.id === requestedOrgId)
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

  if (organizations.length === 1) {
    return {
      ok: true,
      organization: organizations[0],
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
  actorRole: (typeof OrgRole)[number] | null
  createdByUserId: string | null
  isPlatformAdmin: boolean
}) {
  if (input.isPlatformAdmin) {
    return true
  }

  if (input.actorRole === "owner") {
    return true
  }

  return input.createdByUserId === input.actorUserId
}

export function wouldLeaveOrganizationWithoutOwner(input: {
  ownerCount: number
  targetRole: (typeof OrgRole)[number]
  nextRole: (typeof OrgRole)[number] | null
}) {
  if (input.targetRole !== "owner") {
    return false
  }

  if (input.nextRole === "owner") {
    return false
  }

  return input.ownerCount <= 1
}
