import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { OrganizationAdminRepositoryError } from "../src/org-admin/repository.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_test",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const {
  createEnsureSignupOrganization,
  SignupOrganizationDomainConflictError,
} = await import("../src/orgs.js")

function createSequentialId(...ids: string[]) {
  return () => {
    const id = ids.shift()
    assert.ok(id, "unexpected id request")
    return id
  }
}

test("first signup atomically bootstraps organization, admin membership, exact domain, and trial", async () => {
  const created: unknown[] = []
  const ensureSignupOrganization = createEnsureSignupOrganization({
    createId: createSequentialId("org_1", "membership_1", "domain_1"),
    async findExistingOrganizationId() {
      return null
    },
    async createOrganizationMembershipDomainAndTrial(input) {
      created.push(input)
    },
  })

  assert.equal(
    await ensureSignupOrganization("user_1", "User One", " User@Team.Example.com "),
    "org_1",
  )
  assert.deepEqual(created, [{
    orgId: "org_1",
    membershipId: "membership_1",
    domainId: "domain_1",
    userId: "user_1",
    name: "User One",
    slug: "personal-org_1",
    domain: "team.example.com",
  }])
})

test("existing organization membership skips signup organization bootstrap", async () => {
  let createCalls = 0
  const ensureSignupOrganization = createEnsureSignupOrganization({
    createId: () => {
      throw new Error("must not create ids")
    },
    async findExistingOrganizationId() {
      return "org_existing"
    },
    async createOrganizationMembershipDomainAndTrial() {
      createCalls += 1
    },
  })

  assert.equal(
    await ensureSignupOrganization("user_1", "User One", "user@example.com"),
    "org_existing",
  )
  assert.equal(createCalls, 0)
})

test("signup organization bootstrap rejects an invalid email domain", async () => {
  const ensureSignupOrganization = createEnsureSignupOrganization({
    createId: () => "unused",
    async findExistingOrganizationId() {
      return null
    },
    async createOrganizationMembershipDomainAndTrial() {
      throw new Error("must not create an organization")
    },
  })

  await assert.rejects(
    ensureSignupOrganization("user_1", "User One", "invalid-email"),
    (error) => {
      assert.ok(error instanceof OrganizationAdminRepositoryError)
      assert.equal(error.code, "domain_not_allowed")
      return true
    },
  )
})

test("signup organization bootstrap preserves a concurrent domain claim conflict", async () => {
  const conflict = new SignupOrganizationDomainConflictError("team.example.com")
  const ensureSignupOrganization = createEnsureSignupOrganization({
    createId: createSequentialId("org_loser", "membership_loser", "domain_loser"),
    async findExistingOrganizationId() {
      return null
    },
    async createOrganizationMembershipDomainAndTrial() {
      throw conflict
    },
  })

  await assert.rejects(
    ensureSignupOrganization("user_loser", "User Loser", "user@team.example.com"),
    (error) => error === conflict,
  )
})

test("production bootstrap wires organization, membership, domain, and trial through one transaction", async () => {
  const source = await readFile(new URL("../src/orgs.ts", import.meta.url), "utf8")
  const signupBootstrapStart = source.indexOf("export const ensureSignupOrganization")
  assert.ok(signupBootstrapStart >= 0)

  const signupBootstrapSource = source.slice(signupBootstrapStart)
  assert.match(signupBootstrapSource, /createOrganizationMembershipDomainAndTrial/)
  assert.match(signupBootstrapSource, /db\.transaction/)
  assert.match(signupBootstrapSource, /OrganizationDomainTable/)
  assert.match(signupBootstrapSource, /self_signup_enabled: true/)
  assert.match(signupBootstrapSource, /createDrizzleAutomaticOrganizationTrialStore\(tx\)/)
})
