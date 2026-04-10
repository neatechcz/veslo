import express from "express"
import { and, eq, inArray, sql } from "drizzle-orm"
import { randomBytes, randomUUID } from "node:crypto"

import { recordAuditEvent } from "../audit.js"
import { db } from "../db/index.js"
import {
  AdminUserStateTable,
  AuthAccountTable,
  AuthSessionTable,
  AuthUserTable,
  DesktopAuthHandoffTable,
  DesktopAuthSessionTable,
  DesktopAuthTransactionTable,
  OrgMembershipTable,
  OrgRole,
  OrgTable,
  PlatformRoleTable,
  WorkerTable,
} from "../db/schema.js"
import { env } from "../env.js"
import { resolveMembershipOrganizations, isPlatformAdmin } from "./org-auth.js"
import { requireSession } from "./session.js"
import { createAdminRouter, type AdminRouteDeps, type AdminSessionSnapshot, type AdminUserMembership, type AdminUserRecord } from "./admin.js"
import { createManagedAiAdminRouteDeps } from "../managed-ai/http/admin.js"
import type { RuntimeState } from "../managed-ai/runtime/default-runtime.js"

type ListedUserRow = {
  id: string
  name: string
  email: string
  emailVerified: boolean
}

const bootstrapPlatformAdminEmails = new Set([
  "michal.sara@neatech.cz",
  "vaclav.soukup@neatec.cz",
  "vaclav.soukup@neotech.cz",
])

function randomPassword() {
  return `${randomBytes(8).toString("hex")}Aa1!`
}

export function isBootstrapPlatformAdminEmail(email: string | null) {
  return typeof email === "string" && bootstrapPlatformAdminEmails.has(email.trim().toLowerCase())
}

export async function requirePlatformAdminSnapshot(req: express.Request, res: express.Response): Promise<AdminSessionSnapshot | null> {
  const session = await requireSession(req, res)
  if (!session) {
    return null
  }

  const platformAdmin = isBootstrapPlatformAdminEmail(session.user.email) || await isPlatformAdmin(session.user.id)
  if (!platformAdmin) {
    res.status(403).json({ error: "forbidden" })
    return null
  }

  const organizations = await resolveMembershipOrganizations(session)

  return {
    user: session.user,
    platformAdmin,
    activeOrgId: organizations[0]?.id ?? null,
    organizations: organizations.map((entry) => ({
      id: entry.id,
      name: entry.name,
      slug: entry.slug,
      ownerUserId: entry.ownerUserId,
      role: entry.role,
    })),
  }
}

async function loadUserMemberships(userIds: string[]) {
  if (userIds.length === 0) {
    return new Map<string, AdminUserMembership[]>()
  }

  const rows = await db
    .select({
      userId: OrgMembershipTable.user_id,
      membershipId: OrgMembershipTable.id,
      orgId: OrgMembershipTable.org_id,
      orgName: OrgTable.name,
      orgSlug: OrgTable.slug,
      role: OrgMembershipTable.role,
    })
    .from(OrgMembershipTable)
    .innerJoin(OrgTable, eq(OrgMembershipTable.org_id, OrgTable.id))
    .where(inArray(OrgMembershipTable.user_id, userIds))

  const byUser = new Map<string, AdminUserMembership[]>()
  for (const row of rows) {
    const next = byUser.get(row.userId) ?? []
    next.push({
      membershipId: row.membershipId,
      orgId: row.orgId,
      orgName: row.orgName,
      orgSlug: row.orgSlug,
      role: row.role,
    })
    byUser.set(row.userId, next)
  }

  return byUser
}

async function loadPlatformAdminUserIds(userIds: string[]) {
  if (userIds.length === 0) {
    return new Set<string>()
  }

  const rows = await db
    .select({
      userId: PlatformRoleTable.user_id,
    })
    .from(PlatformRoleTable)
    .where(inArray(PlatformRoleTable.user_id, userIds))

  return new Set(rows.map((row) => row.userId))
}

async function loadUserDisabledState(userIds: string[]) {
  if (userIds.length === 0) {
    return new Set<string>()
  }

  const rows = await db
    .select({
      userId: AdminUserStateTable.user_id,
      disabled: AdminUserStateTable.disabled,
    })
    .from(AdminUserStateTable)
    .where(inArray(AdminUserStateTable.user_id, userIds))

  return new Set(rows.filter((row) => row.disabled === true).map((row) => row.userId))
}

async function loadAdminUsers() {
  const users = await db
    .select({
      id: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      emailVerified: AuthUserTable.emailVerified,
    })
    .from(AuthUserTable)

  const userIds = users.map((entry) => entry.id)
  const [membershipsByUser, platformAdmins, disabledUsers] = await Promise.all([
    loadUserMemberships(userIds),
    loadPlatformAdminUserIds(userIds),
    loadUserDisabledState(userIds),
  ])

  return users.map((entry): AdminUserRecord => ({
    id: entry.id,
    name: entry.name,
    email: entry.email,
    emailVerified: entry.emailVerified,
    platformAdmin: platformAdmins.has(entry.id) || isBootstrapPlatformAdminEmail(entry.email),
    disabled: disabledUsers.has(entry.id),
    memberships: membershipsByUser.get(entry.id) ?? [],
  }))
}

async function createUserViaAuth(req: express.Request, body: { email: string; name: string; password?: string }) {
  const baseUrl = env.betterAuthUrl.replace(/\/+$/, "")
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      Cookie: req.header("cookie") ?? "",
    },
    body: JSON.stringify({
      email: body.email,
      name: body.name,
      password: body.password || randomPassword(),
    }),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : typeof payload?.error === "string" ? payload.error : "user_creation_failed"
    throw new Error(message)
  }

  const userId = typeof payload?.user?.id === "string" ? payload.user.id : null
  if (!userId) {
    throw new Error("user_creation_failed")
  }

  return userId
}

const createUserSchema = {
  email(input: unknown) {
    return typeof input === "string" ? input.trim() : ""
  },
  name(input: unknown) {
    const value = typeof input === "string" ? input.trim() : ""
    return value || "Veslo User"
  },
  platformAdmin(input: unknown) {
    return input === true
  },
  orgId(input: unknown) {
    return typeof input === "string" && input.trim() ? input.trim() : null
  },
  orgRole(input: unknown) {
    return input === "owner" || input === "member" ? input : "member"
  },
}

const updateUserSchema = {
  name(input: unknown) {
    return typeof input === "string" && input.trim() ? input.trim() : null
  },
  platformAdmin(input: unknown) {
    return typeof input === "boolean" ? input : null
  },
}

function pickAuditOrgId(snapshot: AdminSessionSnapshot) {
  return snapshot.activeOrgId ?? snapshot.organizations[0]?.id ?? null
}

async function recordAdminAudit(snapshot: AdminSessionSnapshot, action: string, payload: unknown) {
  const orgId = pickAuditOrgId(snapshot)
  if (!orgId) {
    return
  }

  await recordAuditEvent({
    orgId,
    actorUserId: snapshot.user.id,
    action,
    payload,
  })
}

async function setUserDisabledState(userId: string, disabled: boolean, actorUserId: string) {
  await db.insert(AdminUserStateTable).values({
    id: `aus_${randomBytes(8).toString("hex")}`,
    user_id: userId,
    disabled,
    disabled_at: disabled ? new Date() : null,
    disabled_by_user_id: disabled ? actorUserId : null,
  }).onDuplicateKeyUpdate({
    set: {
      disabled,
      disabled_at: disabled ? sql`CURRENT_TIMESTAMP(3)` : null,
      disabled_by_user_id: disabled ? actorUserId : null,
    },
  })
}

async function ensureAdminRetentionAllowed(userId: string, res: express.Response) {
  const users = await loadAdminUsers()
  const activeAdmins = users.filter((entry) => entry.platformAdmin && entry.disabled !== true)
  const target = activeAdmins.find((entry) => entry.id === userId) ?? null
  if (!target) {
    return true
  }

  if (activeAdmins.length <= 1) {
    res.status(400).json({ error: "cannot_remove_last_platform_admin" })
    return false
  }

  return true
}

async function createAdminUser(req: express.Request, res: express.Response) {
  const snapshot = await requirePlatformAdminSnapshot(req, res)
  if (!snapshot) {
    return null
  }

  const email = createUserSchema.email((req.body ?? {}).email)
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "invalid_email" })
    return null
  }

  const name = createUserSchema.name((req.body ?? {}).name)
  const shouldBePlatformAdmin = createUserSchema.platformAdmin((req.body ?? {}).platformAdmin)
  const orgId = createUserSchema.orgId((req.body ?? {}).orgId)
  const orgRole = createUserSchema.orgRole((req.body ?? {}).orgRole)

  try {
    const userId = await createUserViaAuth(req, { email, name })

    if (shouldBePlatformAdmin) {
      await db.insert(PlatformRoleTable).values({
        id: `prole_${randomBytes(8).toString("hex")}`,
        user_id: userId,
        role: "platform_admin",
      }).onDuplicateKeyUpdate({
        set: {
          user_id: userId,
        },
      })
    }

    if (orgId) {
      const orgRows = await db
        .select({
          id: OrgTable.id,
        })
        .from(OrgTable)
        .where(eq(OrgTable.id, orgId))
        .limit(1)

      if (orgRows.length > 0) {
        const membershipRows = await db
          .select({
            id: OrgMembershipTable.id,
          })
          .from(OrgMembershipTable)
          .where(and(eq(OrgMembershipTable.org_id, orgId), eq(OrgMembershipTable.user_id, userId)))
          .limit(1)

        if (membershipRows.length === 0) {
          await db.insert(OrgMembershipTable).values({
            id: randomUUID(),
            org_id: orgId,
            user_id: userId,
            role: orgRole,
          })
        }
      }
    }

    const users = await loadAdminUsers()
    const created = users.find((entry) => entry.id === userId) ?? null
    if (created) {
      await recordAdminAudit(snapshot, "admin.user.created", {
        createdUserId: userId,
        platformAdmin: shouldBePlatformAdmin,
        orgId,
        orgRole,
      })
    }
    return created
  } catch (error) {
    const message = error instanceof Error ? error.message : "user_creation_failed"
    res.status(400).json({ error: message })
    return null
  }
}

async function updateAdminUser(req: express.Request, res: express.Response) {
  const snapshot = await requirePlatformAdminSnapshot(req, res)
  if (!snapshot) {
    return null
  }

  const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : ""
  if (!userId) {
    res.status(400).json({ error: "invalid_user_id" })
    return null
  }

  const nextName = updateUserSchema.name((req.body ?? {}).name)
  const nextPlatformAdmin = updateUserSchema.platformAdmin((req.body ?? {}).platformAdmin)

  const existing = await db
    .select({
      id: AuthUserTable.id,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)

  if (existing.length === 0) {
    res.status(404).json({ error: "user_not_found" })
    return null
  }

  if (nextName) {
    await db.update(AuthUserTable).set({ name: nextName }).where(eq(AuthUserTable.id, userId))
  }

  if (nextPlatformAdmin !== null) {
    if (nextPlatformAdmin) {
      await db.insert(PlatformRoleTable).values({
        id: `prole_${randomBytes(8).toString("hex")}`,
        user_id: userId,
        role: "platform_admin",
      }).onDuplicateKeyUpdate({
        set: {
          user_id: userId,
        },
      })
    } else {
      if (!(await ensureAdminRetentionAllowed(userId, res))) {
        return null
      }
      await db.delete(PlatformRoleTable).where(and(eq(PlatformRoleTable.user_id, userId), eq(PlatformRoleTable.role, "platform_admin")))
    }
  }

  const users = await loadAdminUsers()
  const updated = users.find((entry) => entry.id === userId) ?? null
  if (updated) {
    await recordAdminAudit(snapshot, "admin.user.updated", {
      targetUserId: userId,
      nameChanged: nextName !== null,
      platformAdmin: nextPlatformAdmin,
    })
  }
  return updated
}

async function disableAdminUser(req: express.Request, res: express.Response) {
  const snapshot = await requirePlatformAdminSnapshot(req, res)
  if (!snapshot) {
    return null
  }

  const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : ""
  if (!userId) {
    res.status(400).json({ error: "invalid_user_id" })
    return null
  }

  if (userId === snapshot.user.id) {
    res.status(400).json({ error: "cannot_disable_self" })
    return null
  }

  const existing = await db
    .select({ id: AuthUserTable.id })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)

  if (existing.length === 0) {
    res.status(404).json({ error: "user_not_found" })
    return null
  }

  if (!(await ensureAdminRetentionAllowed(userId, res))) {
    return null
  }

  await setUserDisabledState(userId, true, snapshot.user.id)
  await db.delete(AuthSessionTable).where(eq(AuthSessionTable.userId, userId))

  const users = await loadAdminUsers()
  const updated = users.find((entry) => entry.id === userId) ?? null
  if (updated) {
    await recordAdminAudit(snapshot, "admin.user.disabled", {
      targetUserId: userId,
    })
  }
  return updated
}

async function enableAdminUser(req: express.Request, res: express.Response) {
  const snapshot = await requirePlatformAdminSnapshot(req, res)
  if (!snapshot) {
    return null
  }

  const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : ""
  if (!userId) {
    res.status(400).json({ error: "invalid_user_id" })
    return null
  }

  const existing = await db
    .select({ id: AuthUserTable.id })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)

  if (existing.length === 0) {
    res.status(404).json({ error: "user_not_found" })
    return null
  }

  await setUserDisabledState(userId, false, snapshot.user.id)

  const users = await loadAdminUsers()
  const updated = users.find((entry) => entry.id === userId) ?? null
  if (updated) {
    await recordAdminAudit(snapshot, "admin.user.enabled", {
      targetUserId: userId,
    })
  }
  return updated
}

async function deleteAdminUser(req: express.Request, res: express.Response) {
  const snapshot = await requirePlatformAdminSnapshot(req, res)
  if (!snapshot) {
    return null
  }

  const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : ""
  if (!userId) {
    res.status(400).json({ error: "invalid_user_id" })
    return null
  }

  if (userId === snapshot.user.id) {
    res.status(400).json({ error: "cannot_delete_self" })
    return null
  }

  const existing = await db
    .select({
      id: AuthUserTable.id,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)

  if (existing.length === 0) {
    res.status(404).json({ error: "user_not_found" })
    return null
  }

  if (!(await ensureAdminRetentionAllowed(userId, res))) {
    return null
  }

  const ownedOrgs = await db
    .select({
      id: OrgTable.id,
    })
    .from(OrgTable)
    .where(eq(OrgTable.owner_user_id, userId))

  const ownedOrgIds = ownedOrgs.map((entry) => entry.id)
  if (ownedOrgIds.length > 0) {
    const membershipCounts = await db
      .select({
        orgId: OrgMembershipTable.org_id,
        total: sql<number>`count(*)`,
      })
      .from(OrgMembershipTable)
      .where(inArray(OrgMembershipTable.org_id, ownedOrgIds))
      .groupBy(OrgMembershipTable.org_id)

    const workerCounts = await db
      .select({
        orgId: WorkerTable.org_id,
        total: sql<number>`count(*)`,
      })
      .from(WorkerTable)
      .where(inArray(WorkerTable.org_id, ownedOrgIds))
      .groupBy(WorkerTable.org_id)

    const hasOtherMembers = membershipCounts.some((row) => Number(row.total) > 1)
    const hasWorkers = workerCounts.some((row) => Number(row.total) > 0)
    if (hasOtherMembers || hasWorkers) {
      res.status(409).json({ error: "user_delete_blocked" })
      return null
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(AuthSessionTable).where(eq(AuthSessionTable.userId, userId))
    await tx.delete(AuthAccountTable).where(eq(AuthAccountTable.userId, userId))
    await tx.delete(DesktopAuthHandoffTable).where(eq(DesktopAuthHandoffTable.user_id, userId))
    await tx.delete(DesktopAuthSessionTable).where(eq(DesktopAuthSessionTable.user_id, userId))
    await tx.delete(DesktopAuthTransactionTable).where(eq(DesktopAuthTransactionTable.user_id, userId))
    await tx.delete(PlatformRoleTable).where(eq(PlatformRoleTable.user_id, userId))
    await tx.delete(AdminUserStateTable).where(eq(AdminUserStateTable.user_id, userId))
    await tx.delete(OrgMembershipTable).where(eq(OrgMembershipTable.user_id, userId))
    if (ownedOrgIds.length > 0) {
      await tx.delete(OrgTable).where(inArray(OrgTable.id, ownedOrgIds))
    }
    await tx.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
  })

  await recordAdminAudit(snapshot, "admin.user.deleted", {
    deletedUserId: userId,
    deletedOwnedOrgCount: ownedOrgIds.length,
  })

  return { ok: true } as const
}

export type CreateAdminRuntimeRouterOptions = {
  managedAi?: RuntimeState | null
}

export function createAdminRuntimeRouter(options: CreateAdminRuntimeRouterOptions = {}) {
  const deps: AdminRouteDeps = {
    getSessionSnapshot: requirePlatformAdminSnapshot,
    listUsers: async (req, res) => {
      const snapshot = await requirePlatformAdminSnapshot(req, res)
      if (!snapshot) {
        return null
      }
      return loadAdminUsers()
    },
    createUser: createAdminUser,
    updateUser: updateAdminUser,
    disableUser: disableAdminUser,
    enableUser: enableAdminUser,
    deleteUser: deleteAdminUser,
  }

  if (options.managedAi) {
    Object.assign(
      deps,
      createManagedAiAdminRouteDeps({
        getAdminSession: requirePlatformAdminSnapshot,
        aiAccess: options.managedAi.aiAccess,
        alerts: options.managedAi.alerts,
        audit: options.managedAi.audit,
        credentials: options.managedAi.credentials,
        leases: options.managedAi.leases,
        secrets: options.managedAi.secrets,
        usage: options.managedAi.usage,
      }),
    )
  }

  return createAdminRouter(deps)
}
