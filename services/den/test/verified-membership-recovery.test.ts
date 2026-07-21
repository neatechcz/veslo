import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_test",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
  DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
})

const { createResolveMembershipOrganizations } = await import("../src/http/org-auth.js")
const { createDatabaseUserProvisioningLock } = await import("../src/auth/verified-signup.js")

test("production provisioning lock holds a cross-process advisory lock during organization work", async () => {
  const calls: string[] = []
  let executes = 0
  const tx = {
    async execute() {
      executes += 1
      calls.push(executes === 1 ? "advisory-lock:acquire" : "advisory-lock:release")
      return executes === 1
        ? [[{ acquired: 1 }], []]
        : [[{ released: 1 }], []]
    },
  }
  const database = {
    async transaction<T>(operation: (activeTx: typeof tx) => Promise<T>) {
      calls.push("transaction:start")
      const result = await operation(tx)
      calls.push("transaction:commit")
      return result
    },
  }
  const runWithUserProvisioningLock = createDatabaseUserProvisioningLock(database)

  assert.equal(await runWithUserProvisioningLock("user_1", async () => {
    calls.push("organization-work")
    return "org_1"
  }), "org_1")
  assert.deepEqual(calls, [
    "transaction:start",
    "advisory-lock:acquire",
    "organization-work",
    "advisory-lock:release",
    "transaction:commit",
  ])
})

test("production provisioning lock fails closed when MySQL does not acquire it", async () => {
  let operationCalls = 0
  const database = {
    async transaction<T>(operation: (tx: { execute(): Promise<unknown> }) => Promise<T>) {
      return operation({
        async execute() {
          return [[{ acquired: 0 }], []]
        },
      })
    },
  }

  await assert.rejects(
    createDatabaseUserProvisioningLock(database)("missing_or_uncommitted_user", async () => {
      operationCalls += 1
    }),
    /signup_user_provisioning_lock_unavailable/,
  )
  assert.equal(operationCalls, 0)
})

test("verified no-membership read provisions with the verified coordinator and re-reads memberships", async () => {
  const organization = {
    id: "org_recovered",
    name: "Recovered",
    slug: "recovered",
    ownerUserId: "user_1",
    membershipId: "membership_1",
    role: "organization_admin" as const,
    status: "active" as const,
  }
  let reads = 0
  const provisionedUsers: unknown[] = []
  const resolveMembershipOrganizations = createResolveMembershipOrganizations({
    async resolveUserOrganizations() {
      reads += 1
      return reads === 1 ? [] : [organization]
    },
    async provisionVerifiedSignupUser(user) {
      provisionedUsers.push(user)
    },
  })

  const result = await resolveMembershipOrganizations({
    user: {
      id: "user_1",
      name: "Verified User",
      email: "verified@team.example.com",
      emailVerified: true,
    },
  })

  assert.equal(reads, 2)
  assert.deepEqual(provisionedUsers, [{
    id: "user_1",
    name: "Verified User",
    email: "verified@team.example.com",
    emailVerified: true,
  }])
  assert.deepEqual(result, [organization])
})

test("unverified no-membership read never invokes provisioning recovery", async () => {
  let provisionCalls = 0
  const resolveMembershipOrganizations = createResolveMembershipOrganizations({
    async resolveUserOrganizations() {
      return []
    },
    async provisionVerifiedSignupUser() {
      provisionCalls += 1
    },
  })

  assert.deepEqual(await resolveMembershipOrganizations({
    user: {
      id: "user_unverified",
      name: "Unverified User",
      email: "unverified@team.example.com",
      emailVerified: false,
    },
  }), [])
  assert.equal(provisionCalls, 0)
})

test("organization membership recovery has no legacy domainless default organization fallback", async () => {
  const source = await readFile(new URL("../src/http/org-auth.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /ensureDefaultOrg/)
  assert.match(source, /provisionVerifiedSignup/)
})
