import type {
  OrganizationAdminInviteRecord,
  OrganizationAdminMembershipRecord,
  OrganizationAdminResolvedDomain,
} from "../org-admin/repository.js"
import { OrganizationAdminRepositoryError } from "../org-admin/repository.js"
import { normalizeInviteEmail } from "../org-admin/policy.js"
import { hashOrganizationInviteToken } from "../org-admin/invite-token.js"
import type { OrgRole } from "../db/schema.js"

export type SignupAccessError = "domain_not_allowed" | "seat_limit_reached"

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
  | { ok: false; error: SignupAccessError }

export type ResolvedSignupAccessDecision =
  | { ok: true; mode: "domain"; organizationId: string; role: "member" }
  | { ok: true; mode: "invite"; organizationId: string; role: (typeof OrgRole)[number]; inviteToken: string }
  | { ok: false; error: SignupAccessError }

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
  assertCanActivateOrganizationSeat(orgId: string): Promise<void>
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

function inviteTokenLookupHashes(inviteToken: string) {
  const hashedToken = hashOrganizationInviteToken(inviteToken)
  return /^[0-9a-f]{64}$/i.test(inviteToken) ? [hashedToken] : [hashedToken, inviteToken]
}

function shouldTryLegacyRawInviteToken(error: unknown): error is OrganizationAdminRepositoryError {
  return error instanceof OrganizationAdminRepositoryError && error.code === "invite_not_found"
}

async function resolveSignupInviteWithTokenFallback(input: {
  dependencies: EmailSignupAccessDependencies
  email: string
  inviteToken: string
}) {
  let lastInviteNotFound: OrganizationAdminRepositoryError | null = null

  for (const tokenHash of inviteTokenLookupHashes(input.inviteToken)) {
    try {
      return await input.dependencies.resolveValidOrganizationInviteForSignup({
        email: input.email,
        tokenHash,
      })
    } catch (error) {
      if (!shouldTryLegacyRawInviteToken(error)) {
        throw error
      }
      lastInviteNotFound = error
    }
  }

  throw lastInviteNotFound ?? new OrganizationAdminRepositoryError("invite_not_found")
}

export async function resolveEmailSignupAccess(input: EmailSignupAccessInput): Promise<ResolvedSignupAccessDecision> {
  const email = normalizeInviteEmail(input.email)
  if (!email) {
    return { ok: false, error: "domain_not_allowed" }
  }

  const matchingDomain = await resolveAllowedDomain(email, input.dependencies)
  if (matchingDomain) {
    const activeSeats = await input.dependencies.countActiveOrganizationSeats(matchingDomain.orgId)
    const decision = decideSignupAccess({
      matchingDomain: {
        organizationId: matchingDomain.orgId,
        selfSignupEnabled: matchingDomain.selfSignupEnabled,
      },
      activeSeats,
      seatLimit: matchingDomain.organization.seatLimit,
      hasValidInvite: false,
    })
    if (!decision.ok) {
      return decision
    }
    if (decision.mode !== "domain") {
      return { ok: false, error: "domain_not_allowed" }
    }
    return {
      ok: true,
      mode: "domain",
      organizationId: decision.organizationId,
      role: "member",
    }
  }

  if (input.inviteToken) {
    try {
      const invite = await resolveSignupInviteWithTokenFallback({
        dependencies: input.dependencies,
        email,
        inviteToken: input.inviteToken,
      })
      await input.dependencies.assertCanActivateOrganizationSeat(invite.orgId)
      return {
        ok: true,
        mode: "invite",
        organizationId: invite.orgId,
        role: invite.role,
        inviteToken: input.inviteToken,
      }
    } catch (error) {
      if (error instanceof OrganizationAdminRepositoryError) {
        if (error.code === "seat_limit_reached") {
          return { ok: false, error: "seat_limit_reached" }
        }
        return { ok: false, error: "domain_not_allowed" }
      }
      throw error
    }
  }

  return { ok: false, error: "domain_not_allowed" }
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
    email: string
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

async function acceptSignupInviteWithTokenFallback(input: Pick<
  CompleteSignupAfterUserCreateDependencies,
  "acceptOrganizationInvite"
> & {
  inviteToken: string
  userId: string
  email: string
}) {
  let lastInviteNotFound: OrganizationAdminRepositoryError | null = null

  for (const tokenHash of inviteTokenLookupHashes(input.inviteToken)) {
    try {
      return await input.acceptOrganizationInvite({
        tokenHash,
        userId: input.userId,
        email: input.email,
      })
    } catch (error) {
      if (!shouldTryLegacyRawInviteToken(error)) {
        throw error
      }
      lastInviteNotFound = error
    }
  }

  throw lastInviteNotFound ?? new OrganizationAdminRepositoryError("invite_not_found")
}

export async function completeSignupAfterUserCreate(input: CompleteSignupAfterUserCreateInput) {
  const email = normalizeInviteEmail(input.user.email)
  if (!email) {
    return { activatedOrganizationMembership: false, createDefaultOrganization: false }
  }

  const matchingDomain = await resolveAllowedDomain(email, input)
  if (matchingDomain) {
    await input.createOrActivateOrganizationMembership({
      membershipId: input.createMembershipId(),
      orgId: matchingDomain.orgId,
      userId: input.user.id,
      role: "member",
    })

    return { activatedOrganizationMembership: true, createDefaultOrganization: false }
  }

  if (input.inviteToken) {
    await acceptSignupInviteWithTokenFallback({
      acceptOrganizationInvite: input.acceptOrganizationInvite,
      inviteToken: input.inviteToken,
      userId: input.user.id,
      email,
    })
    return { activatedOrganizationMembership: true, createDefaultOrganization: false }
  }

  return { activatedOrganizationMembership: false, createDefaultOrganization: false }
}

export type RunSignupAfterUserCreateSideEffectsInput = CompleteSignupAfterUserCreateInput & {
  name: string
  ensureDefaultOrg(userId: string, name: string): Promise<unknown>
  assignManagedAiAccess(userId: string): Promise<unknown>
  cleanupCreatedAuthUser(userId: string): Promise<void>
}

export async function runSignupAfterUserCreateSideEffects(input: RunSignupAfterUserCreateSideEffectsInput) {
  let signupResult: Awaited<ReturnType<typeof completeSignupAfterUserCreate>>
  let hasActiveMembership = false

  try {
    signupResult = await completeSignupAfterUserCreate(input)
    hasActiveMembership = signupResult.activatedOrganizationMembership

    if (signupResult.createDefaultOrganization) {
      await input.ensureDefaultOrg(input.user.id, input.name)
      hasActiveMembership = true
    }
  } catch (error) {
    await input.cleanupCreatedAuthUser(input.user.id)
    throw error
  }

  if (hasActiveMembership) {
    await input.assignManagedAiAccess(input.user.id)
  }

  return signupResult
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
