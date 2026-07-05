import express from "express"
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
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
  OrganizationBillingMode,
  OrganizationBillingSource,
  OrganizationBillingStatus,
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
import { readRequestedOrganizationId, resolveUserOrganizations, isPlatformAdmin } from "./org-auth.js"
import { requireSession } from "./session.js"
import {
  createAdminRouter,
  getDefaultAdminAllowedPages,
  getDefaultAdminCapabilities,
  type AdminOrganizationBillingAccountRecord,
  type AdminOrganizationBillingResponse,
  type AdminOrganizationDomainRecord,
  type AdminOrganizationInviteRecord,
  type AdminOrganizationMemberRecord,
  type AdminOrganizationRecord,
  type AdminRouteDeps,
  type AdminSessionSnapshot,
  type AdminUserMembership,
  type AdminUserRecord,
} from "./admin.js"
import type {
  OrganizationBillingMode as OrganizationBillingModeValue,
  OrganizationBillingQuantities,
  OrganizationBillingStatus as OrganizationBillingStatusValue,
} from "../billing/organization-billing.js"
import {
  createDrizzleOrganizationBillingStore,
  createOrganizationBillingRepository,
  OrganizationBillingRepositoryError,
  type OrganizationBillingAccountRecord,
  type OrganizationBillingRepository,
  type OrganizationBillingSource as OrganizationBillingSourceValue,
  type OrganizationBillingTierAllowlistInput,
  type UpsertOrganizationBillingAccountInput,
} from "../billing/repository.js"
import type { OrganizationBillingInterval } from "../billing/stripe-config.js"
import {
  createOrganizationStripeBillingService,
  OrganizationStripeBillingServiceError,
  type ManagedAiBillingQuantities,
  type OrganizationStripeBillingService,
} from "../billing/stripe-service.js"
import { createOrganizationStripeBillingClient } from "../billing/stripe.js"
import { createManagedAiAdminRouteDeps } from "../managed-ai/http/admin.js"
import type { RuntimeState } from "../managed-ai/runtime/default-runtime.js"
import {
  OrganizationAdminRepositoryError,
  createOrganizationInvite as createOrganizationInviteRecord,
  createOrActivateOrganizationMembership,
  extractAffectedRows,
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

export type PlatformAdminRecipient = {
  userId: string
  email: string
  name: string | null
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

export type AdminInviteResendStatusResult =
  | { ok: true }
  | { ok: false; status: 409; error: "invite_already_accepted" | "invite_already_revoked" | "invite_expired" }

export function evaluateAdminInviteResendStatus(
  inviteStatus: (typeof OrganizationInviteTable.$inferSelect)["status"],
  expiresAt: Date | null = null,
  now = new Date(),
): AdminInviteResendStatusResult {
  if (inviteStatus === "pending") {
    if (expiresAt && expiresAt <= now) {
      return { ok: false, status: 409, error: "invite_expired" }
    }
    return { ok: true }
  }
  if (inviteStatus === "accepted") {
    return { ok: false, status: 409, error: "invite_already_accepted" }
  }
  if (inviteStatus === "revoked") {
    return { ok: false, status: 409, error: "invite_already_revoked" }
  }
  return { ok: false, status: 409, error: "invite_expired" }
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

const availableManagedAiBillingTiers = [
  { tier: "managed_ai_basic", key: "basic", name: "Basic" },
  { tier: "managed_ai_extended", key: "extended", name: "Extended" },
] as const

const allowedPlatformBillingTiers = new Set(["managed_ai_basic", "managed_ai_extended", "local_models", "manual_access"])

function toIsoString(value: Date | string | null | undefined) {
  if (!value) {
    return null
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

function serializePaymentProblemMessage(value: string | null) {
  return typeof value === "string" && value.trim().length > 0 ? "Payment issue" : null
}

function serializeOrganizationBillingAccount(
  account: OrganizationBillingAccountRecord | null,
): AdminOrganizationBillingAccountRecord | null {
  if (!account) {
    return null
  }

  return {
    id: account.id,
    orgId: account.orgId,
    mode: account.mode,
    source: account.source,
    status: account.status,
    billingInterval: account.billingInterval,
    quantities: {
      managedAiBasic: account.managedAiBasicQuantity,
      managedAiExtended: account.managedAiExtendedQuantity,
      localModels: account.localModelsQuantity,
    },
    manualAccess: {
      enabled: account.manualAccessEnabled,
      expiresAt: toIsoString(account.manualAccessExpiresAt),
    },
    localModels: {
      unitAmount: account.localModelsUnitAmount,
      currency: account.localModelsCurrency,
    },
    stripe: {
      customerConfigured: Boolean(account.stripeCustomerId),
      subscriptionConfigured: Boolean(account.stripeSubscriptionId),
    },
    paymentProblem: {
      code: account.paymentProblemCode,
      message: serializePaymentProblemMessage(account.paymentProblemMessage),
    },
    graceUntil: toIsoString(account.graceUntil),
    cancelAtPeriodEnd: account.cancelAtPeriodEnd,
    createdAt: toIsoString(account.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(account.updatedAt) ?? new Date(0).toISOString(),
  }
}

async function getOrganizationBillingSummary(
  repository: OrganizationBillingRepository,
  orgId: string,
): Promise<AdminOrganizationBillingResponse> {
  const [account, entitlement, allowedTiers] = await Promise.all([
    repository.getBillingAccount(orgId),
    repository.deriveEntitlement(orgId),
    repository.listAllowedTiers(orgId),
  ])

  return {
    billing: {
      account: serializeOrganizationBillingAccount(account),
      entitlement,
      allowedTiers: allowedTiers.map((entry) => ({
        tier: entry.tier,
        enabled: entry.enabled,
      })),
      activeUserCount: entitlement.activeUserCount,
      licenseLimit: entitlement.licenseLimit,
      availableManagedAiTiers: [...availableManagedAiBillingTiers],
    },
  }
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null
  }
  return parsed
}

function bodyContainsStripePriceSelection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return [
    "priceId",
    "priceIds",
    "stripePriceId",
    "stripePriceIds",
    "basicPriceId",
    "extendedPriceId",
  ].some((key) => hasOwnProperty(value, key))
}

function readManagedAiBillingQuantities(
  body: unknown,
  res: express.Response,
  options: { requireAny: boolean },
): ManagedAiBillingQuantities | null {
  if (bodyContainsStripePriceSelection(body) || bodyContainsStripePriceSelection(isRecord(body) ? body.quantities : null)) {
    res.status(400).json({ error: "stripe_price_id_not_allowed" })
    return null
  }

  const source = isRecord(body) && isRecord(body.quantities) ? body.quantities : body
  const managedAiBasic = readNonNegativeInteger(isRecord(source) ? source.managedAiBasic : undefined)
  const managedAiExtended = readNonNegativeInteger(isRecord(source) ? source.managedAiExtended : undefined)
  if (managedAiBasic === null || managedAiExtended === null) {
    res.status(400).json({ error: "invalid_billing_quantities" })
    return null
  }
  if (options.requireAny && managedAiBasic <= 0 && managedAiExtended <= 0) {
    res.status(400).json({ error: "managed_ai_quantity_required" })
    return null
  }

  return { managedAiBasic, managedAiExtended }
}

function readBillingInterval(value: unknown): OrganizationBillingInterval | null {
  if (value === undefined || value === null || value === "") {
    return "monthly"
  }
  return value === "monthly" || value === "annual" ? value : null
}

function readBillingMode(value: unknown): OrganizationBillingModeValue | null {
  return typeof value === "string" && OrganizationBillingMode.includes(value as OrganizationBillingModeValue)
    ? value as OrganizationBillingModeValue
    : null
}

function readBillingStatus(value: unknown): OrganizationBillingStatusValue | null {
  return typeof value === "string" && OrganizationBillingStatus.includes(value as OrganizationBillingStatusValue)
    ? value as OrganizationBillingStatusValue
    : null
}

function readBillingSource(value: unknown): OrganizationBillingSourceValue | null {
  return typeof value === "string" && OrganizationBillingSource.includes(value as OrganizationBillingSourceValue)
    ? value as OrganizationBillingSourceValue
    : null
}

function readNullableBillingDate(value: unknown): Date | null | "invalid" {
  if (value === undefined || value === null || value === "") {
    return null
  }
  if (typeof value !== "string") {
    return "invalid"
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed
}

function readNullableCurrency(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") {
    return null
  }
  if (typeof value !== "string") {
    return "invalid"
  }
  const normalized = value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(normalized) ? normalized : "invalid"
}

function readOptionalNonNegativeInteger(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") {
    return null
  }
  return readNonNegativeInteger(value) ?? "invalid"
}

function readPlatformAllowlist(value: unknown): OrganizationBillingTierAllowlistInput[] | null | "invalid" {
  if (value === undefined) {
    return null
  }
  if (!Array.isArray(value)) {
    return "invalid"
  }

  const tiers: OrganizationBillingTierAllowlistInput[] = []
  for (const entry of value) {
    const tier = typeof entry === "string" ? entry.trim() : isRecord(entry) && typeof entry.tier === "string" ? entry.tier.trim() : ""
    const enabled = typeof entry === "string" ? true : isRecord(entry) && typeof entry.enabled === "boolean" ? entry.enabled : null
    if (!tier || enabled === null || !allowedPlatformBillingTiers.has(tier)) {
      return "invalid"
    }
    tiers.push({ tier, enabled })
  }
  return tiers
}

function billingErrorStatus(error: OrganizationBillingRepositoryError | OrganizationStripeBillingServiceError) {
  if (error instanceof OrganizationBillingRepositoryError) {
    return error.code === "requested_license_limit_below_active_users" ? 409 : 400
  }

  if (error.code === "stripe_billing_disabled") {
    return 503
  }
  if (error.code === "stripe_customer_required" || error.code === "stripe_subscription_required") {
    return 409
  }
  if (error.code === "tier_not_allowed" || error.code === "managed_ai_quantity_required") {
    return 400
  }
  return 400
}

function sendBillingError(error: unknown, res: express.Response) {
  if (error instanceof OrganizationBillingRepositoryError || error instanceof OrganizationStripeBillingServiceError) {
    res.status(billingErrorStatus(error)).json({ error: error.code, details: error.details ?? undefined })
    return true
  }
  return false
}

function readRequestOrigin(req: express.Request) {
  const headerOrigin = normalizeHeaderOrigin(req.header("origin"))
  if (headerOrigin) {
    return headerOrigin
  }

  const referer = req.header("referer")
  if (!referer) {
    return null
  }
  try {
    return new URL(referer).origin
  } catch {
    return null
  }
}

function normalizeHeaderOrigin(value: string | undefined) {
  if (!value) {
    return null
  }
  try {
    return new URL(value).origin
  } catch {
    return null
  }
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

  const organizations = await resolveUserOrganizations(session.user.id)

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
  const memberships = await resolveUserOrganizations(session.user.id)
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

export async function listActivePlatformAdminRecipients(): Promise<PlatformAdminRecipient[]> {
  const users = await loadAdminUsers()
  return users
    .filter((entry) => entry.platformAdmin && entry.disabled !== true && entry.email)
    .map((entry) => ({
      userId: entry.id,
      email: entry.email.trim().toLowerCase(),
      name: entry.name?.trim() || null,
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
    res.status(snapshot.platformAdmin ? 404 : 403).json({
      error: snapshot.platformAdmin ? "organization_not_found" : "organization_forbidden",
    })
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
  orgId(input: unknown) {
    return readBodyString(input)
  },
  orgRole(input: unknown) {
    return readOrgRole(input)
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

  const nextName = hasOwnProperty(req.body, "name")
    ? readBodyString((req.body ?? {}).name)
    : context.organization.name
  const nextSlug = hasOwnProperty(req.body, "slug")
    ? readBodyString((req.body ?? {}).slug)
    : context.organization.slug
  let seatLimit = context.organization.seatLimit
  const changedFields: string[] = []

  if (hasOwnProperty(req.body, "name")) {
    if (!nextName) {
      res.status(400).json({ error: "invalid_organization_name" })
      return null
    }
    changedFields.push("name")
  }

  if (hasOwnProperty(req.body, "slug")) {
    if (!nextSlug) {
      res.status(400).json({ error: "invalid_organization_slug" })
      return null
    }
    changedFields.push("slug")
  }

  if (hasOwnProperty(req.body, "seatLimit")) {
    if (!canAdminUpdateOrganizationSeatLimitPayload(context.snapshot, req.body)) {
      res.status(403).json({ error: "seat_limit_platform_admin_required" })
      return null
    }

    const parsedSeatLimit = readSeatLimit((req.body ?? {}).seatLimit)
    if (parsedSeatLimit === "invalid") {
      res.status(400).json({ error: "invalid_seat_limit" })
      return null
    }

    seatLimit = parsedSeatLimit
    changedFields.push("seatLimit")
  }

  if (changedFields.length > 0) {
    const persistedName = nextName ?? context.organization.name
    const persistedSlug = nextSlug ?? context.organization.slug

    await db
      .update(OrgTable)
      .set({ name: persistedName, slug: persistedSlug, seat_limit: seatLimit })
      .where(eq(OrgTable.id, context.organization.id))

    await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "admin.organization.updated", {
      changedFields,
      name: persistedName,
      slug: persistedSlug,
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

type OrganizationBillingAdminRouteDepsInput = {
  repository: OrganizationBillingRepository
  stripeService: OrganizationStripeBillingService | null
  requireOrganizationAccess?: typeof requireAdminOrganizationAccess
  requirePlatformAdmin?: typeof requirePlatformAdminSnapshot
  recordOrganizationAudit?: typeof recordAdminOrganizationAudit
}

function readOptionalBillingInterval(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") {
    return null
  }
  return value === "monthly" || value === "annual" ? value : "invalid"
}

function readMergedPlatformQuantities(
  body: Record<string, unknown>,
  existing: OrganizationBillingAccountRecord | null,
  res: express.Response,
): OrganizationBillingQuantities | null {
  const source = isRecord(body.quantities) ? body.quantities : {}
  const current = {
    managedAiBasic: existing?.managedAiBasicQuantity ?? 0,
    managedAiExtended: existing?.managedAiExtendedQuantity ?? 0,
    localModels: existing?.localModelsQuantity ?? 0,
  }

  const managedAiBasic = hasOwnProperty(source, "managedAiBasic")
    ? readNonNegativeInteger(source.managedAiBasic)
    : current.managedAiBasic
  const managedAiExtended = hasOwnProperty(source, "managedAiExtended")
    ? readNonNegativeInteger(source.managedAiExtended)
    : current.managedAiExtended
  const localModels = hasOwnProperty(source, "localModels")
    ? readNonNegativeInteger(source.localModels)
    : current.localModels

  if (managedAiBasic === null || managedAiExtended === null || localModels === null) {
    res.status(400).json({ error: "invalid_billing_quantities" })
    return null
  }

  return { managedAiBasic, managedAiExtended, localModels }
}

function readPlatformBillingUpdate(
  body: unknown,
  existing: OrganizationBillingAccountRecord | null,
  orgId: string,
  res: express.Response,
): {
  account: UpsertOrganizationBillingAccountInput
  allowedTiers: OrganizationBillingTierAllowlistInput[] | null
  accountChanged: boolean
  licenseAffectingChange: boolean
  mode: OrganizationBillingModeValue
  quantities: OrganizationBillingQuantities
  manualAccess: { enabled: boolean; licenseLimit: number } | null
} | null {
  if (!isRecord(body)) {
    res.status(400).json({ error: "invalid_billing_update" })
    return null
  }

  if (bodyContainsStripePriceSelection(body) || bodyContainsStripePriceSelection(isRecord(body) ? body.quantities : null)) {
    res.status(400).json({ error: "stripe_price_id_not_allowed" })
    return null
  }

  const nextMode = hasOwnProperty(body, "mode")
    ? readBillingMode(body.mode)
    : existing?.mode ?? "none"
  if (!nextMode) {
    res.status(400).json({ error: "invalid_billing_mode" })
    return null
  }

  const status = hasOwnProperty(body, "status") ? readBillingStatus(body.status) : null
  if (hasOwnProperty(body, "status") && !status) {
    res.status(400).json({ error: "invalid_billing_status" })
    return null
  }

  const source = hasOwnProperty(body, "source")
    ? body.source === null || body.source === ""
      ? null
      : readBillingSource(body.source)
    : undefined
  if (hasOwnProperty(body, "source") && source === null && body.source !== null && body.source !== "") {
    res.status(400).json({ error: "invalid_billing_source" })
    return null
  }

  const billingInterval = hasOwnProperty(body, "billingInterval")
    ? readOptionalBillingInterval(body.billingInterval)
    : undefined
  if (billingInterval === "invalid") {
    res.status(400).json({ error: "invalid_billing_interval" })
    return null
  }

  const quantities = readMergedPlatformQuantities(body, existing, res)
  if (!quantities) {
    return null
  }
  const effectiveSource = source !== undefined ? source : existing?.source ?? null
  const isManualTrialUpdate = nextMode === "manual_access" && effectiveSource === "manual_trial"

  let manualAccessEnabled = existing?.manualAccessEnabled ?? false
  let manualAccessExpiresAt: Date | null | undefined = undefined
  let manualAccessLicenseLimit = quantities.managedAiBasic + quantities.managedAiExtended + quantities.localModels
  if (hasOwnProperty(body, "manualAccess")) {
    if (!isRecord(body.manualAccess)) {
      res.status(400).json({ error: "invalid_manual_access" })
      return null
    }
    if (hasOwnProperty(body.manualAccess, "enabled")) {
      const enabled = readBodyBoolean(body.manualAccess.enabled)
      if (enabled === null) {
        res.status(400).json({ error: "invalid_manual_access" })
        return null
      }
      manualAccessEnabled = enabled
    }
    if (hasOwnProperty(body.manualAccess, "expiresAt")) {
      const expiresAt = readNullableBillingDate(body.manualAccess.expiresAt)
      if (expiresAt === "invalid") {
        res.status(400).json({ error: "invalid_manual_access_expires_at" })
        return null
      }
      manualAccessExpiresAt = expiresAt
    }
    if (hasOwnProperty(body.manualAccess, "licenseLimit")) {
      const parsed = readNonNegativeInteger(body.manualAccess.licenseLimit)
      if (parsed === null) {
        res.status(400).json({ error: "invalid_manual_access_license_limit" })
        return null
      }
      manualAccessLicenseLimit = parsed
      if (!isManualTrialUpdate) {
        quantities.managedAiBasic = parsed
        quantities.managedAiExtended = 0
        quantities.localModels = 0
      }
    }
  }

  const effectiveManualAccessExpiresAt =
    manualAccessExpiresAt === undefined ? existing?.manualAccessExpiresAt ?? null : manualAccessExpiresAt
  if (isManualTrialUpdate) {
    if (existing?.stripeSubscriptionId) {
      res.status(409).json({ error: "stripe_subscription_exists" })
      return null
    }
    if (!(effectiveManualAccessExpiresAt instanceof Date) || effectiveManualAccessExpiresAt <= new Date()) {
      res.status(400).json({ error: "invalid_manual_access_expires_at" })
      return null
    }
  }

  const localModelsUnitAmount = hasOwnProperty(body, "localModelsUnitAmount")
    ? readOptionalNonNegativeInteger(body.localModelsUnitAmount)
    : undefined
  if (localModelsUnitAmount === "invalid") {
    res.status(400).json({ error: "invalid_local_models_unit_amount" })
    return null
  }

  const localModelsCurrency = hasOwnProperty(body, "localModelsCurrency")
    ? readNullableCurrency(body.localModelsCurrency)
    : undefined
  if (localModelsCurrency === "invalid") {
    res.status(400).json({ error: "invalid_local_models_currency" })
    return null
  }

  const graceUntil = hasOwnProperty(body, "graceUntil") ? readNullableBillingDate(body.graceUntil) : undefined
  if (graceUntil === "invalid") {
    res.status(400).json({ error: "invalid_grace_until" })
    return null
  }

  const cancelAtPeriodEnd = hasOwnProperty(body, "cancelAtPeriodEnd") ? readBodyBoolean(body.cancelAtPeriodEnd) : null
  if (hasOwnProperty(body, "cancelAtPeriodEnd") && cancelAtPeriodEnd === null) {
    res.status(400).json({ error: "invalid_cancel_at_period_end" })
    return null
  }

  const allowedTiers = readPlatformAllowlist(body.allowlist ?? body.allowedTiers)
  if (allowedTiers === "invalid") {
    res.status(400).json({ error: "invalid_tier_allowlist" })
    return null
  }

  const accountChanged = [
    "mode",
    "status",
    "source",
    "billingInterval",
    "quantities",
    "manualAccess",
    "localModelsUnitAmount",
    "localModelsCurrency",
    "paymentProblemCode",
    "paymentProblemMessage",
    "graceUntil",
    "cancelAtPeriodEnd",
  ].some((key) => hasOwnProperty(body, key))
  const licenseAffectingChange =
    nextMode !== "none" && ["mode", "quantities", "manualAccess"].some((key) => hasOwnProperty(body, key))

  return {
    account: {
      orgId,
      ...(hasOwnProperty(body, "mode") ? { mode: nextMode } : {}),
      ...(status ? { status } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(billingInterval !== undefined ? { billingInterval } : {}),
      ...(hasOwnProperty(body, "quantities") || hasOwnProperty(body, "manualAccess")
        ? {
          managedAiBasicQuantity: quantities.managedAiBasic,
          managedAiExtendedQuantity: quantities.managedAiExtended,
          localModelsQuantity: quantities.localModels,
        }
        : {}),
      ...(hasOwnProperty(body, "manualAccess")
        ? {
          manualAccessEnabled,
          manualAccessExpiresAt: manualAccessExpiresAt === undefined ? existing?.manualAccessExpiresAt ?? null : manualAccessExpiresAt,
        }
        : {}),
      ...(localModelsUnitAmount !== undefined ? { localModelsUnitAmount } : {}),
      ...(localModelsCurrency !== undefined ? { localModelsCurrency } : {}),
      ...(hasOwnProperty(body, "paymentProblemCode") ? { paymentProblemCode: readBodyString(body.paymentProblemCode) } : {}),
      ...(hasOwnProperty(body, "paymentProblemMessage") ? { paymentProblemMessage: readBodyString(body.paymentProblemMessage) } : {}),
      ...(graceUntil !== undefined ? { graceUntil } : {}),
      ...(cancelAtPeriodEnd !== null ? { cancelAtPeriodEnd } : {}),
    },
    allowedTiers,
    accountChanged,
    licenseAffectingChange,
    mode: nextMode,
    quantities,
    manualAccess: {
      enabled: manualAccessEnabled,
      licenseLimit: manualAccessLicenseLimit,
    },
  }
}

export function createOrganizationBillingAdminRouteDeps(
  input: OrganizationBillingAdminRouteDepsInput,
): Pick<
  AdminRouteDeps,
  | "getOrganizationBilling"
  | "createOrganizationBillingCheckout"
  | "createOrganizationBillingPortalSession"
  | "updateOrganizationBillingPlan"
  | "cancelOrganizationBilling"
  | "updatePlatformOrganizationBilling"
> {
  const { repository, stripeService } = input
  const requireOrganizationAccess = input.requireOrganizationAccess ?? requireAdminOrganizationAccess
  const requirePlatformAdmin = input.requirePlatformAdmin ?? requirePlatformAdminSnapshot
  const recordOrganizationAudit = input.recordOrganizationAudit ?? recordAdminOrganizationAudit

  return {
    async getOrganizationBilling(req, res) {
      const context = await requireOrganizationAccess(req, res, {
        orgId: req.params.orgId,
      })
      if (!context) {
        return null
      }

      return getOrganizationBillingSummary(repository, context.organization.id)
    },

    async createOrganizationBillingCheckout(req, res) {
      const context = await requireOrganizationAccess(req, res, {
        orgId: req.params.orgId,
      })
      if (!context) {
        return null
      }
      if (!stripeService) {
        res.status(503).json({ error: "stripe_billing_disabled" })
        return null
      }

      const interval = readBillingInterval((req.body ?? {}).interval)
      if (!interval) {
        res.status(400).json({ error: "invalid_billing_interval" })
        return null
      }
      const quantities = readManagedAiBillingQuantities(req.body ?? {}, res, { requireAny: true })
      if (!quantities) {
        return null
      }

      try {
        const checkout = await stripeService.createManagedAiCheckoutSession({
          orgId: context.organization.id,
          actorUserId: context.snapshot.user.id,
          interval,
          quantities,
          returnOrigin: readRequestOrigin(req),
        })
        await recordOrganizationAudit(context.snapshot, context.organization.id, "admin.billing.checkout.created", {
          interval,
          quantities,
        })
        return { checkout }
      } catch (error) {
        if (sendBillingError(error, res)) {
          return null
        }
        throw error
      }
    },

    async createOrganizationBillingPortalSession(req, res) {
      const context = await requireOrganizationAccess(req, res, {
        orgId: req.params.orgId,
      })
      if (!context) {
        return null
      }
      if (!stripeService) {
        res.status(503).json({ error: "stripe_billing_disabled" })
        return null
      }

      try {
        const portal = await stripeService.createBillingPortalSession({
          orgId: context.organization.id,
          actorUserId: context.snapshot.user.id,
          returnOrigin: readRequestOrigin(req),
        })
        await recordOrganizationAudit(context.snapshot, context.organization.id, "admin.billing.portal.created", {})
        return { portal }
      } catch (error) {
        if (sendBillingError(error, res)) {
          return null
        }
        throw error
      }
    },

    async updateOrganizationBillingPlan(req, res) {
      const context = await requireOrganizationAccess(req, res, {
        orgId: req.params.orgId,
      })
      if (!context) {
        return null
      }
      if (!stripeService) {
        res.status(503).json({ error: "stripe_billing_disabled" })
        return null
      }

      const quantities = readManagedAiBillingQuantities(req.body ?? {}, res, { requireAny: false })
      if (!quantities) {
        return null
      }

      try {
        await stripeService.updateManagedAiSubscriptionQuantities({
          orgId: context.organization.id,
          actorUserId: context.snapshot.user.id,
          quantities,
        })
        await recordOrganizationAudit(context.snapshot, context.organization.id, "admin.billing.plan.updated", {
          quantities,
        })
        return getOrganizationBillingSummary(repository, context.organization.id)
      } catch (error) {
        if (sendBillingError(error, res)) {
          return null
        }
        throw error
      }
    },

    async cancelOrganizationBilling(req, res) {
      const context = await requireOrganizationAccess(req, res, {
        orgId: req.params.orgId,
      })
      if (!context) {
        return null
      }
      if (!stripeService) {
        res.status(503).json({ error: "stripe_billing_disabled" })
        return null
      }

      try {
        await stripeService.cancelManagedAiSubscriptionAtPeriodEnd({
          orgId: context.organization.id,
          actorUserId: context.snapshot.user.id,
        })
        await recordOrganizationAudit(context.snapshot, context.organization.id, "admin.billing.cancel_at_period_end.set", {})
        return { ok: true } as const
      } catch (error) {
        if (sendBillingError(error, res)) {
          return null
        }
        throw error
      }
    },

    async updatePlatformOrganizationBilling(req, res) {
      const snapshot = await requirePlatformAdmin(req, res)
      if (!snapshot) {
        return null
      }
      const context = await requireOrganizationAccess(req, res, {
        snapshot,
        orgId: req.params.orgId,
      })
      if (!context) {
        return null
      }

      const existing = await repository.getBillingAccount(context.organization.id)
      const update = readPlatformBillingUpdate(req.body ?? {}, existing, context.organization.id, res)
      if (!update) {
        return null
      }

      try {
        if (update.licenseAffectingChange) {
          await repository.assertRequestedQuantitiesCanCoverActiveUsers({
            orgId: context.organization.id,
            mode: update.mode,
            quantities: update.quantities,
            manualAccess: update.mode === "manual_access" ? update.manualAccess : null,
          })
        }
        if (update.accountChanged) {
          await repository.upsertBillingAccount(update.account)
        }
        if (update.allowedTiers) {
          await repository.setAllowedTiers(context.organization.id, update.allowedTiers)
        }
        await recordOrganizationAudit(snapshot, context.organization.id, "admin.billing.platform.updated", {
          changedFields: Object.keys(req.body ?? {}),
        })
        return getOrganizationBillingSummary(repository, context.organization.id)
      } catch (error) {
        if (sendBillingError(error, res)) {
          return null
        }
        throw error
      }
    },
  }
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

async function resendAdminOrganizationInvite(req: express.Request, res: express.Response) {
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
  const resendNow = new Date()
  const statusScope = evaluateAdminInviteResendStatus(invite.status, invite.expires_at, resendNow)
  if (!statusScope.ok) {
    res.status(statusScope.status).json({ error: statusScope.error })
    return null
  }

  const hasExpiresAt = hasOwnProperty(req.body ?? {}, "expiresAt")
  const expiresAt = hasExpiresAt ? parseInviteExpiresAt((req.body ?? {}).expiresAt) : invite.expires_at
  if (expiresAt === "invalid") {
    res.status(400).json({ error: "invalid_expires_at" })
    return null
  }

  const inviteToken = randomBytes(24).toString("base64url")
  const result = await db
    .update(OrganizationInviteTable)
    .set({
      token_hash: hashOrganizationInviteToken(inviteToken),
      status: "pending",
      expires_at: expiresAt,
      updated_at: resendNow,
    })
    .where(and(
      eq(OrganizationInviteTable.org_id, context.organization.id),
      eq(OrganizationInviteTable.id, inviteId),
      eq(OrganizationInviteTable.status, "pending"),
      or(
        isNull(OrganizationInviteTable.expires_at),
        gt(OrganizationInviteTable.expires_at, resendNow),
      ),
    ))

  if (extractAffectedRows(result) === 0) {
    res.status(409).json({ error: "invite_not_pending" })
    return null
  }

  await recordAdminOrganizationAudit(context.snapshot, context.organization.id, "org.invite.resent", {
    inviteId,
    email: invite.email,
    expiresAt,
  })

  const updatedRows = await db
    .select()
    .from(OrganizationInviteTable)
    .where(eq(OrganizationInviteTable.id, inviteId))
    .limit(1)

  return {
    invite: mapInviteRow(updatedRows[0]),
    inviteToken,
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
  const nextOrgId = hasOwnProperty(req.body, "orgId")
    ? updateUserSchema.orgId((req.body ?? {}).orgId)
    : null
  const nextOrgRole = hasOwnProperty(req.body, "orgRole")
    ? updateUserSchema.orgRole((req.body ?? {}).orgRole)
    : null

  if (hasOwnProperty(req.body, "orgId") && !nextOrgId) {
    res.status(400).json({ error: "invalid_org_id" })
    return null
  }

  if (hasOwnProperty(req.body, "orgRole") && !nextOrgRole) {
    res.status(400).json({ error: "invalid_role" })
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

  if (nextOrgId && nextOrgRole) {
    const organization = await loadOrganizationRecord(nextOrgId)
    if (!organization) {
      res.status(404).json({ error: "organization_not_found" })
      return null
    }

    const existingMembership = await loadOrganizationMemberByUserId(nextOrgId, userId)
    if (existingMembership) {
      await db.update(OrgMembershipTable).set({ role: nextOrgRole }).where(eq(OrgMembershipTable.id, existingMembership.membershipId))
    } else {
      try {
        await createOrActivateOrganizationMembership({
          membershipId: randomUUID(),
          orgId: nextOrgId,
          userId,
          role: nextOrgRole,
        })
      } catch (error) {
        if (error instanceof OrganizationAdminRepositoryError && error.code === "seat_limit_reached") {
          res.status(409).json({ error: "seat_limit_reached" })
          return null
        }
        throw error
      }
    }
  }

  const users = await loadAdminUsers()
  const updated = users.find((entry) => entry.id === userId) ?? null
  if (updated) {
    await recordAdminAudit(snapshot, "admin.user.updated", {
      targetUserId: userId,
      nameChanged: nextName !== null,
      platformAdmin: nextPlatformAdmin,
      orgId: nextOrgId,
      orgRole: nextOrgRole,
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

function createOrganizationBillingRuntimeDeps() {
  const repository = createOrganizationBillingRepository(createDrizzleOrganizationBillingStore(db))
  const stripeConfig = env.organizationBilling.stripe
  const stripeService = stripeConfig.enabled
    ? createOrganizationStripeBillingService({
      config: stripeConfig,
      repository,
      stripe: createOrganizationStripeBillingClient(stripeConfig),
    })
    : null

  return createOrganizationBillingAdminRouteDeps({
    repository,
    stripeService,
  })
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
    resendOrganizationInvite: resendAdminOrganizationInvite,
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
    ...createOrganizationBillingRuntimeDeps(),
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
