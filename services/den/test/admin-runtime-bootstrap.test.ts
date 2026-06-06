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

test("admin invite creation stores only a derived token hash while returning the raw token once", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const createInviteSource = source.match(/async function createAdminOrganizationInvite[\s\S]*?async function revokeAdminOrganizationInvite/)?.[0] ?? ""

  assert.match(createInviteSource, /inviteToken/)
  assert.match(createInviteSource, /tokenHash:\s*hashOrganizationInviteToken\(inviteToken\)/)
  assert.doesNotMatch(createInviteSource, /tokenHash:\s*inviteToken/)
})

test("admin-created users use the internal provisioning override for email signup", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const signupFetch = source.match(/fetch\(`\$\{baseUrl\}\/api\/auth\/sign-up\/email`, \{[\s\S]*?body:/)?.[0] ?? ""

  assert.match(source, /createAdminProvisioningSignupHeaders/)
  assert.match(signupFetch, /\.\.\.createAdminProvisioningSignupHeaders\(\)/)
})
