import { and, asc, eq } from "drizzle-orm"

import { AuthUserTable, OrgMembershipTable } from "../db/schema.js"
import { normalizeEmailDomain } from "./policy.js"

export type OrganizationDomainMemberEvidenceCandidate = {
  orgId: string
  userId: string
  email: string
  emailVerified: boolean
  membershipStatus: "active" | "disabled" | "removed"
}

export type OrganizationDomainMemberReader = {
  listMembers(orgId: string): Promise<OrganizationDomainMemberEvidenceCandidate[]>
}

export class OrganizationDomainVerifiedMemberRequiredError extends Error {
  readonly code = "domain_verified_member_required"

  constructor() {
    super("domain_verified_member_required")
    this.name = "OrganizationDomainVerifiedMemberRequiredError"
  }
}

export function createOrganizationDomainVerifier(input: OrganizationDomainMemberReader) {
  return {
    async requireVerifiedMember(orgId: string, domain: string) {
      const normalizedOrgId = orgId.trim()
      const normalizedDomain = domain.trim().toLowerCase()
      const members = await input.listMembers(normalizedOrgId)
      const evidence = members
        .filter((member) => (
          member.orgId === normalizedOrgId
          && member.membershipStatus === "active"
          && member.emailVerified === true
          && normalizeEmailDomain(member.email) === normalizedDomain
        ))
        .sort((left, right) => left.userId.localeCompare(right.userId))[0]

      if (!evidence) {
        throw new OrganizationDomainVerifiedMemberRequiredError()
      }

      return { userId: evidence.userId }
    },
  }
}

export function createDrizzleOrganizationDomainMemberReader(
  database: any,
): OrganizationDomainMemberReader {
  return {
    async listMembers(orgId) {
      return database
        .select({
          orgId: OrgMembershipTable.org_id,
          userId: AuthUserTable.id,
          email: AuthUserTable.email,
          emailVerified: AuthUserTable.emailVerified,
          membershipStatus: OrgMembershipTable.status,
        })
        .from(OrgMembershipTable)
        .innerJoin(AuthUserTable, eq(OrgMembershipTable.user_id, AuthUserTable.id))
        .where(and(
          eq(OrgMembershipTable.org_id, orgId),
          eq(OrgMembershipTable.status, "active"),
          eq(AuthUserTable.emailVerified, true),
        ))
        .orderBy(asc(AuthUserTable.id))
    },
  }
}
