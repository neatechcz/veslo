import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const adminRuntime = await import("../src/http/admin-runtime.js")

test("bootstrap platform admin allowlist recognizes michal.sara@neatech.cz", () => {
  assert.equal(typeof adminRuntime.isBootstrapPlatformAdminEmail, "function")
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("michal.sara@neatech.cz"), true)
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("MICHAL.SARA@NEATECH.CZ"), true)
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("someone@example.com"), false)
})

test("admin runtime forwards managed AI Codex status provider into route deps", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")

  assert.match(source, /codexStatusProvider:\s*options\.managedAi\.codexStatusProvider/)
})

test("admin runtime session resolver allows organization admins while managed AI stays platform-only", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")

  assert.equal(typeof adminRuntime.requireAdminSessionSnapshot, "function")
  assert.match(source, /export async function requireAdminSessionSnapshot/)
  assert.match(source, /isOrganizationAdminRole/)
  assert.match(source, /getSessionSnapshot:\s*requireAdminSessionSnapshot/)
  assert.match(source, /getAdminSession:\s*requirePlatformAdminSnapshot/)
})

test("admin session authorization reads memberships without provisioning a default organization", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const platformSnapshotSource =
    source.match(/export async function requirePlatformAdminSnapshot[\s\S]*?export async function requireAdminSessionSnapshot/)?.[0] ?? ""
  const adminSnapshotSource =
    source.match(/export async function requireAdminSessionSnapshot[\s\S]*?async function loadUserMemberships/)?.[0] ?? ""

  assert.match(source, /resolveUserOrganizations/)
  assert.match(platformSnapshotSource, /resolveUserOrganizations\(session\.user\.id\)/)
  assert.match(adminSnapshotSource, /resolveUserOrganizations\(session\.user\.id\)/)
  assert.doesNotMatch(platformSnapshotSource, /resolveMembershipOrganizations/)
  assert.doesNotMatch(adminSnapshotSource, /resolveMembershipOrganizations/)
})

test("only platform admins can edit organization seat limits", () => {
  assert.equal(typeof adminRuntime.canAdminEditOrganizationSeatLimit, "function")
  assert.equal(adminRuntime.canAdminEditOrganizationSeatLimit({ platformAdmin: true }), true)
  assert.equal(adminRuntime.canAdminEditOrganizationSeatLimit({ platformAdmin: false }), false)
})

test("organization admin seat limit update payloads require platform admin scope", () => {
  assert.equal(typeof adminRuntime.canAdminUpdateOrganizationSeatLimitPayload, "function")
  const canAdminUpdateOrganizationSeatLimitPayload =
    adminRuntime.canAdminUpdateOrganizationSeatLimitPayload as (
      snapshot: { platformAdmin: boolean },
      body: unknown,
    ) => boolean

  assert.equal(canAdminUpdateOrganizationSeatLimitPayload({ platformAdmin: true }, { seatLimit: 25 }), true)
  assert.equal(canAdminUpdateOrganizationSeatLimitPayload({ platformAdmin: false }, { seatLimit: 25 }), false)
  assert.equal(canAdminUpdateOrganizationSeatLimitPayload({ platformAdmin: false }, { seatLimit: null }), false)
  assert.equal(canAdminUpdateOrganizationSeatLimitPayload({ platformAdmin: false }, { name: "Personal" }), true)
})

test("admin organization updates persist editable name and slug fields", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const updateSource = source.match(/async function updateAdminOrganization[\s\S]*?async function listAdminOrganizationMembers/)?.[0] ?? ""

  assert.match(updateSource, /const nextName = hasOwnProperty\(req\.body, "name"\)[\s\S]*readBodyString\(\(req\.body \?\? \{}\)\.name\)/)
  assert.match(updateSource, /const nextSlug = hasOwnProperty\(req\.body, "slug"\)[\s\S]*readBodyString\(\(req\.body \?\? \{}\)\.slug\)/)
  assert.match(updateSource, /const persistedName = nextName \?\? context\.organization\.name/)
  assert.match(updateSource, /const persistedSlug = nextSlug \?\? context\.organization\.slug/)
  assert.match(updateSource, /set\(\{[\s\S]*name: persistedName,[\s\S]*slug: persistedSlug,[\s\S]*seat_limit: seatLimit/)
  assert.match(updateSource, /changedFields/)
})

test("admin runtime organization access helper distinguishes platform, org admin, and member scope", () => {
  assert.equal(typeof adminRuntime.canAdminAccessOrganization, "function")
  const canAdminAccessOrganization = adminRuntime.canAdminAccessOrganization as (snapshot: {
    platformAdmin: boolean
    organizations: Array<{ id: string; role: "member" | "organization_admin" | "owner" }>
  }, orgId: string | null | undefined) => boolean

  assert.equal(canAdminAccessOrganization({
    platformAdmin: true,
    organizations: [],
  }, "org_other"), true)
  assert.equal(canAdminAccessOrganization({
    platformAdmin: false,
    organizations: [{ id: "org_own", role: "organization_admin" }],
  }, "org_own"), true)
  assert.equal(canAdminAccessOrganization({
    platformAdmin: false,
    organizations: [{ id: "org_own", role: "organization_admin" }],
  }, "org_other"), false)
  assert.equal(canAdminAccessOrganization({
    platformAdmin: false,
    organizations: [{ id: "org_own", role: "member" }],
  }, "org_own"), false)
  assert.equal(canAdminAccessOrganization({
    platformAdmin: false,
    organizations: [{ id: "org_own", role: "owner" }],
  }, "org_own"), true)
  assert.equal(canAdminAccessOrganization({
    platformAdmin: false,
    organizations: [{ id: "org_own", role: "organization_admin" }],
  }, null), false)
})

test("organization admin user update payloads are limited to scoped membership role changes", () => {
  assert.equal(typeof adminRuntime.evaluateAdminUserUpdatePayloadScope, "function")
  const evaluateAdminUserUpdatePayloadScope =
    adminRuntime.evaluateAdminUserUpdatePayloadScope as (
      snapshot: { platformAdmin: boolean },
      body: unknown,
    ) => { ok: true; role?: "member" | "organization_admin" } | { ok: false; status: number; error: string }

  assert.deepEqual(evaluateAdminUserUpdatePayloadScope(
    { platformAdmin: false },
    { orgId: "org_own", role: "organization_admin" },
  ), { ok: true, role: "organization_admin" })
  assert.deepEqual(evaluateAdminUserUpdatePayloadScope(
    { platformAdmin: false },
    { orgId: "org_own", orgRole: "member" },
  ), { ok: true, role: "member" })
  assert.deepEqual(evaluateAdminUserUpdatePayloadScope(
    { platformAdmin: false },
    { orgId: "org_own", role: "member", platformAdmin: true },
  ), { ok: false, status: 403, error: "platform_admin_required" })
  assert.deepEqual(evaluateAdminUserUpdatePayloadScope(
    { platformAdmin: false },
    { orgId: "org_own", role: "member", name: "Renamed User" },
  ), { ok: false, status: 403, error: "platform_admin_required" })
  assert.deepEqual(evaluateAdminUserUpdatePayloadScope(
    { platformAdmin: false },
    { orgId: "org_own" },
  ), { ok: false, status: 400, error: "invalid_role" })
  assert.deepEqual(evaluateAdminUserUpdatePayloadScope(
    { platformAdmin: true },
    { platformAdmin: true, name: "Platform User" },
  ), { ok: true })
})

test("platform admin user updates persist organization membership role changes from Save payloads", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const updateSource = source.match(/async function updateAdminUser[\s\S]*?async function disableAdminUser/)?.[0] ?? ""

  assert.match(updateSource, /const nextOrgId = hasOwnProperty\(req\.body, "orgId"\)/)
  assert.match(updateSource, /const nextOrgRole = hasOwnProperty\(req\.body, "orgRole"\)/)
  assert.match(updateSource, /loadOrganizationRecord\(nextOrgId\)/)
  assert.match(updateSource, /createOrActivateOrganizationMembership/)
  assert.match(updateSource, /db\.update\(OrgMembershipTable\)\.set\(\{ role: nextOrgRole \}\)/)
})

test("admin invite creation stores only a derived token hash while returning the raw token once", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const createInviteSource = source.match(/async function createAdminOrganizationInvite[\s\S]*?async function revokeAdminOrganizationInvite/)?.[0] ?? ""

  assert.match(createInviteSource, /inviteToken/)
  assert.match(createInviteSource, /tokenHash:\s*hashOrganizationInviteToken\(inviteToken\)/)
  assert.doesNotMatch(createInviteSource, /tokenHash:\s*inviteToken/)
})

test("admin invite resend rotates only the derived token hash while returning the raw token once", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const resendInviteSource = source.match(/async function resendAdminOrganizationInvite[\s\S]*?async function revokeAdminOrganizationInvite/)?.[0] ?? ""

  assert.match(resendInviteSource, /inviteToken/)
  assert.match(resendInviteSource, /token_hash:\s*hashOrganizationInviteToken\(inviteToken\)/)
  assert.match(resendInviteSource, /const resendNow = new Date\(\)/)
  assert.match(resendInviteSource, /evaluateAdminInviteResendStatus\(invite\.status,\s*invite\.expires_at,\s*resendNow\)/)
  assert.match(resendInviteSource, /eq\(OrganizationInviteTable\.status,\s*"pending"\)/)
  assert.match(resendInviteSource, /gt\(OrganizationInviteTable\.expires_at,\s*resendNow\)/)
  assert.match(resendInviteSource, /extractAffectedRows\(result\) === 0/)
  assert.match(resendInviteSource, /inviteToken/)
  assert.doesNotMatch(resendInviteSource, /token_hash:\s*inviteToken/)
})

test("admin invite creation queues a registration email only after persistence and audit succeed", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const createInviteSource = source.match(/async function createAdminOrganizationInvite[\s\S]*?async function resendAdminOrganizationInvite/)?.[0] ?? ""

  const persistIndex = createInviteSource.indexOf("createOrganizationInviteRecord")
  const auditIndex = createInviteSource.indexOf("recordAdminOrganizationAudit")
  const deliveryIndex = createInviteSource.indexOf("queueOrganizationInvitationAuthEmail")
  const returnIndex = createInviteSource.indexOf("return {")

  assert.ok(persistIndex >= 0)
  assert.ok(auditIndex > persistIndex)
  assert.ok(deliveryIndex > auditIndex)
  assert.ok(returnIndex > deliveryIndex)
  assert.match(createInviteSource, /queueOrganizationInvitationAuthEmail\(\{[\s\S]*to:\s*invite\.email,[\s\S]*inviteToken/)
})

test("admin invite resend queues the rotated registration link only after update and audit succeed", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const resendInviteSource = source.match(/async function resendAdminOrganizationInvite[\s\S]*?async function revokeAdminOrganizationInvite/)?.[0] ?? ""

  const updateIndex = resendInviteSource.indexOf(".update(OrganizationInviteTable)")
  const conflictIndex = resendInviteSource.indexOf("extractAffectedRows(result) === 0")
  const auditIndex = resendInviteSource.indexOf("recordAdminOrganizationAudit")
  const deliveryIndex = resendInviteSource.indexOf("queueOrganizationInvitationAuthEmail")
  const returnIndex = resendInviteSource.indexOf("return {")

  assert.ok(updateIndex >= 0)
  assert.ok(conflictIndex > updateIndex)
  assert.ok(auditIndex > conflictIndex)
  assert.ok(deliveryIndex > auditIndex)
  assert.ok(returnIndex > deliveryIndex)
  assert.match(resendInviteSource, /queueOrganizationInvitationAuthEmail\(\{[\s\S]*to:\s*invite\.email,[\s\S]*inviteToken/)
})

test("admin invite list and revoke routes never queue invitation emails", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const listInviteSource = source.match(/async function listAdminOrganizationInvites[\s\S]*?async function createAdminOrganizationInvite/)?.[0] ?? ""
  const revokeInviteSource = source.match(/async function revokeAdminOrganizationInvite[\s\S]*?async function loadOrganizationMembership/)?.[0] ?? ""

  assert.doesNotMatch(listInviteSource, /queueOrganizationInvitationAuthEmail/)
  assert.doesNotMatch(revokeInviteSource, /queueOrganizationInvitationAuthEmail/)
})

test("admin invite resend status guard only allows pending invites", () => {
  assert.equal(typeof adminRuntime.evaluateAdminInviteResendStatus, "function")
  const evaluateAdminInviteResendStatus = adminRuntime.evaluateAdminInviteResendStatus as (
    status: "pending" | "accepted" | "expired" | "revoked",
    expiresAt?: Date | null,
    now?: Date,
  ) => { ok: true } | { ok: false; status: number; error: string }
  const now = new Date("2026-06-06T12:00:00.000Z")

  assert.deepEqual(evaluateAdminInviteResendStatus("pending", null, now), { ok: true })
  assert.deepEqual(evaluateAdminInviteResendStatus("pending", new Date("2026-06-06T12:00:00.001Z"), now), { ok: true })
  assert.deepEqual(evaluateAdminInviteResendStatus("pending", new Date("2026-06-06T12:00:00.000Z"), now), {
    ok: false,
    status: 409,
    error: "invite_expired",
  })
  assert.deepEqual(evaluateAdminInviteResendStatus("pending", new Date("2026-06-06T11:59:59.999Z"), now), {
    ok: false,
    status: 409,
    error: "invite_expired",
  })
  assert.deepEqual(evaluateAdminInviteResendStatus("accepted", null, now), {
    ok: false,
    status: 409,
    error: "invite_already_accepted",
  })
  assert.deepEqual(evaluateAdminInviteResendStatus("revoked", null, now), {
    ok: false,
    status: 409,
    error: "invite_already_revoked",
  })
  assert.deepEqual(evaluateAdminInviteResendStatus("expired", null, now), {
    ok: false,
    status: 409,
    error: "invite_expired",
  })
})

test("admin-created users use the internal provisioning override for email signup", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const signupFetch = source.match(/fetch\(`\$\{baseUrl\}\/api\/auth\/sign-up\/email`, \{[\s\S]*?body:/)?.[0] ?? ""

  assert.match(source, /createAdminProvisioningSignupHeaders/)
  assert.match(signupFetch, /\.\.\.createAdminProvisioningSignupHeaders\(\)/)
})
