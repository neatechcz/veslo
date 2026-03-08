import { randomUUID } from "crypto"
import express from "express"
import { and, eq, ne } from "drizzle-orm"
import { z } from "zod"
import { recordAuditEvent } from "../audit.js"
import { db } from "../db/index.js"
import { AuthUserTable, OrgMembershipTable, OrgRole, OrgTable } from "../db/schema.js"
import { asyncRoute } from "./errors.js"
import { resolveMembershipOrganizations, requireOrganizationAccess, serializeOrganization, readRequestedOrganizationId, isPlatformAdmin } from "./org-auth.js"
import { requireSession } from "./session.js"
import { wouldLeaveOrganizationWithoutOwner } from "./access.js"

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(OrgRole).default("member"),
})

const updateMemberRoleSchema = z.object({
  role: z.enum(OrgRole),
})

type OrganizationMemberRow = {
  membershipId: string
  userId: string
  name: string
  email: string
  role: (typeof OrgRole)[number]
  createdAt: Date
}

async function loadOrganizationMembers(orgId: string) {
  const rows = await db
    .select({
      membershipId: OrgMembershipTable.id,
      userId: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      role: OrgMembershipTable.role,
      createdAt: OrgMembershipTable.created_at,
    })
    .from(OrgMembershipTable)
    .innerJoin(AuthUserTable, eq(OrgMembershipTable.user_id, AuthUserTable.id))
    .where(eq(OrgMembershipTable.org_id, orgId))

  return rows
}

async function loadOrganizationMember(orgId: string, membershipId: string) {
  const rows = await db
    .select({
      membershipId: OrgMembershipTable.id,
      userId: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      role: OrgMembershipTable.role,
      createdAt: OrgMembershipTable.created_at,
    })
    .from(OrgMembershipTable)
    .innerJoin(AuthUserTable, eq(OrgMembershipTable.user_id, AuthUserTable.id))
    .where(and(eq(OrgMembershipTable.org_id, orgId), eq(OrgMembershipTable.id, membershipId)))
    .limit(1)

  return rows[0] ?? null
}

function serializeMember(row: OrganizationMemberRow) {
  return {
    membershipId: row.membershipId,
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
  }
}

async function pickReplacementOwnerUserId(orgId: string, excludedUserId: string) {
  const rows = await db
    .select({
      userId: OrgMembershipTable.user_id,
    })
    .from(OrgMembershipTable)
    .where(and(
      eq(OrgMembershipTable.org_id, orgId),
      eq(OrgMembershipTable.role, "owner"),
      ne(OrgMembershipTable.user_id, excludedUserId),
    ))
    .limit(1)

  return rows[0]?.userId ?? null
}

export const orgsRouter = express.Router()

orgsRouter.get("/", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) {
    return
  }

  const organizations = await resolveMembershipOrganizations(session)
  const requestedOrgId = readRequestedOrganizationId(req)
  const activeOrgId = requestedOrgId && organizations.some((entry) => entry.id === requestedOrgId)
    ? requestedOrgId
    : organizations.length === 1
      ? organizations[0].id
      : null
  const platformAdmin = await isPlatformAdmin(session.user.id)

  res.json({
    organizations: organizations.map((entry) => serializeOrganization(entry)),
    activeOrgId,
    defaultOrgId: organizations[0]?.id ?? null,
    platformAdmin,
  })
}))

orgsRouter.get("/:orgId/members", asyncRoute(async (req, res) => {
  const context = await requireOrganizationAccess(req, res, {
    orgId: req.params.orgId,
    minimumRole: "owner",
  })
  if (!context) {
    return
  }

  const rows = await loadOrganizationMembers(context.organization.id)
  res.json({
    members: rows.map((row) => serializeMember(row)),
  })
}))

orgsRouter.post("/:orgId/members", asyncRoute(async (req, res) => {
  const context = await requireOrganizationAccess(req, res, {
    orgId: req.params.orgId,
    minimumRole: "owner",
  })
  if (!context) {
    return
  }

  const parsed = addMemberSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const email = parsed.data.email.trim()
  const userRows = await db
    .select({
      id: AuthUserTable.id,
      email: AuthUserTable.email,
      name: AuthUserTable.name,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.email, email))
    .limit(1)

  const user = userRows[0] ?? null
  if (!user) {
    res.status(404).json({ error: "user_not_found" })
    return
  }

  const existing = await db
    .select({
      id: OrgMembershipTable.id,
    })
    .from(OrgMembershipTable)
    .where(and(eq(OrgMembershipTable.org_id, context.organization.id), eq(OrgMembershipTable.user_id, user.id)))
    .limit(1)

  if (existing.length > 0) {
    res.status(409).json({ error: "membership_exists" })
    return
  }

  const membershipId = randomUUID()
  await db.insert(OrgMembershipTable).values({
    id: membershipId,
    org_id: context.organization.id,
    user_id: user.id,
    role: parsed.data.role,
  })

  const created = await loadOrganizationMember(context.organization.id, membershipId)
  if (!created) {
    res.status(500).json({ error: "membership_creation_failed" })
    return
  }

  await recordAuditEvent({
    orgId: context.organization.id,
    actorUserId: context.session.user.id,
    action: "org.member.added",
    payload: {
      addedMembershipId: membershipId,
      addedUserId: user.id,
      role: parsed.data.role,
      via: context.isPlatformAdmin && context.orgRole !== "owner" ? "platform_admin" : "owner",
    },
  })

  res.status(201).json({
    member: serializeMember(created),
  })
}))

orgsRouter.patch("/:orgId/members/:memberId", asyncRoute(async (req, res) => {
  const context = await requireOrganizationAccess(req, res, {
    orgId: req.params.orgId,
    minimumRole: "owner",
  })
  if (!context) {
    return
  }

  const parsed = updateMemberRoleSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const target = await loadOrganizationMember(context.organization.id, req.params.memberId)
  if (!target) {
    res.status(404).json({ error: "membership_not_found" })
    return
  }

  if (target.role === parsed.data.role) {
    res.json({
      member: serializeMember(target),
    })
    return
  }

  const members = await loadOrganizationMembers(context.organization.id)
  const ownerCount = members.filter((entry) => entry.role === "owner").length
  if (wouldLeaveOrganizationWithoutOwner({
    ownerCount,
    targetRole: target.role,
    nextRole: parsed.data.role,
  })) {
    res.status(409).json({ error: "last_owner_required" })
    return
  }

  await db.transaction(async (tx) => {
    await tx
      .update(OrgMembershipTable)
      .set({ role: parsed.data.role })
      .where(eq(OrgMembershipTable.id, target.membershipId))

    if (target.userId === context.organization.ownerUserId && parsed.data.role !== "owner") {
      const replacementUserId = members.find((entry) => entry.role === "owner" && entry.userId !== target.userId)?.userId ?? null
      if (replacementUserId) {
        await tx
          .update(OrgTable)
          .set({ owner_user_id: replacementUserId })
          .where(eq(OrgTable.id, context.organization.id))
      }
    }
  })

  const updated = await loadOrganizationMember(context.organization.id, target.membershipId)
  if (!updated) {
    res.status(500).json({ error: "membership_update_failed" })
    return
  }

  await recordAuditEvent({
    orgId: context.organization.id,
    actorUserId: context.session.user.id,
    action: "org.member.role_updated",
    payload: {
      membershipId: target.membershipId,
      userId: target.userId,
      previousRole: target.role,
      nextRole: parsed.data.role,
      via: context.isPlatformAdmin && context.orgRole !== "owner" ? "platform_admin" : "owner",
    },
  })

  res.json({
    member: serializeMember(updated),
  })
}))

orgsRouter.delete("/:orgId/members/:memberId", asyncRoute(async (req, res) => {
  const context = await requireOrganizationAccess(req, res, {
    orgId: req.params.orgId,
    minimumRole: "owner",
  })
  if (!context) {
    return
  }

  const target = await loadOrganizationMember(context.organization.id, req.params.memberId)
  if (!target) {
    res.status(404).json({ error: "membership_not_found" })
    return
  }

  const members = await loadOrganizationMembers(context.organization.id)
  const ownerCount = members.filter((entry) => entry.role === "owner").length
  if (wouldLeaveOrganizationWithoutOwner({
    ownerCount,
    targetRole: target.role,
    nextRole: null,
  })) {
    res.status(409).json({ error: "last_owner_required" })
    return
  }

  const replacementOwnerUserId =
    target.userId === context.organization.ownerUserId && target.role === "owner"
      ? await pickReplacementOwnerUserId(context.organization.id, target.userId)
      : null

  await db.transaction(async (tx) => {
    await tx.delete(OrgMembershipTable).where(eq(OrgMembershipTable.id, target.membershipId))

    if (replacementOwnerUserId) {
      await tx
        .update(OrgTable)
        .set({ owner_user_id: replacementOwnerUserId })
        .where(eq(OrgTable.id, context.organization.id))
    }
  })

  await recordAuditEvent({
    orgId: context.organization.id,
    actorUserId: context.session.user.id,
    action: "org.member.removed",
    payload: {
      membershipId: target.membershipId,
      userId: target.userId,
      role: target.role,
      via: context.isPlatformAdmin && context.orgRole !== "owner" ? "platform_admin" : "owner",
    },
  })

  res.status(204).end()
}))
