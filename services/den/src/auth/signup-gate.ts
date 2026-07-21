import type {
  OrganizationAdminInviteRecord,
  OrganizationAdminMembershipRecord,
  OrganizationAdminResolvedDomain,
} from "../org-admin/repository.js"
import { OrganizationAdminRepositoryError } from "../org-admin/repository.js"
import { normalizeInviteEmail } from "../org-admin/policy.js"
import { hashOrganizationInviteToken } from "../org-admin/invite-token.js"
import type { OrgRole } from "../db/schema.js"
import { SignupOrganizationDomainConflictError } from "./signup-organization.js"

const SIGNUP_ORGANIZATION_BOOTSTRAP_ENABLED = true

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
  | { ok: true; mode: "organization_bootstrap" }
  | { ok: false; error: SignupAccessError }

export type ResolvedSignupAccessDecision =
  | { ok: true; mode: "domain"; organizationId: string; role: "member" }
  | { ok: true; mode: "invite"; organizationId: string; role: (typeof OrgRole)[number]; inviteToken: string }
  | { ok: true; mode: "organization_bootstrap" }
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

  if (SIGNUP_ORGANIZATION_BOOTSTRAP_ENABLED) {
    return { ok: true, mode: "organization_bootstrap" }
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
    if (decision.mode === "organization_bootstrap") {
      return { ok: true, mode: "organization_bootstrap" }
    }
    if (decision.mode === "invite") {
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

  if (SIGNUP_ORGANIZATION_BOOTSTRAP_ENABLED) {
    return { ok: true, mode: "organization_bootstrap" }
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
    return { activatedOrganizationMembership: false, createSignupOrganization: false }
  }

  const matchingDomain = await resolveAllowedDomain(email, input)
  if (matchingDomain) {
    await input.createOrActivateOrganizationMembership({
      membershipId: input.createMembershipId(),
      orgId: matchingDomain.orgId,
      userId: input.user.id,
      role: "member",
    })

    return { activatedOrganizationMembership: true, createSignupOrganization: false }
  }

  if (input.inviteToken) {
    await acceptSignupInviteWithTokenFallback({
      acceptOrganizationInvite: input.acceptOrganizationInvite,
      inviteToken: input.inviteToken,
      userId: input.user.id,
      email,
    })
    return { activatedOrganizationMembership: true, createSignupOrganization: false }
  }

  return {
    activatedOrganizationMembership: false,
    createSignupOrganization: SIGNUP_ORGANIZATION_BOOTSTRAP_ENABLED,
  }
}

export type RunSignupAfterUserCreateSideEffectsInput = Omit<CompleteSignupAfterUserCreateInput, "user"> & {
  user: CompleteSignupAfterUserCreateInput["user"] & {
    emailVerified: boolean
  }
  name: string
  runWithUserProvisioningLock<T>(userId: string, operation: () => Promise<T>): Promise<T>
  findExistingOrganizationId(userId: string): Promise<string | null>
  ensureSignupOrganization(userId: string, name: string, email: string): Promise<string>
  assignManagedAiAccess(userId: string): Promise<unknown>
  cleanupCreatedAuthUser(userId: string): Promise<void>
}

export type ProvisionVerifiedSignupUserInput = {
  user: {
    id: string
    name: string | null | undefined
    email: string | null | undefined
    emailVerified: boolean
  }
  runWithUserProvisioningLock<T>(userId: string, operation: () => Promise<T>): Promise<T>
  createMembershipId(): string
  findExistingOrganizationId(userId: string): Promise<string | null>
  resolveEnabledOrganizationDomainForEmail(email: string): Promise<OrganizationAdminResolvedDomain>
  createOrActivateOrganizationMembership(input: {
    membershipId: string
    orgId: string
    userId: string
    role: (typeof OrgRole)[number]
  }): Promise<OrganizationAdminMembershipRecord>
  ensureSignupOrganization(userId: string, name: string, email: string): Promise<string>
  assignManagedAiAccess(userId: string): Promise<unknown>
}

export async function provisionVerifiedSignupUser(input: ProvisionVerifiedSignupUserInput) {
  if (!input.user.emailVerified) {
    return {
      awaitingEmailVerification: true as const,
      activatedOrganizationMembership: false,
      organizationId: null,
    }
  }

  const email = normalizeInviteEmail(input.user.email)
  if (!email) {
    throw new OrganizationAdminRepositoryError("domain_not_allowed")
  }

  const organizationId = await input.runWithUserProvisioningLock(input.user.id, async () => {
    const existingOrganizationId = await input.findExistingOrganizationId(input.user.id)
    if (existingOrganizationId) {
      return existingOrganizationId
    }

    const matchingDomain = await resolveAllowedDomain(email, input)
    if (matchingDomain) {
      await input.createOrActivateOrganizationMembership({
        membershipId: input.createMembershipId(),
        orgId: matchingDomain.orgId,
        userId: input.user.id,
        role: "member",
      })
      return matchingDomain.orgId
    }

    try {
      return await input.ensureSignupOrganization(
        input.user.id,
        input.user.name ?? email,
        email,
      )
    } catch (error) {
      if (!(error instanceof SignupOrganizationDomainConflictError)) {
        throw error
      }

      const concurrentOrganizationId = await input.findExistingOrganizationId(input.user.id)
      if (concurrentOrganizationId) {
        return concurrentOrganizationId
      }

      const winningDomain = await resolveAllowedDomain(email, input)
      if (!winningDomain) {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      }
      await input.createOrActivateOrganizationMembership({
        membershipId: input.createMembershipId(),
        orgId: winningDomain.orgId,
        userId: input.user.id,
        role: "member",
      })
      return winningDomain.orgId
    }
  })

  await input.assignManagedAiAccess(input.user.id)
  return {
    awaitingEmailVerification: false as const,
    activatedOrganizationMembership: true,
    organizationId,
  }
}

export async function runSignupAfterUserCreateSideEffects(input: RunSignupAfterUserCreateSideEffectsInput) {
  let durableSideEffectsStarted = false
  const createOrActivateOrganizationMembership: typeof input.createOrActivateOrganizationMembership = async (membership) => {
    durableSideEffectsStarted = true
    return input.createOrActivateOrganizationMembership(membership)
  }
  const acceptOrganizationInvite: typeof input.acceptOrganizationInvite = async (invite) => {
    durableSideEffectsStarted = true
    return input.acceptOrganizationInvite(invite)
  }
  const findExistingOrganizationId: typeof input.findExistingOrganizationId = async (userId) => {
    const organizationId = await input.findExistingOrganizationId(userId)
    if (organizationId) {
      durableSideEffectsStarted = true
    }
    return organizationId
  }
  const ensureSignupOrganization: typeof input.ensureSignupOrganization = async (userId, name, email) => {
    const hadDurableSideEffects = durableSideEffectsStarted
    durableSideEffectsStarted = true
    try {
      return await input.ensureSignupOrganization(userId, name, email)
    } catch (error) {
      if (error instanceof SignupOrganizationDomainConflictError) {
        durableSideEffectsStarted = hadDurableSideEffects
      }
      throw error
    }
  }
  const assignManagedAiAccess: typeof input.assignManagedAiAccess = async (userId) => {
    durableSideEffectsStarted = true
    return input.assignManagedAiAccess(userId)
  }

  try {
    const signupResult = await completeSignupAfterUserCreate({
      ...input,
      createOrActivateOrganizationMembership,
      acceptOrganizationInvite,
    })

    if (!input.user.emailVerified) {
      return {
        awaitingEmailVerification: true as const,
        activatedOrganizationMembership: signupResult.activatedOrganizationMembership,
        createSignupOrganization: false as const,
      }
    }

    return await provisionVerifiedSignupUser({
      user: {
        ...input.user,
        name: input.name,
      },
      runWithUserProvisioningLock: input.runWithUserProvisioningLock,
      createMembershipId: input.createMembershipId,
      findExistingOrganizationId,
      resolveEnabledOrganizationDomainForEmail: input.resolveEnabledOrganizationDomainForEmail,
      createOrActivateOrganizationMembership,
      ensureSignupOrganization,
      assignManagedAiAccess,
    })
  } catch (error) {
    if (!durableSideEffectsStarted) {
      await input.cleanupCreatedAuthUser(input.user.id)
    }
    throw error
  }
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
