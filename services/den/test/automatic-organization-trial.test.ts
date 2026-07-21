import assert from "node:assert/strict"
import test from "node:test"

import {
  AUTOMATIC_ORGANIZATION_TRIAL_DAYS,
  createAutomaticOrganizationTrialService,
  type AutomaticOrganizationTrialGrant,
  type AutomaticOrganizationTrialStore,
} from "../src/billing/automatic-organization-trial.js"

type FakeBillingAccount = {
  source: "manual_trial" | "stripe_subscription" | "manual_external"
  manualAccessExpiresAt: Date | null
}

class FakeAutomaticOrganizationTrialStore implements AutomaticOrganizationTrialStore {
  organizationIds: string[] = []
  domainsByOrg = new Map<string, string[]>()
  claims = new Map<string, string>()
  accounts = new Map<string, FakeBillingAccount>()
  automaticTrialHistory = new Set<string>()
  grants: AutomaticOrganizationTrialGrant[] = []

  async listOrganizationIds() {
    return [...this.organizationIds]
  }

  async grantOrSyncDomainTrial(input: AutomaticOrganizationTrialGrant) {
    const domains = [...new Set((this.domainsByOrg.get(input.orgId) ?? [])
      .map((domain) => domain.trim().toLowerCase()))].sort()
    if (domains.length === 0) {
      return { granted: false }
    }

    const account = this.accounts.get(input.orgId)
    const hasTrialHistory = this.automaticTrialHistory.has(input.orgId)
    const hasExistingTrial = account?.source === "manual_trial" || hasTrialHistory
    if (hasExistingTrial) {
      for (const domain of domains) {
        if (!this.claims.has(domain)) {
          this.claims.set(domain, input.orgId)
        }
      }
      return { granted: false }
    }

    if (account || domains.some((domain) => this.claims.has(domain))) {
      return { granted: false }
    }

    for (const domain of domains) {
      this.claims.set(domain, input.orgId)
    }
    this.accounts.set(input.orgId, {
      source: "manual_trial",
      manualAccessExpiresAt: input.manualAccessExpiresAt,
    })
    this.automaticTrialHistory.add(input.orgId)
    this.grants.push(input)
    return { granted: true }
  }
}

const NOW = new Date("2026-07-21T00:00:00.000Z")
const EXPIRY = new Date("2026-08-04T00:00:00.000Z")

function createService(store: AutomaticOrganizationTrialStore) {
  return createAutomaticOrganizationTrialService({ store, now: () => NOW })
}

test("automatic organization trial duration is 14 days", () => {
  assert.equal(AUTOMATIC_ORGANIZATION_TRIAL_DAYS, 14)
})

test("grants an unconfigured organization one 14-day unlimited trial", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  store.domainsByOrg.set("org_1", ["example.test"])

  const result = await createService(store).ensureTrial("org_1")

  assert.deepEqual(result, { granted: true, expiresAt: EXPIRY })
  assert.deepEqual(store.grants, [{
    orgId: "org_1",
    mode: "manual_access",
    source: "manual_trial",
    status: "active",
    manualAccessEnabled: true,
    manualAccessUnlimited: true,
    manualAccessExpiresAt: EXPIRY,
  }])
})

test("organization without a registered domain receives no automatic trial", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()

  assert.deepEqual(await createService(store).ensureTrial("org_1"), {
    granted: false,
    expiresAt: EXPIRY,
  })
  assert.deepEqual(store.grants, [])
  assert.deepEqual([...store.claims], [])
})

test("one trial consumes every normalized registered organization domain", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  store.domainsByOrg.set("org_1", [" Beta.Example ", "alpha.example"])

  assert.equal((await createService(store).ensureTrial("org_1")).granted, true)
  assert.deepEqual([...store.claims], [
    ["alpha.example", "org_1"],
    ["beta.example", "org_1"],
  ])
})

test("one historical domain claim blocks a mixed claimed and fresh domain set", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  store.domainsByOrg.set("org_2", ["used.example", "fresh.example"])
  store.claims.set("used.example", "org_1")

  assert.equal((await createService(store).ensureTrial("org_2")).granted, false)
  assert.equal(store.claims.has("fresh.example"), false)
  assert.equal(store.accounts.has("org_2"), false)
})

test("an existing manual trial backfills domains without changing its expiry", async () => {
  const originalExpiry = new Date("2026-07-30T15:30:00.000Z")
  const store = new FakeAutomaticOrganizationTrialStore()
  store.domainsByOrg.set("org_1", ["first.example", "later.example"])
  store.claims.set("first.example", "org_1")
  store.accounts.set("org_1", {
    source: "manual_trial",
    manualAccessExpiresAt: originalExpiry,
  })

  assert.equal((await createService(store).ensureTrial("org_1")).granted, false)
  assert.deepEqual([...store.claims], [
    ["first.example", "org_1"],
    ["later.example", "org_1"],
  ])
  assert.equal(store.accounts.get("org_1")?.manualAccessExpiresAt, originalExpiry)
  assert.deepEqual(store.grants, [])
})

test("an existing manual trial consumes fresh domains from a mixed foreign-claimed domain set", async () => {
  const originalExpiry = new Date("2026-07-30T15:30:00.000Z")
  const store = new FakeAutomaticOrganizationTrialStore()
  store.domainsByOrg.set("org_1", ["own.example", "fresh.example", "foreign.example"])
  store.claims.set("own.example", "org_1")
  store.claims.set("foreign.example", "org_2")
  store.accounts.set("org_1", {
    source: "manual_trial",
    manualAccessExpiresAt: originalExpiry,
  })

  assert.equal((await createService(store).ensureTrial("org_1")).granted, false)
  assert.deepEqual([...store.claims], [
    ["own.example", "org_1"],
    ["foreign.example", "org_2"],
    ["fresh.example", "org_1"],
  ])
  assert.equal(store.accounts.get("org_1")?.manualAccessExpiresAt, originalExpiry)
  assert.deepEqual(store.grants, [])
})

test("historical automatic-trial event backfills newly registered domains", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  store.domainsByOrg.set("org_1", ["later.example"])
  store.automaticTrialHistory.add("org_1")

  assert.equal((await createService(store).ensureTrial("org_1")).granted, false)
  assert.equal(store.claims.get("later.example"), "org_1")
  assert.equal(store.accounts.has("org_1"), false)
})

test("a paid or administrator-owned non-trial account is preserved without consuming domains", async () => {
  for (const source of ["stripe_subscription", "manual_external"] as const) {
    const store = new FakeAutomaticOrganizationTrialStore()
    const account: FakeBillingAccount = { source, manualAccessExpiresAt: null }
    store.domainsByOrg.set("org_1", [`${source}.example`])
    store.accounts.set("org_1", account)

    assert.equal((await createService(store).ensureTrial("org_1")).granted, false)
    assert.equal(store.accounts.get("org_1"), account)
    assert.equal(store.claims.size, 0)
  }
})

test("deleting and re-registering a consumed domain never grants another trial", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  const service = createService(store)
  store.domainsByOrg.set("org_1", ["consumed.example"])
  assert.equal((await service.ensureTrial("org_1")).granted, true)

  store.domainsByOrg.set("org_1", [])
  store.domainsByOrg.set("org_2", ["consumed.example"])

  assert.equal((await service.ensureTrial("org_2")).granted, false)
  assert.equal(store.claims.get("consumed.example"), "org_1")
  assert.equal(store.accounts.has("org_2"), false)
})

test("reconciliation skips domainless organizations and grants only an entirely unclaimed domain set", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  store.organizationIds = ["org_no_domain", "org_unclaimed", "org_mixed"]
  store.domainsByOrg.set("org_unclaimed", ["first.example", "second.example"])
  store.domainsByOrg.set("org_mixed", ["claimed.example", "fresh.example"])
  store.claims.set("claimed.example", "org_historical")

  const summary = await createService(store).reconcile()

  assert.deepEqual(summary, { scanned: 3, granted: 1 })
  assert.deepEqual(store.grants.map((entry) => entry.orgId), ["org_unclaimed"])
  assert.equal(store.accounts.has("org_no_domain"), false)
  assert.equal(store.accounts.has("org_mixed"), false)
  assert.equal(store.claims.has("fresh.example"), false)
})

test("reconciliation backfills fresh trial domains beside foreign claims without expiry changes and is safe to rerun", async () => {
  const manualExpiry = new Date("2026-07-28T00:00:00.000Z")
  const store = new FakeAutomaticOrganizationTrialStore()
  store.organizationIds = ["org_manual", "org_automatic"]
  store.domainsByOrg.set("org_manual", [
    "manual-first.example",
    "manual-later.example",
    "manual-foreign.example",
  ])
  store.domainsByOrg.set("org_automatic", ["automatic.example"])
  store.claims.set("manual-first.example", "org_manual")
  store.claims.set("manual-foreign.example", "org_other")
  store.accounts.set("org_manual", {
    source: "manual_trial",
    manualAccessExpiresAt: manualExpiry,
  })
  store.automaticTrialHistory.add("org_automatic")
  const service = createService(store)

  const firstSummary = await service.reconcile()
  assert.deepEqual(firstSummary, { scanned: 2, granted: 0 })
  assert.deepEqual(Object.keys(firstSummary).sort(), ["granted", "scanned"])
  assert.doesNotMatch(JSON.stringify(firstSummary), /example|@/i)
  assert.equal(store.claims.get("manual-first.example"), "org_manual")
  assert.equal(store.claims.get("manual-later.example"), "org_manual")
  assert.equal(store.claims.get("manual-foreign.example"), "org_other")
  assert.equal(store.claims.get("automatic.example"), "org_automatic")
  assert.equal(store.accounts.get("org_manual")?.manualAccessExpiresAt, manualExpiry)
  assert.deepEqual(store.grants, [])

  const claimsAfterFirstRun = [...store.claims]
  assert.deepEqual(await service.reconcile(), { scanned: 2, granted: 0 })
  assert.deepEqual([...store.claims], claimsAfterFirstRun)
  assert.equal(store.accounts.get("org_manual")?.manualAccessExpiresAt, manualExpiry)
  assert.deepEqual(store.grants, [])
})

test("concurrent organizations cannot both consume the same domain", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  store.domainsByOrg.set("org_1", ["race.example"])
  store.domainsByOrg.set("org_2", ["race.example"])
  const service = createService(store)

  const results = await Promise.all([
    service.ensureTrial("org_1"),
    service.ensureTrial("org_2"),
  ])

  assert.equal(results.filter((entry) => entry.granted).length, 1)
  assert.equal(store.grants.length, 1)
  assert.equal(store.claims.get("race.example"), store.grants[0]?.orgId)
})

test("rejects a blank organization id before calling the store", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()

  await assert.rejects(createService(store).ensureTrial("  "), {
    message: "automatic_organization_trial_org_id_required",
  })
  assert.deepEqual(store.grants, [])
})
