import express from "express"
import { and, eq, inArray, sql } from "drizzle-orm"
import { randomBytes, randomUUID } from "node:crypto"

import { recordAuditEvent } from "../audit.js"
import { db } from "../db/index.js"
import type { DebugLogService } from "../debug-logs/repository.js"
import type { DebugLogLevel, DebugLogSearchFilters } from "../debug-logs/types.js"
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
  OrganizationDomainTable,
  OrganizationInviteTable,
  PlatformRoleTable,
  WorkerTable,
} from "../db/schema.js"
import { env } from "../env.js"
import { isOrganizationAdminRole, toCurrentOrgRole } from "./access.js"
import { readRequestedOrganizationId, resolveMembershipOrganizations, isPlatformAdmin } from "./org-auth.js"
import { requireSession } from "./session.js"
import {
  createAdminRouter,
  getDefaultAdminAllowedPages,
  getDefaultAdminCapabilities,
  type AdminOrganizationDomainRecord,
  type AdminOrganizationInviteRecord,
  type AdminOrganizationMemberRecord,
  type AdminOrganizationRecord,
  type AdminRouteDeps,
  type AdminSessionSnapshot,
  type AdminUserMembership,
  type AdminUserRecord,
} from "./admin.js"
import { createManagedAiAdminRouteDeps } from "../managed-ai/http/admin.js"
import type { RuntimeState } from "../managed-ai/runtime/default-runtime.js"
import {
  OrganizationAdminRepositoryError,
  createOrganizationInvite as createOrganizationInviteRecord,
  createOrActivateOrganizationMembership,
} from "../org-admin/repository.js"
import { hashOrganizationInviteToken } from "../org-admin/invite-token.js"
import { createAdminProvisioningSignupHeaders } from "../auth/admin-provisioning.js"

type ListedUserRow = {
  id: string
  name: string
  email: string
  emailVerified: boolean
}

type AdminOrganizationAccessContext = {
  snapshot: AdminSessionSnapshot
  organization: AdminOrganizationRecord
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

export function canAdminEditOrganizationSeatLimit(input: Pick<AdminSessionSnapshot, "platformAdmin">) {
  return input.platformAdmin === true
}

export function canAdminAccessOrganization(
  snapshot: Pick<AdminSessionSnapshot, "platformAdmin" | "organizations">,
  orgId: string | null | undefined,
) {
  if (!orgId) {
    return false
  }
  if (snapshot.platformAdmin) {
    return true
  }
  return snapshot.organizations.some((entry) => entry.id === orgId && isOrganizationAdminRole(entry.role))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readBodyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function readBodyBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null
}

function hasOwnProperty(input: unknown, key: string) {
  return isRecord(input) && Object.prototype.hasOwnProperty.call(input, key)
}

function readOrgRole(value: unknown): (typeof OrgRole)[number] | null {
  if (value === "owner" || value === "organization_admin") {
    return "organization_admin"
  }
  return value === "member" ? "member" : null
}

export function canAdminUpdateOrganizationSeatLimitPayload(
  input: Pick<AdminSessionSnapshot, "platformAdmin">,
  body: unknown,
) {
  if (!hasOwnProperty(body, "seatLimit")) {
    return true
  }
  return canAdminEditOrganizationSeatLimit(input)
}

export type AdminUserUpdatePayloadScopeResult =
  | { ok: true; role?: (typeof OrgRole)[number] }
  | { ok: false; status: 400 | 403; error: "invalid_role" | "platform_admin_required" }

export function evaluateAdminUserUpdatePayloadScope(
  snapshot: Pick<AdminSessionSnapshot, "platformAdmin">,
  body: unknown,
): AdminUserUpdatePayloadScopeResult {
  if (snapshot.platformAdmin) {
    return { ok: true }
  }

  if (hasOwnProperty(body, "name") || hasOwnProperty(body, "platformAdmin")) {
    return { ok: false, status: 403, error: "platform_admin_required" }
  }

  const source = isRecord(body) ? body : {}
  const role = readOrgRole(source.orgRole ?? source.role)
  if (!role) {
    return { ok: false, status: 400, error: "invalid_role" }
  }

  return { ok: true, role }
}

function readSeatLimit(value: unknown): number | null | "invalid" {
  if (value === null || value === undefined || value === "") {
    return null
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 0) {
    return "invalid"
  }
  return parsed
}

function normalizeOrganizationDomain(value: unknown) {
  const domain = readBodyString(value)?.toLowerCase().replace(/^@+/, "") ?? null
  if (!domain || domain.includes("@") || domain.includes("/") || !domain.includes(".")) {
    return null
  }
  return domain
}

function parseInviteExpiresAt(value: unknown): Date | null | "invalid" {
  if (value === null || value === undefined || value === "") {
    return null
  }
  if (typeof value !== "string") {
    return "invalid"
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed
}

function mapOrganizationRow(row: {
  id: string
  name: string
  slug: string
  ownerUserId: string
  seatLimit: number | null
  createdAt?: Date | null
  updatedAt?: Date | null
}): AdminOrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerUserId: row.ownerUserId,
    seatLimit: row.seatLimit ?? null,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
  }
}

function mapDomainRow(row: typeof OrganizationDomainTable.$inferSelect): AdminOrganizationDomainRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    enabled: row.enabled,
    selfSignupEnabled: row.self_signup_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapInviteRow(row: typeof OrganizationInviteTable.$inferSelect): AdminOrganizationInviteRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: row.accepted_by_user_id,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMemberRow(row: {
  membershipId: string
  userId: string
  name: string
  email: string
  role: (typeof OrgRole)[number]
  status?: "active" | "disabled" | "removed"
  createdAt: Date
}): AdminOrganizationMemberRecord {
  return {
    membershipId: row.membershipId,
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: toCurrentOrgRole(row.role),
    status: row.status,
    createdAt: row.createdAt,
  }
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
      role: toCurrentOrgRole(entry.role),
    })),
  }
}

export async function requireAdminSessionSnapshot(req: express.Request, res: express.Response): Promise<AdminSessionSnapshot | null> {
  const session = await requireSession(req, res)
  if (!session) {
    return null
  }

  const platformAdmin = isBootstrapPlatformAdminEmail(session.user.email) || await isPlatformAdmin(session.user.id)
  const memberships = await resolveMembershipOrganizations(session)
  const visibleOrganizations = platformAdmin
    ? memberships
    : memberships.filter((entry) => isOrganizationAdminRole(entry.role))

  if (!platformAdmin && visibleOrganizations.length === 0) {
    res.status(403).json({ error: "forbidden" })
    return null
  }

  const requestedOrgId = readRequestedOrganizationId(req)
  if (requestedOrgId && !platformAdmin && !visibleOrganizations.some((entry) => entry.id === requestedOrgId)) {
    res.status(403).json({ error: "organization_forbidden" })
    return null
  }

  const requestedVisible = requestedOrgId && visibleOrganizations.some((entry) => entry.id === requestedOrgId)
    ? requestedOrgId
    : null

  return {
    user: session.user,
    platformAdmin,
    activeOrgId: requestedVisible ?? (platformAdmin && requestedOrgId ? requestedOrgId : visibleOrganizations[0]?.id ?? null),
    organizations: visibleOrganizations.map((entry) => ({
      id: entry.id,
      name: entry.name,
      slug: entry.slug,
      ownerUserId: entry.ownerUserId,
      role: toCurrentOrgRole(entry.role),
    })),
    capabilities: getDefaultAdminCapabilities(platformAdmin),
    allowedPages: getDefaultAdminAllowedPages(platformAdmin),
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

async function loadOrganizationRecord(orgId: string): Promise<AdminOrganizationRecord | null> {
  const rows = await db
    .select({
      id: OrgTable.id,
      name: OrgTable.name,
      slug: OrgTable.slug,
      ownerUserId: OrgTable.owner_user_id,
      seatLimit: OrgTable.seat_limit,
      createdAt: OrgTable.created_at,
      updatedAt: OrgTable.updated_at,
    })
    .from(OrgTable)
    .where(eq(OrgTable.id, orgId))
    .limit(1)

  return rows[0] ? mapOrganizationRow(rows[0]) : null
}

async function requireAdminOrganizationAccess(
  req: express.Request,
  res: express.Response,
  options: {
    orgId?: string | null
    snapshot?: AdminSessionSnapshot
  } = {},
): Promise<AdminOrganizationAccessContext | null> {
  const snapshot = options.snapshot ?? await requireAdminSessionSnapshot(req, res)
  if (!snapshot) {
    return null
  }

  const orgId = options.orgId ?? req.params.orgId ?? readRequestedOrganizationId(req) ?? (
    snapshot.platformAdmin
      ? null
      : snapshot.organizations.length === 1
        ? snapshot.organizations[0].id
        : null
  )
  if (!orgId) {
    res.status(400).json({ error: "org_context_required" })
    return null
  }

  if (!canAdminAccessOrganization(snapshot, orgId)) {
    res.status(403).json({ error: "organization_forbidden" })
    return null
  }

  const organization = await loadOrganizationRecord(orgId)
  if (!organization) {
    res.status(snapshot.platformAdmin ? 404 : 403).json({ error: snapshot.platformAdmin ? "organization_not_found" : "organization_forbidden" })
    return null
  }

  return {
    snapshot,
    organization,
  }
}

async function listAdminOrganizationsForSnapshot(snapshot: AdminSessionSnapshot) {
  if (snapshot.platformAdmin) {
    const rows = await db
      .select({
        id: OrgTable.id,
        name: OrgTable.name,
        slug: OrgTable.slug,
        ownerUserId: OrgTable.owner_user_id,
        seatLimit: OrgTable.seat_limit,
        createdAt: OrgTable.created_at,
        updatedAt: OrgTable.updated_at,
      })
      .from(OrgTable)

    return rows.map(mapOrganizationRow)
  }

  const orgIds = snapshot.organizations.map((entry) => entry.id)
  if (orgIds.length === 0) {
    return []
  }

  const rows = await db
    .select({
      id: OrgTable.id,
      name: OrgTable.name,
      slug: OrgTable.slug,
      ownerUserId: OrgTable.owner_user_id,
      seatLimit: OrgTable.seat_limit,
      createdAt: OrgTable.created_at,
      updatedAt: OrgTable.updated_at,
    })
    .from(OrgTable)
    .where(inArray(OrgTable.id, orgIds))

  return rows.map(mapOrganizationRow)
}

async function loadOrganizationMember(orgId: string, membershipId: string) {
  const rows = await db
    .select({
      membershipId: OrgMembershipTable.id,
      userId: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      role: OrgMembershipTable.role,
      status: OrgMembershipTable.status,
      createdAt: OrgMembershipTable.created_at,
    })
    .from(OrgMembershipTable)
    .innerJoin(AuthUserTable, eq(OrgMembershipTable.user_id, AuthUserTable.id))
    .where(and(eq(OrgMembershipTable.org_id, orgId), eq(OrgMembershipTable.id, membershipId)))
    .limit(1)

  return rows[0] ? mapMemberRow(rows[0]) : null
}

async function loadOrganizationMemberByUserId(orgId: string, userId: string) {
  const rows = await db
    .select({
      membershipId: OrgMembershipTable.id,
      userId: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      role: OrgMembershipTable.role,
      status: OrgMembershipTable.status,
      createdAt: OrgMembershipTable.created_at,
    })
    .from(OrgMembershipTable)
    .innerJoin(AuthUserTable, eq(OrgMembershipTable.user_id, AuthUserTable.id))
    .where(and(eq(OrgMembershipTable.org_id, orgId), eq(OrgMembershipTable.user_id, userId)))
    .limit(1)

  return rows[0] ? mapMemberRow(rows[0]) : null
}

async function loadOrganizationMembers(orgId: string) {
  const rows = await db
    .select({
      membershipId: OrgMembershipTable.id,
      userId: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      role: OrgMembershipTable.role,
      status: OrgMembershipTable.status,
      createdAt: OrgMembershipTable.created_at,
    })
    .from(OrgMembershipTable)
    .innerJoin(AuthUserTable, eq(OrgMembershipTable.user_id, AuthUserTable.id))
    .where(eq(OrgMembershipTable.org_id, orgId))

  return rows.map(mapMemberRow)
}

async function loadAdminUsersForOrganization(org: AdminOrganizationRecord) {
  const rows = await db
    .select({
      id: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      emailVerified: AuthUserTable.emailVerified,
      membershipId: OrgMembershipTable.id,
      role: OrgMembershipTable.role,
    })
    .from(OrgMembershipTable)
    .innerJoin(AuthUserTable, eq(OrgMembershipTable.user_id, AuthUserTable.id))
    .where(eq(OrgMembershipTable.org_id, org.id))

  const userIds = rows.map((entry) => entry.id)
  const [platformAdmins, disabledUsers] = await Promise.all([
    loadPlatformAdminUserIds(userIds),
    loadUserDisabledState(userIds),
  ])

  return rows.map((entry): AdminUserRecord => ({
    id: entry.id,
    name: entry.name,
    email: entry.email,
    emailVerified: entry.emailVerified,
    platformAdmin: platformAdmins.has(entry.id) || isBootstrapPlatformAdminEmail(entry.email),
    disabled: disabledUsers.has(entry.id),
    memberships: [{
      membershipId: entry.membershipId,
      orgId: org.id,
      orgName: org.name,
      orgSlug: org.slug,
      role: toCurrentOrgRole(entry.role),
    }],
  }))
}

async function pickReplacementOrganizationAdminUserId(orgId: string, excludedUserId: string) {
  const rows = await db
    .select({
      userId: OrgMembershipTable.user_id,
    })
    .from(OrgMembershipTable)
    .where(and(
      eq(OrgMembershipTable.org_id, orgId),
      eq(OrgMembershipTable.role, "organization_admin"),
      sql`${OrgMembershipTable.user_id} <> ${excludedUserId}`,
    ))
    .limit(1)

  return rows[0]?.userId ?? null
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
      ...createAdminProvisioningSignupHeaders(),
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
    if (input === "organization_admin" || input === "owner") {
      return "organization_admin"
    }
    return input === "member" ? input : "member"
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

async function recordAdminOrganizationAudit(snapshot: AdminSessionSnapshot, orgId: string, action: string, payload: unknown) {
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

async function listAdminOrganizations(req: express.Request, res: express.Response) {
  const snapshot = await requireAdminSessionSnapshot(req, res)
  if (!snapshot) {
    return null
  }

  return {
    organizations: await listAdminOrganizationsForSnapshot(snapshot),
  }
}

async function getAdminOrganization(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  return {
    organization: context.organization,
  }
}

async function updateAdminOrganization(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  if (hasOwnProperty(req.body, "seatLimit")) {
    if (!canAdminUpdateOrganizationSeatLimitPayload(context.snapshot, req.body)) {
      res.status(403).json({ error: "seat_limit_platform_admin_required" })
      return null
    }

    const seatLimit = readSeatLimit((req.body ?? {}).seatLimit)
    if (seatLimit === "invalid") {
      res.status(400).json({ error: "invalid_seat_limit" })
      return null
    }

    await db
      .update(OrgTable)
      .set({ seat_limit: seatLimit })
      .where(eq(OrgTable.id, context.organization.id))

    await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "admin.organization.updated", {
      seatLimit,
    })
  }

  const organization = await loadOrganizationRecord(context.organization.id)
  if (!organization) {
    res.status(404).json({ error: "organization_not_found" })
    return null
  }

  return { organization }
}

async function listAdminOrganizationMembers(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  return {
    members: await loadOrganizationMembers(context.organization.id),
  }
}

async function createAdminOrganizationMember(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const email = readBodyString((req.body ?? {}).email)
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "invalid_email" })
    return null
  }

  const role = readOrgRole((req.body ?? {}).role) ?? "member"
  const userRows = await db
    .select({
      id: AuthUserTable.id,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.email, email))
    .limit(1)

  const user = userRows[0] ?? null
  if (!user) {
    res.status(404).json({ error: "user_not_found" })
    return null
  }

  const existing = await loadOrganizationMemberByUserId(context.organization.id, user.id)
  if (existing) {
    res.status(409).json({ error: "membership_exists" })
    return null
  }

  const membershipId = randomUUID()
  try {
    await createOrActivateOrganizationMembership({
      membershipId,
      orgId: context.organization.id,
      userId: user.id,
      role,
    })
  } catch (error) {
    if (error instanceof OrganizationAdminRepositoryError && error.code === "seat_limit_reached") {
      res.status(409).json({ error: "seat_limit_reached" })
      return null
    }
    throw error
  }

  const member = await loadOrganizationMember(context.organization.id, membershipId)
  if (!member) {
    res.status(500).json({ error: "membership_creation_failed" })
    return null
  }

  await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.member.added", {
    membershipId,
    userId: user.id,
    role,
    via: context.snapshot.platformAdmin ? "platform_admin" : "organization_admin",
  })

  return { member }
}

async function updateAdminOrganizationMember(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const role = readOrgRole((req.body ?? {}).role)
  if (!role) {
    res.status(400).json({ error: "invalid_role" })
    return null
  }

  const target = await loadOrganizationMember(context.organization.id, req.params.memberId)
  if (!target) {
    res.status(404).json({ error: "membership_not_found" })
    return null
  }

  const replacementOwnerUserId =
    target.userId === context.organization.ownerUserId && role !== "organization_admin"
      ? await pickReplacementOrganizationAdminUserId(context.organization.id, target.userId)
      : null

  await db.transaction(async (tx) => {
    await tx
      .update(OrgMembershipTable)
      .set({ role })
      .where(eq(OrgMembershipTable.id, target.membershipId))

    if (replacementOwnerUserId) {
      await tx
        .update(OrgTable)
        .set({ owner_user_id: replacementOwnerUserId })
        .where(eq(OrgTable.id, context.organization.id))
    }
  })

  const member = await loadOrganizationMember(context.organization.id, target.membershipId)
  if (!member) {
    res.status(500).json({ error: "membership_update_failed" })
    return null
  }

  await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.member.role_updated", {
    membershipId: target.membershipId,
    userId: target.userId,
    previousRole: target.role,
    nextRole: role,
    via: context.snapshot.platformAdmin ? "platform_admin" : "organization_admin",
  })

  return { member }
}

async function deleteAdminOrganizationMember(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const target = await loadOrganizationMember(context.organization.id, req.params.memberId)
  if (!target) {
    res.status(404).json({ error: "membership_not_found" })
    return null
  }

  const replacementOwnerUserId =
    target.userId === context.organization.ownerUserId && target.role === "organization_admin"
      ? await pickReplacementOrganizationAdminUserId(context.organization.id, target.userId)
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

  await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.member.removed", {
    membershipId: target.membershipId,
    userId: target.userId,
    role: target.role,
    via: context.snapshot.platformAdmin ? "platform_admin" : "organization_admin",
  })

  return { ok: true } as const
}

async function listAdminOrganizationDomains(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const rows = await db
    .select()
    .from(OrganizationDomainTable)
    .where(eq(OrganizationDomainTable.org_id, context.organization.id))

  return {
    domains: rows.map(mapDomainRow),
  }
}

async function createAdminOrganizationDomain(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const domain = normalizeOrganizationDomain((req.body ?? {}).domain)
  if (!domain) {
    res.status(400).json({ error: "invalid_domain" })
    return null
  }

  const existing = await db
    .select({ id: OrganizationDomainTable.id })
    .from(OrganizationDomainTable)
    .where(eq(OrganizationDomainTable.domain, domain))
    .limit(1)
  if (existing.length > 0) {
    res.status(409).json({ error: "domain_exists" })
    return null
  }

  const enabled = readBodyBoolean((req.body ?? {}).enabled) ?? true
  const selfSignupEnabled = readBodyBoolean((req.body ?? {}).selfSignupEnabled) ?? false
  const domainId = `domain_${randomBytes(8).toString("hex")}`

  await db.insert(OrganizationDomainTable).values({
    id: domainId,
    org_id: context.organization.id,
    domain,
    enabled,
    self_signup_enabled: selfSignupEnabled,
  })

  const rows = await db
    .select()
    .from(OrganizationDomainTable)
    .where(eq(OrganizationDomainTable.id, domainId))
    .limit(1)

  const created = rows[0] ? mapDomainRow(rows[0]) : null
  if (!created) {
    res.status(500).json({ error: "domain_creation_failed" })
    return null
  }

  await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.domain.created", {
    domainId,
    domain,
    enabled,
    selfSignupEnabled,
  })

  return { domain: created }
}

async function updateAdminOrganizationDomain(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const domainId = readBodyString(req.params.domainId)
  if (!domainId) {
    res.status(400).json({ error: "invalid_domain_id" })
    return null
  }

  const existing = await db
    .select()
    .from(OrganizationDomainTable)
    .where(and(eq(OrganizationDomainTable.org_id, context.organization.id), eq(OrganizationDomainTable.id, domainId)))
    .limit(1)
  if (!existing[0]) {
    res.status(404).json({ error: "domain_not_found" })
    return null
  }

  const update: Partial<typeof OrganizationDomainTable.$inferInsert> = {}
  const nextDomain = hasOwnProperty(req.body, "domain") ? normalizeOrganizationDomain((req.body ?? {}).domain) : null
  if (hasOwnProperty(req.body, "domain")) {
    if (!nextDomain) {
      res.status(400).json({ error: "invalid_domain" })
      return null
    }
    if (nextDomain !== existing[0].domain) {
      const duplicate = await db
        .select({ id: OrganizationDomainTable.id })
        .from(OrganizationDomainTable)
        .where(eq(OrganizationDomainTable.domain, nextDomain))
        .limit(1)
      if (duplicate.length > 0) {
        res.status(409).json({ error: "domain_exists" })
        return null
      }
      update.domain = nextDomain
    }
  }

  const enabled = hasOwnProperty(req.body, "enabled") ? readBodyBoolean((req.body ?? {}).enabled) : null
  if (hasOwnProperty(req.body, "enabled")) {
    if (enabled === null) {
      res.status(400).json({ error: "invalid_enabled" })
      return null
    }
    update.enabled = enabled
  }

  const selfSignupEnabled = hasOwnProperty(req.body, "selfSignupEnabled") ? readBodyBoolean((req.body ?? {}).selfSignupEnabled) : null
  if (hasOwnProperty(req.body, "selfSignupEnabled")) {
    if (selfSignupEnabled === null) {
      res.status(400).json({ error: "invalid_self_signup_enabled" })
      return null
    }
    update.self_signup_enabled = selfSignupEnabled
  }

  if (Object.keys(update).length > 0) {
    await db
      .update(OrganizationDomainTable)
      .set(update)
      .where(and(eq(OrganizationDomainTable.org_id, context.organization.id), eq(OrganizationDomainTable.id, domainId)))

    await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.domain.updated", {
      domainId,
      changedFields: Object.keys(update),
    })
  }

  const rows = await db
    .select()
    .from(OrganizationDomainTable)
    .where(eq(OrganizationDomainTable.id, domainId))
    .limit(1)

  return {
    domain: mapDomainRow(rows[0]),
  }
}

async function deleteAdminOrganizationDomain(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const domainId = readBodyString(req.params.domainId)
  if (!domainId) {
    res.status(400).json({ error: "invalid_domain_id" })
    return null
  }

  const existing = await db
    .select({ id: OrganizationDomainTable.id, domain: OrganizationDomainTable.domain })
    .from(OrganizationDomainTable)
    .where(and(eq(OrganizationDomainTable.org_id, context.organization.id), eq(OrganizationDomainTable.id, domainId)))
    .limit(1)
  if (!existing[0]) {
    res.status(404).json({ error: "domain_not_found" })
    return null
  }

  await db
    .delete(OrganizationDomainTable)
    .where(and(eq(OrganizationDomainTable.org_id, context.organization.id), eq(OrganizationDomainTable.id, domainId)))

  await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.domain.deleted", {
    domainId,
    domain: existing[0].domain,
  })

  return { ok: true } as const
}

async function listAdminOrganizationInvites(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const rows = await db
    .select()
    .from(OrganizationInviteTable)
    .where(eq(OrganizationInviteTable.org_id, context.organization.id))

  return {
    invites: rows.map(mapInviteRow),
  }
}

async function createAdminOrganizationInvite(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const email = readBodyString((req.body ?? {}).email)
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "invalid_email" })
    return null
  }

  const role = readOrgRole((req.body ?? {}).role) ?? "member"
  const expiresAt = parseInviteExpiresAt((req.body ?? {}).expiresAt)
  if (expiresAt === "invalid") {
    res.status(400).json({ error: "invalid_expires_at" })
    return null
  }

  const inviteToken = randomBytes(24).toString("base64url")

  try {
    const invite = await createOrganizationInviteRecord({
      orgId: context.organization.id,
      email,
      role,
      tokenHash: hashOrganizationInviteToken(inviteToken),
      invitedByUserId: context.snapshot.user.id,
      expiresAt,
    })

    await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.invite.created", {
      inviteId: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
    })

    return {
      invite: {
        id: invite.id,
        orgId: invite.orgId,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        invitedByUserId: invite.invitedByUserId,
        acceptedByUserId: invite.acceptedByUserId,
        expiresAt: invite.expiresAt,
        acceptedAt: invite.acceptedAt,
        revokedAt: invite.revokedAt,
        createdAt: invite.createdAt,
        updatedAt: invite.updatedAt,
      },
      inviteToken,
    }
  } catch (error) {
    if (error instanceof OrganizationAdminRepositoryError && error.code === "domain_not_allowed") {
      res.status(400).json({ error: "invalid_email" })
      return null
    }
    throw error
  }
}

async function revokeAdminOrganizationInvite(req: express.Request, res: express.Response) {
  const context = await requireAdminOrganizationAccess(req, res, {
    orgId: req.params.orgId,
  })
  if (!context) {
    return null
  }

  const inviteId = readBodyString(req.params.inviteId)
  if (!inviteId) {
    res.status(400).json({ error: "invalid_invite_id" })
    return null
  }

  const rows = await db
    .select()
    .from(OrganizationInviteTable)
    .where(and(eq(OrganizationInviteTable.org_id, context.organization.id), eq(OrganizationInviteTable.id, inviteId)))
    .limit(1)
  const invite = rows[0] ?? null
  if (!invite) {
    res.status(404).json({ error: "invite_not_found" })
    return null
  }
  if (invite.status === "accepted") {
    res.status(409).json({ error: "invite_already_accepted" })
    return null
  }

  if (invite.status !== "revoked") {
    const revokedAt = new Date()
    await db
      .update(OrganizationInviteTable)
      .set({
        status: "revoked",
        revoked_at: revokedAt,
        updated_at: revokedAt,
      })
      .where(and(eq(OrganizationInviteTable.org_id, context.organization.id), eq(OrganizationInviteTable.id, inviteId)))

    await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.invite.revoked", {
      inviteId,
      email: invite.email,
    })
  }

  const updatedRows = await db
    .select()
    .from(OrganizationInviteTable)
    .where(eq(OrganizationInviteTable.id, inviteId))
    .limit(1)

  return {
    invite: mapInviteRow(updatedRows[0]),
  }
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
          await createOrActivateOrganizationMembership({
            membershipId: randomUUID(),
            orgId,
            userId,
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
  const snapshot = await requireAdminSessionSnapshot(req, res)
  if (!snapshot) {
    return null
  }

  const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : ""
  if (!userId) {
    res.status(400).json({ error: "invalid_user_id" })
    return null
  }

  if (!snapshot.platformAdmin) {
    const payloadScope = evaluateAdminUserUpdatePayloadScope(snapshot, req.body)
    if (!payloadScope.ok) {
      res.status(payloadScope.status).json({ error: payloadScope.error })
      return null
    }
    const role = "role" in payloadScope ? payloadScope.role : null
    if (!role) {
      res.status(400).json({ error: "invalid_role" })
      return null
    }

    const requestedOrgId = readBodyString((req.body ?? {}).orgId) ?? readRequestedOrganizationId(req)
    const context = await requireAdminOrganizationAccess(req, res, {
      snapshot,
      orgId: requestedOrgId,
    })
    if (!context) {
      return null
    }

    const target = await loadOrganizationMemberByUserId(context.organization.id, userId)
    if (!target) {
      res.status(404).json({ error: "membership_not_found" })
      return null
    }

    await db.update(OrgMembershipTable).set({ role }).where(eq(OrgMembershipTable.id, target.membershipId))

    await recordAdminOrganizationAudit(snapshot, context.organization.id, "org.member.role_updated", {
      membershipId: target.membershipId,
      userId: target.userId,
      previousRole: target.role,
      nextRole: role,
      via: "organization_admin",
    })

    const users = await loadAdminUsersForOrganization(context.organization)
    return users.find((entry) => entry.id === userId) ?? null
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
  debugLogs?: DebugLogService | null
}

function readQueryString(value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim()
  }
  if (Array.isArray(value)) {
    return readQueryString(value[0])
  }
  return undefined
}

function readQueryDate(value: unknown) {
  const raw = readQueryString(value)
  if (!raw) return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function readQueryLimit(value: unknown) {
  const raw = readQueryString(value)
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 1000) : undefined
}

function readDebugLogLevel(value: unknown): DebugLogLevel | undefined {
  const raw = readQueryString(value)
  return raw === "info" || raw === "warn" || raw === "error" ? raw : undefined
}

function readDebugLogFilters(req: express.Request): DebugLogSearchFilters {
  return {
    userId: readQueryString(req.query.userId),
    orgId: readQueryString(req.query.orgId),
    workspaceId: readQueryString(req.query.workspaceId),
    sessionId: readQueryString(req.query.sessionId),
    runId: readQueryString(req.query.runId),
    source: readQueryString(req.query.source),
    stream: readQueryString(req.query.stream),
    level: readDebugLogLevel(req.query.level),
    from: readQueryDate(req.query.from),
    to: readQueryDate(req.query.to),
    limit: readQueryLimit(req.query.limit),
  }
}

function createDebugLogAdminRouteDeps(debugLogs: DebugLogService | null | undefined): Pick<
  AdminRouteDeps,
  "listDebugLogs" | "getDebugLog" | "exportDebugLogs"
> {
  async function requireDebugLogAccess(req: express.Request, res: express.Response) {
    const snapshot = await requirePlatformAdminSnapshot(req, res)
    if (!snapshot) {
      return false
    }
    if (!debugLogs) {
      res.status(503).json({ error: "debug_logs_not_configured" })
      return false
    }
    return true
  }

  return {
    async listDebugLogs(req, res) {
      if (!await requireDebugLogAccess(req, res)) {
        return null
      }
      return debugLogs!.searchLogs(readDebugLogFilters(req))
    },

    async getDebugLog(req, res) {
      if (!await requireDebugLogAccess(req, res)) {
        return null
      }
      const event = await debugLogs!.getLog(req.params.eventId)
      if (!event) {
        res.status(404).json({ error: "debug_log_not_found" })
        return null
      }
      return { event }
    },

    async exportDebugLogs(req, res) {
      if (!await requireDebugLogAccess(req, res)) {
        return null
      }
      const events = await debugLogs!.exportLogs(readDebugLogFilters(req))
      const body = events.map((event) => JSON.stringify(event)).join("\n")
      return {
        filename: "debug-logs.jsonl",
        body: body.length > 0 ? `${body}\n` : "",
      }
    },
  }
}

export function createAdminRuntimeRouter(options: CreateAdminRuntimeRouterOptions = {}) {
  const deps: AdminRouteDeps = {
    getSessionSnapshot: requireAdminSessionSnapshot,
    listOrganizations: listAdminOrganizations,
    getOrganization: getAdminOrganization,
    updateOrganization: updateAdminOrganization,
    listOrganizationMembers: listAdminOrganizationMembers,
    createOrganizationMember: createAdminOrganizationMember,
    updateOrganizationMember: updateAdminOrganizationMember,
    deleteOrganizationMember: deleteAdminOrganizationMember,
    listOrganizationDomains: listAdminOrganizationDomains,
    createOrganizationDomain: createAdminOrganizationDomain,
    updateOrganizationDomain: updateAdminOrganizationDomain,
    deleteOrganizationDomain: deleteAdminOrganizationDomain,
    listOrganizationInvites: listAdminOrganizationInvites,
    createOrganizationInvite: createAdminOrganizationInvite,
    revokeOrganizationInvite: revokeAdminOrganizationInvite,
    listUsers: async (req, res) => {
      const snapshot = await requireAdminSessionSnapshot(req, res)
      if (!snapshot) {
        return null
      }
      if (snapshot.platformAdmin) {
        return loadAdminUsers()
      }

      const context = await requireAdminOrganizationAccess(req, res, { snapshot })
      if (!context) {
        return null
      }

      return loadAdminUsersForOrganization(context.organization)
    },
    createUser: createAdminUser,
    updateUser: updateAdminUser,
    disableUser: disableAdminUser,
    enableUser: enableAdminUser,
    deleteUser: deleteAdminUser,
    ...createDebugLogAdminRouteDeps(options.debugLogs),
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
        codexStatusProvider: options.managedAi.codexStatusProvider,
      }),
    )
  }

  return createAdminRouter(deps)
}
