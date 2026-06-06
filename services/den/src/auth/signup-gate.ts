import type {
  OrganizationAdminInviteRecord,
  OrganizationAdminMembershipRecord,
  OrganizationAdminResolvedDomain,
} from "../org-admin/repository.js"
import { OrganizationAdminRepositoryError } from "../org-admin/repository.js"
import { normalizeInviteEmail } from "../org-admin/policy.js"
import type { OrgRole } from "../db/schema.js"

export type SignupGateDomain = {
  organizationId: string
  selfSignupEnabled: boolean
}

export type SignupAccessInput = {
  matchingDomain: SignupGateDomain | null
  activeSeats: number
  seatLimit: number | null
  hasValidInvite: boolean
}

export type SignupAccessDecision =
  | { ok: true; mode: "domain"; organizationId: string }
  | { ok: true; mode: "invite" }
  | { ok: false; error: "domain_not_allowed" | "seat_limit_reached" }

export function decideSignupAccess(input: SignupAccessInput): SignupAccessDecision {
  if (input.matchingDomain?.selfSignupEnabled) {
    if (input.seatLimit !== null && input.activeSeats >= input.seatLimit) {
      return { ok: false, error: "seat_limit_reached" }
    }
    return {
      ok: true,
      mode: "domain",
      organizationId: input.matchingDomain.organizationId,
    }
  }

  if (input.hasValidInvite) {
    return { ok: true, mode: "invite" }
  }

  return { ok: false, error: "domain_not_allowed" }
}

export type EmailSignupAccessDependencies = {
  resolveEnabledOrganizationDomainForEmail(email: string): Promise<OrganizationAdminResolvedDomain>
  countActiveOrganizationSeats(orgId: string): Promise<number>
  resolveValidOrganizationInviteForSignup(input: {
    email: string
    tokenHash: string
  }): Promise<OrganizationAdminInviteRecord>
}

export type EmailSignupAccessInput = {
  email: string
  inviteToken: string | null
  dependencies: EmailSignupAccessDependencies
}

export async function resolveEmailSignupAccess(input: EmailSignupAccessInput): Promise<SignupAccessDecision> {
  const email = normalizeInviteEmail(input.email)
  if (!email) {
    return { ok: false, error: "domain_not_allowed" }
  }

  const matchingDomain = await resolveAllowedDomain(email, input.dependencies)
  if (matchingDomain) {
    const activeSeats = await input.dependencies.countActiveOrganizationSeats(matchingDomain.orgId)
    return decideSignupAccess({
      matchingDomain: {
        organizationId: matchingDomain.orgId,
        selfSignupEnabled: matchingDomain.selfSignupEnabled,
      },
      activeSeats,
      seatLimit: matchingDomain.organization.seatLimit,
      hasValidInvite: false,
    })
  }

  if (input.inviteToken) {
    try {
      await input.dependencies.resolveValidOrganizationInviteForSignup({
        email,
        tokenHash: input.inviteToken,
      })
      return decideSignupAccess({
        matchingDomain: null,
        activeSeats: 0,
        seatLimit: null,
        hasValidInvite: true,
      })
    } catch (error) {
      if (error instanceof OrganizationAdminRepositoryError) {
        return { ok: false, error: "domain_not_allowed" }
      }
      throw error
    }
  }

  return decideSignupAccess({
    matchingDomain: null,
    activeSeats: 0,
    seatLimit: null,
    hasValidInvite: false,
  })
}

export type CompleteSignupAfterUserCreateDependencies = {
  createMembershipId(): string
  resolveEnabledOrganizationDomainForEmail(email: string): Promise<OrganizationAdminResolvedDomain>
  createOrActivateOrganizationMembership(input: {
    membershipId: string
    orgId: string
    userId: string
    role: (typeof OrgRole)[number]
  }): Promise<OrganizationAdminMembershipRecord>
  acceptOrganizationInvite(input: {
    tokenHash: string
    userId: string
  }): Promise<{
    invite: OrganizationAdminInviteRecord
    membership: OrganizationAdminMembershipRecord
  }>
}

export type CompleteSignupAfterUserCreateInput = CompleteSignupAfterUserCreateDependencies & {
  user: {
    id: string
    email: string | null | undefined
  }
  inviteToken: string | null
}

export async function completeSignupAfterUserCreate(input: CompleteSignupAfterUserCreateInput) {
  if (input.inviteToken) {
    await input.acceptOrganizationInvite({
      tokenHash: input.inviteToken,
      userId: input.user.id,
    })
    return { activatedOrganizationMembership: true }
  }

  const email = normalizeInviteEmail(input.user.email)
  if (!email) {
    return { activatedOrganizationMembership: false }
  }

  const matchingDomain = await resolveAllowedDomain(email, input)
  if (!matchingDomain) {
    return { activatedOrganizationMembership: false }
  }

  await input.createOrActivateOrganizationMembership({
    membershipId: input.createMembershipId(),
    orgId: matchingDomain.orgId,
    userId: input.user.id,
    role: "member",
  })

  return { activatedOrganizationMembership: true }
}

async function resolveAllowedDomain(
  email: string,
  dependencies: Pick<EmailSignupAccessDependencies, "resolveEnabledOrganizationDomainForEmail">,
) {
  try {
    return await dependencies.resolveEnabledOrganizationDomainForEmail(email)
  } catch (error) {
    if (error instanceof OrganizationAdminRepositoryError && error.code === "domain_not_allowed") {
      return null
    }
    throw error
  }
}
