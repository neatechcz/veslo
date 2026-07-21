import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import {
  AuthUserTable,
  OrgMembershipTable,
  OrgRole,
  OrgTable,
  OrganizationDomainTable,
  OrganizationInviteTable,
  OrganizationMembershipStatus,
} from "../db/schema.js"
import { canActivateSeat, normalizeEmailDomain, normalizeInviteEmail } from "./policy.js"

export type OrganizationAdminErrorCode =
  | "domain_not_allowed"
  | "seat_limit_reached"
  | "invite_not_found"
  | "invite_expired"
  | "invite_already_used"

export class OrganizationAdminRepositoryError extends Error {
  constructor(readonly code: OrganizationAdminErrorCode) {
    super(code)
    this.name = "OrganizationAdminRepositoryError"
  }
}

export type OrganizationAdminOrganizationRecord = {
  id: string
  seatLimit: number | null
}

export type OrganizationAdminDomainRecord = {
  id: string
  orgId: string
  domain: string
  enabled: boolean
  selfSignupEnabled: boolean
}

export type OrganizationAdminMembershipRecord = {
  id: string
  orgId: string
  userId: string
  role: (typeof OrgRole)[number]
  status: (typeof OrganizationMembershipStatus)[number]
  createdAt: Date
}

export type OrganizationAdminInviteRecord = {
  id: string
  orgId: string
  email: string
  role: (typeof OrgRole)[number]
  status: "pending" | "accepted" | "expired" | "revoked"
  tokenHash: string
  invitedByUserId: string
  acceptedByUserId: string | null
  expiresAt: Date | null
  acceptedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type OrganizationAdminResolvedDomain = OrganizationAdminDomainRecord & {
  organization: OrganizationAdminOrganizationRecord
}

export type OrganizationAdminDataStore = {
  findOrganizationById(orgId: string): Promise<OrganizationAdminOrganizationRecord | null>
  lockOrganizationForSeatActivation?(orgId: string): Promise<void>
  findDomainByDomain(domain: string): Promise<OrganizationAdminDomainRecord | null>
  countActiveOrganizationSeats(orgId: string): Promise<number>
  insertInvite(input: OrganizationAdminInviteRecord): Promise<OrganizationAdminInviteRecord>
  findInviteByTokenHash(tokenHash: string): Promise<OrganizationAdminInviteRecord | null>
  createOrActivateMembership(input: {
    membershipId: string
    orgId: string
    userId: string
    role: (typeof OrgRole)[number]
  }): Promise<OrganizationAdminMembershipRecord>
  markInviteAccepted(input: {
    inviteId: string
    expectedTokenHash: string
    acceptedByUserId: string
    acceptedAt: Date
  }): Promise<OrganizationAdminInviteRecord | null>
  listOrganizationMembers(orgId: string): Promise<OrganizationAdminMembershipRecord[]>
  listOrganizationInvites(orgId: string): Promise<OrganizationAdminInviteRecord[]>
  listOrganizationDomains(orgId: string): Promise<OrganizationAdminDomainRecord[]>
  transaction?<T>(callback: (store: OrganizationAdminDataStore) => Promise<T>): Promise<T>
}

export type CreateOrganizationInviteInput = {
  orgId: string
  email: string
  role?: (typeof OrgRole)[number]
  tokenHash: string
  invitedByUserId: string
  expiresAt?: Date | null
}

export type AcceptOrganizationInviteInput = {
  tokenHash: string
  userId: string
  email?: string | null
  now?: Date
}

export type ResolveValidOrganizationInviteForSignupInput = {
  email: string
  tokenHash: string
  now?: Date
}

export type OrganizationAdminRepository = {
  resolveEnabledOrganizationDomainForEmail(email: string): Promise<OrganizationAdminResolvedDomain>
  countActiveOrganizationSeats(orgId: string): Promise<number>
  assertCanActivateOrganizationSeat(orgId: string): Promise<void>
  createOrActivateOrganizationMembership(input: {
    membershipId: string
    orgId: string
    userId: string
    role: (typeof OrgRole)[number]
  }): Promise<OrganizationAdminMembershipRecord>
  createOrganizationInvite(input: CreateOrganizationInviteInput): Promise<OrganizationAdminInviteRecord>
  resolveValidOrganizationInviteForSignup(input: ResolveValidOrganizationInviteForSignupInput): Promise<OrganizationAdminInviteRecord>
  acceptOrganizationInvite(input: AcceptOrganizationInviteInput): Promise<{
    invite: OrganizationAdminInviteRecord
    membership: OrganizationAdminMembershipRecord
  }>
  listOrganizationMembers(orgId: string): Promise<OrganizationAdminMembershipRecord[]>
  listOrganizationInvites(orgId: string): Promise<OrganizationAdminInviteRecord[]>
  listOrganizationDomains(orgId: string): Promise<OrganizationAdminDomainRecord[]>
}

type RepositoryOptions = {
  createId?: (prefix: string) => string
  now?: () => Date
}

export function createOrganizationAdminRepository(
  store: OrganizationAdminDataStore,
  options: RepositoryOptions = {},
): OrganizationAdminRepository {
  const createId = options.createId ?? ((prefix: string) => `${prefix}_${randomUUID()}`)
  const now = options.now ?? (() => new Date())

  async function assertCanActivateOrganizationSeatWithStore(activeStore: OrganizationAdminDataStore, orgId: string) {
    await activeStore.lockOrganizationForSeatActivation?.(orgId)
    const organization = await activeStore.findOrganizationById(orgId)
    if (!organization) {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    }

    const activeSeats = await activeStore.countActiveOrganizationSeats(orgId)
    if (!canActivateSeat({ activeSeats, seatLimit: organization.seatLimit })) {
      throw new OrganizationAdminRepositoryError("seat_limit_reached")
    }
  }

  return {
    async resolveEnabledOrganizationDomainForEmail(email) {
      const domain = normalizeEmailDomain(email)
      if (!domain) {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      }

      const domainRecord = await store.findDomainByDomain(domain)
      if (!domainRecord?.enabled || !domainRecord.selfSignupEnabled) {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      }

      const organization = await store.findOrganizationById(domainRecord.orgId)
      if (!organization) {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      }

      return {
        ...domainRecord,
        organization,
      }
    },

    countActiveOrganizationSeats(orgId) {
      return store.countActiveOrganizationSeats(orgId)
    },

    assertCanActivateOrganizationSeat(orgId) {
      return assertCanActivateOrganizationSeatWithStore(store, orgId)
    },

    async createOrActivateOrganizationMembership(input) {
      const transaction = store.transaction ?? (<T>(callback: (activeStore: OrganizationAdminDataStore) => Promise<T>) => callback(store))
      return transaction(async (activeStore) => {
        await assertCanActivateOrganizationSeatWithStore(activeStore, input.orgId)
        return activeStore.createOrActivateMembership(input)
      })
    },

    async createOrganizationInvite(input) {
      const email = normalizeInviteEmail(input.email)
      if (!email) {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      }

      const createdAt = now()
      return store.insertInvite({
        id: createId("invite"),
        orgId: input.orgId,
        email,
        role: input.role ?? "member",
        status: "pending",
        tokenHash: input.tokenHash,
        invitedByUserId: input.invitedByUserId,
        acceptedByUserId: null,
        expiresAt: input.expiresAt ?? null,
        acceptedAt: null,
        revokedAt: null,
        createdAt,
        updatedAt: createdAt,
      })
    },

    async resolveValidOrganizationInviteForSignup(input) {
      const email = normalizeInviteEmail(input.email)
      if (!email) {
        throw new OrganizationAdminRepositoryError("invite_not_found")
      }

      const invite = await store.findInviteByTokenHash(input.tokenHash)
      if (!invite || invite.status === "revoked" || invite.email !== email) {
        throw new OrganizationAdminRepositoryError("invite_not_found")
      }
      if (invite.status === "accepted") {
        throw new OrganizationAdminRepositoryError("invite_already_used")
      }

      const resolveNow = input.now ?? now()
      if (invite.status === "expired" || (invite.expiresAt && invite.expiresAt <= resolveNow)) {
        throw new OrganizationAdminRepositoryError("invite_expired")
      }

      return invite
    },

    async acceptOrganizationInvite(input) {
      const acceptNow = input.now ?? now()
      const transaction = store.transaction ?? (<T>(callback: (activeStore: OrganizationAdminDataStore) => Promise<T>) => callback(store))

      return transaction(async (activeStore) => {
        const invite = await activeStore.findInviteByTokenHash(input.tokenHash)
        if (!invite || invite.status === "revoked") {
          throw new OrganizationAdminRepositoryError("invite_not_found")
        }
        if (invite.status === "accepted") {
          throw new OrganizationAdminRepositoryError("invite_already_used")
        }
        if (invite.status === "expired" || (invite.expiresAt && invite.expiresAt <= acceptNow)) {
          throw new OrganizationAdminRepositoryError("invite_expired")
        }
        if (input.email !== undefined) {
          const email = normalizeInviteEmail(input.email)
          if (!email || invite.email !== email) {
            throw new OrganizationAdminRepositoryError("invite_not_found")
          }
        }

        await assertCanActivateOrganizationSeatWithStore(activeStore, invite.orgId)

        const acceptedInvite = await activeStore.markInviteAccepted({
          inviteId: invite.id,
          expectedTokenHash: invite.tokenHash,
          acceptedByUserId: input.userId,
          acceptedAt: acceptNow,
        })
        if (!acceptedInvite) {
          const latest = await activeStore.findInviteByTokenHash(input.tokenHash)
          throw new OrganizationAdminRepositoryError(latest?.status === "accepted" ? "invite_already_used" : "invite_not_found")
        }

        const membership = await activeStore.createOrActivateMembership({
          membershipId: createId("membership"),
          orgId: acceptedInvite.orgId,
          userId: input.userId,
          role: acceptedInvite.role,
        })

        return {
          invite: acceptedInvite,
          membership,
        }
      })
    },

    listOrganizationMembers(orgId) {
      return store.listOrganizationMembers(orgId)
    },

    listOrganizationInvites(orgId) {
      return store.listOrganizationInvites(orgId)
    },

    listOrganizationDomains(orgId) {
      return store.listOrganizationDomains(orgId)
    },
  }
}

export function createDrizzleOrganizationAdminStore(database: any): OrganizationAdminDataStore {
  const store: OrganizationAdminDataStore = {
    async findOrganizationById(orgId) {
      const rows = await database
        .select({
          id: OrgTable.id,
          seatLimit: OrgTable.seat_limit,
        })
        .from(OrgTable)
        .where(eq(OrgTable.id, orgId))
        .limit(1)

      return rows[0] ? {
        id: rows[0].id,
        seatLimit: rows[0].seatLimit ?? null,
      } : null
    },

    async lockOrganizationForSeatActivation(orgId) {
      await database.execute(sql`select ${OrgTable.id} from ${OrgTable} where ${OrgTable.id} = ${orgId} for update`)
    },

    async findDomainByDomain(domain) {
      const rows = await database
        .select()
        .from(OrganizationDomainTable)
        .where(eq(OrganizationDomainTable.domain, domain))
        .limit(1)

      return rows[0] ? mapDomainRow(rows[0]) : null
    },

    async countActiveOrganizationSeats(orgId) {
      const rows = await database
        .select({ activeSeats: sql<number>`count(*)` })
        .from(OrgMembershipTable)
        .where(and(eq(OrgMembershipTable.org_id, orgId), eq(OrgMembershipTable.status, "active")))

      return Number(rows[0]?.activeSeats ?? 0)
    },

    async insertInvite(input) {
      await database.insert(OrganizationInviteTable).values({
        id: input.id,
        org_id: input.orgId,
        email: input.email,
        role: input.role,
        status: input.status,
        token_hash: input.tokenHash,
        invited_by_user_id: input.invitedByUserId,
        accepted_by_user_id: input.acceptedByUserId,
        expires_at: input.expiresAt,
        accepted_at: input.acceptedAt,
        revoked_at: input.revokedAt,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
      })

      const invite = await this.findInviteByTokenHash(input.tokenHash)
      return invite ?? input
    },

    async findInviteByTokenHash(tokenHash) {
      const rows = await database
        .select()
        .from(OrganizationInviteTable)
        .where(eq(OrganizationInviteTable.token_hash, tokenHash))
        .limit(1)

      return rows[0] ? mapInviteRow(rows[0]) : null
    },

    async createOrActivateMembership(input) {
      const existing = await database
        .select()
        .from(OrgMembershipTable)
        .where(and(eq(OrgMembershipTable.org_id, input.orgId), eq(OrgMembershipTable.user_id, input.userId)))
        .limit(1)

      if (existing[0]) {
        await database
          .update(OrgMembershipTable)
          .set({ role: input.role, status: "active" })
          .where(eq(OrgMembershipTable.id, existing[0].id))
        return {
          ...mapMembershipRow(existing[0]),
          role: input.role,
          status: "active",
        }
      }

      await database.insert(OrgMembershipTable).values({
        id: input.membershipId,
        org_id: input.orgId,
        user_id: input.userId,
        role: input.role,
        status: "active",
      })

      return {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active",
        createdAt: new Date(),
      }
    },

    async markInviteAccepted(input) {
      const result = await database
        .update(OrganizationInviteTable)
        .set({
          status: "accepted",
          accepted_by_user_id: input.acceptedByUserId,
          accepted_at: input.acceptedAt,
          updated_at: input.acceptedAt,
        })
        .where(and(
          eq(OrganizationInviteTable.id, input.inviteId),
          eq(OrganizationInviteTable.status, "pending"),
          eq(OrganizationInviteTable.token_hash, input.expectedTokenHash),
        ))

      if (extractAffectedRows(result) === 0) {
        return null
      }

      const rows = await database
        .select()
        .from(OrganizationInviteTable)
        .where(eq(OrganizationInviteTable.id, input.inviteId))
        .limit(1)

      return rows[0] ? mapInviteRow(rows[0]) : null
    },

    async listOrganizationMembers(orgId) {
      const rows = await database
        .select({
          membership: OrgMembershipTable,
        })
        .from(OrgMembershipTable)
        .leftJoin(AuthUserTable, eq(OrgMembershipTable.user_id, AuthUserTable.id))
        .where(eq(OrgMembershipTable.org_id, orgId))

      return rows.map((row: { membership: typeof OrgMembershipTable.$inferSelect }) => mapMembershipRow(row.membership))
    },

    async listOrganizationInvites(orgId) {
      const rows = await database
        .select()
        .from(OrganizationInviteTable)
        .where(eq(OrganizationInviteTable.org_id, orgId))

      return rows.map(mapInviteRow)
    },

    async listOrganizationDomains(orgId) {
      const rows = await database
        .select()
        .from(OrganizationDomainTable)
        .where(eq(OrganizationDomainTable.org_id, orgId))

      return rows.map(mapDomainRow)
    },

    transaction(callback) {
      return database.transaction((tx: any) => callback(createDrizzleOrganizationAdminStore(tx)))
    },
  }

  return store
}

let defaultRepository: OrganizationAdminRepository | null = null

async function getDefaultRepository() {
  if (!defaultRepository) {
    const { db } = await import("../db/index.js")
    defaultRepository = createOrganizationAdminRepository(createDrizzleOrganizationAdminStore(db))
  }
  return defaultRepository
}

export async function resolveEnabledOrganizationDomainForEmail(email: string) {
  return (await getDefaultRepository()).resolveEnabledOrganizationDomainForEmail(email)
}

export async function countActiveOrganizationSeats(orgId: string) {
  return (await getDefaultRepository()).countActiveOrganizationSeats(orgId)
}

export async function assertCanActivateOrganizationSeat(orgId: string) {
  return (await getDefaultRepository()).assertCanActivateOrganizationSeat(orgId)
}

export async function createOrActivateOrganizationMembership(input: {
  membershipId: string
  orgId: string
  userId: string
  role: (typeof OrgRole)[number]
}) {
  return (await getDefaultRepository()).createOrActivateOrganizationMembership(input)
}

export async function createOrganizationInvite(input: CreateOrganizationInviteInput) {
  return (await getDefaultRepository()).createOrganizationInvite(input)
}

export async function resolveValidOrganizationInviteForSignup(input: ResolveValidOrganizationInviteForSignupInput) {
  return (await getDefaultRepository()).resolveValidOrganizationInviteForSignup(input)
}

export async function acceptOrganizationInvite(input: AcceptOrganizationInviteInput) {
  return (await getDefaultRepository()).acceptOrganizationInvite(input)
}

export async function listOrganizationMembers(orgId: string) {
  return (await getDefaultRepository()).listOrganizationMembers(orgId)
}

export async function listOrganizationInvites(orgId: string) {
  return (await getDefaultRepository()).listOrganizationInvites(orgId)
}

export async function listOrganizationDomains(orgId: string) {
  return (await getDefaultRepository()).listOrganizationDomains(orgId)
}

function mapDomainRow(row: typeof OrganizationDomainTable.$inferSelect): OrganizationAdminDomainRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    enabled: row.enabled,
    selfSignupEnabled: row.self_signup_enabled,
  }
}

function mapInviteRow(row: typeof OrganizationInviteTable.$inferSelect): OrganizationAdminInviteRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    status: row.status,
    tokenHash: row.token_hash,
    invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: row.accepted_by_user_id,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMembershipRow(row: typeof OrgMembershipTable.$inferSelect): OrganizationAdminMembershipRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  }
}

export function extractAffectedRows(result: unknown) {
  const candidate = Array.isArray(result) ? result[0] : result
  if (candidate && typeof candidate === "object" && "affectedRows" in candidate) {
    return Number(candidate.affectedRows ?? 0)
  }
  return null
}
