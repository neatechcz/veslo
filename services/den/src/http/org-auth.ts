import express from "express"
import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { OrgMembershipTable, OrgRole, OrgTable, PlatformRoleTable } from "../db/schema.js"
import { ensureDefaultOrg } from "../orgs.js"
import { hasRequiredOrgRole, pickActiveOrganization, type OrganizationAccessSummary } from "./access.js"
import { requireSession, type SessionContext } from "./session.js"

export const ORG_HEADER_NAME = "x-veslo-org-id"

export type OrganizationSummary = OrganizationAccessSummary

export type ResolvedOrganizationContext = {
  session: SessionContext
  organization: {
    id: string
    name: string
    slug: string
    ownerUserId: string
  }
  membershipId: string | null
  orgRole: (typeof OrgRole)[number] | null
  isPlatformAdmin: boolean
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

export function readRequestedOrganizationId(req: express.Request) {
  const headerValue = normalizeString(req.header(ORG_HEADER_NAME))
  if (headerValue) {
    return headerValue
  }

  const queryValue = req.query.orgId
  if (Array.isArray(queryValue)) {
    return normalizeString(queryValue[0])
  }

  return normalizeString(queryValue)
}

export async function resolveUserOrganizations(userId: string): Promise<OrganizationSummary[]> {
  const rows = await db
    .select({
      id: OrgTable.id,
      name: OrgTable.name,
      slug: OrgTable.slug,
      ownerUserId: OrgTable.owner_user_id,
      membershipId: OrgMembershipTable.id,
      role: OrgMembershipTable.role,
    })
    .from(OrgMembershipTable)
    .innerJoin(OrgTable, eq(OrgMembershipTable.org_id, OrgTable.id))
    .where(eq(OrgMembershipTable.user_id, userId))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerUserId: row.ownerUserId,
    membershipId: row.membershipId,
    role: row.role,
  }))
}

export async function resolveMembershipOrganizations(session: SessionContext) {
  let organizations = await resolveUserOrganizations(session.user.id)
  if (organizations.length === 0) {
    const fallbackName = session.user.name ?? session.user.email ?? "Personal"
    await ensureDefaultOrg(session.user.id, fallbackName)
    organizations = await resolveUserOrganizations(session.user.id)
  }
  return organizations
}

export async function isPlatformAdmin(userId: string) {
  const rows = await db
    .select({
      id: PlatformRoleTable.id,
    })
    .from(PlatformRoleTable)
    .where(eq(PlatformRoleTable.user_id, userId))
    .limit(1)

  return rows.length > 0
}

export async function findOrganizationById(orgId: string) {
  const rows = await db
    .select({
      id: OrgTable.id,
      name: OrgTable.name,
      slug: OrgTable.slug,
      ownerUserId: OrgTable.owner_user_id,
    })
    .from(OrgTable)
    .where(eq(OrgTable.id, orgId))
    .limit(1)

  return rows[0] ?? null
}

export async function resolveRequestedOrganization(req: express.Request, session: SessionContext) {
  const organizations = await resolveMembershipOrganizations(session)
  const requestedOrgId = readRequestedOrganizationId(req)
  const picked = pickActiveOrganization(organizations, requestedOrgId)

  return {
    organizations,
    requestedOrgId,
    picked,
  }
}

export async function requireOrganizationAccess(
  req: express.Request,
  res: express.Response,
  options: {
    minimumRole?: (typeof OrgRole)[number]
    orgId?: string
    allowPlatformAdmin?: boolean
  } = {},
): Promise<ResolvedOrganizationContext | null> {
  const session = await requireSession(req, res)
  if (!session) {
    return null
  }

  const allowPlatformAdmin = options.allowPlatformAdmin !== false
  const platformAdmin = allowPlatformAdmin ? await isPlatformAdmin(session.user.id) : false
  const organizations = await resolveMembershipOrganizations(session)

  const explicitOrgId = options.orgId ?? readRequestedOrganizationId(req)
  if (explicitOrgId) {
    const membership = organizations.find((entry) => entry.id === explicitOrgId) ?? null
    const organization = membership ? {
      id: membership.id,
      name: membership.name,
      slug: membership.slug,
      ownerUserId: membership.ownerUserId,
    } : (platformAdmin ? await findOrganizationById(explicitOrgId) : null)

    if (!organization) {
      res.status(403).json({ error: "organization_forbidden" })
      return null
    }

    if (!platformAdmin) {
      if (!membership || !hasRequiredOrgRole(membership.role, options.minimumRole ?? "member")) {
        res.status(403).json({ error: "insufficient_role" })
        return null
      }
    }

    return {
      session,
      organization,
      membershipId: membership?.membershipId ?? null,
      orgRole: membership?.role ?? null,
      isPlatformAdmin: platformAdmin,
    }
  }

  const picked = pickActiveOrganization(organizations, null)
  if (!picked.ok) {
    res.status(picked.status).json({
      error: picked.error,
      organizations: organizations.map((entry) => serializeOrganization(entry)),
    })
    return null
  }

  if (!platformAdmin && !hasRequiredOrgRole(picked.organization.role, options.minimumRole ?? "member")) {
    res.status(403).json({ error: "insufficient_role" })
    return null
  }

  return {
    session,
    organization: {
      id: picked.organization.id,
      name: picked.organization.name,
      slug: picked.organization.slug,
      ownerUserId: picked.organization.ownerUserId,
    },
    membershipId: picked.organization.membershipId,
    orgRole: picked.organization.role,
    isPlatformAdmin: platformAdmin,
  }
}

export function serializeOrganization(entry: OrganizationSummary) {
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    ownerUserId: entry.ownerUserId,
    role: entry.role,
  }
}
