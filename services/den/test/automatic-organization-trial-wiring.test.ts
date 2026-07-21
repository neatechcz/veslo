import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_test",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { createEnsureDefaultOrg } = await import("../src/orgs.js")

test("new personal organization is created before its automatic trial is initialized", async () => {
  const calls: string[] = []
  const ensureDefaultOrg = createEnsureDefaultOrg({
    createId: () => "generated-id",
    async findExistingOrganizationId() {
      calls.push("find")
      return null
    },
    async createOrganizationAndMembership(input) {
      calls.push(`create:${input.orgId}:${input.membershipId}`)
    },
    async ensureAutomaticTrial(orgId) {
      calls.push(`trial:${orgId}`)
    },
  })

  assert.equal(await ensureDefaultOrg("user_1", "Personal"), "generated-id")
  assert.deepEqual(calls, [
    "find",
    "create:generated-id:generated-id",
    "trial:generated-id",
  ])
})

test("existing organization membership is returned without resetting its trial", async () => {
  let trialCalls = 0
  const ensureDefaultOrg = createEnsureDefaultOrg({
    createId: () => "unused",
    async findExistingOrganizationId() {
      return "org_existing"
    },
    async createOrganizationAndMembership() {
      throw new Error("must not create an organization")
    },
    async ensureAutomaticTrial() {
      trialCalls += 1
    },
  })

  assert.equal(await ensureDefaultOrg("user_1", "Personal"), "org_existing")
  assert.equal(trialCalls, 0)
})

test("automatic trial failure is not hidden after organization creation", async () => {
  const ensureDefaultOrg = createEnsureDefaultOrg({
    createId: () => "org_1",
    async findExistingOrganizationId() {
      return null
    },
    async createOrganizationAndMembership() {},
    async ensureAutomaticTrial() {
      throw new Error("trial database unavailable")
    },
  })

  await assert.rejects(
    ensureDefaultOrg("user_1", "Personal"),
    /trial database unavailable/,
  )
})

test("DEN bootstrap reconciles automatic trials after schema setup and before listen", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  const ensureTablesIndex = source.indexOf("await ensureTables()")
  const reconcileIndex = source.indexOf("await automaticOrganizationTrialService.reconcile()")
  const listenIndex = source.indexOf("app.listen(env.port")

  assert.ok(ensureTablesIndex >= 0)
  assert.ok(reconcileIndex > ensureTablesIndex)
  assert.ok(listenIndex > reconcileIndex)
})
