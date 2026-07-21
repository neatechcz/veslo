import assert from "node:assert/strict"
import test from "node:test"

import {
  AUTOMATIC_ORGANIZATION_TRIAL_DAYS,
  createAutomaticOrganizationTrialService,
  type AutomaticOrganizationTrialGrant,
  type AutomaticOrganizationTrialStore,
} from "../src/billing/automatic-organization-trial.js"

class FakeAutomaticOrganizationTrialStore implements AutomaticOrganizationTrialStore {
  organizationIds: string[] = []
  configured = new Set<string>()
  grants: AutomaticOrganizationTrialGrant[] = []

  async listOrganizationIds() {
    return [...this.organizationIds]
  }

  async grantTrialIfUnconfigured(input: AutomaticOrganizationTrialGrant) {
    if (this.configured.has(input.orgId)) {
      return false
    }
    this.configured.add(input.orgId)
    this.grants.push(input)
    return true
  }
}

const NOW = new Date("2026-07-21T00:00:00.000Z")
const EXPIRY = new Date("2026-08-04T00:00:00.000Z")

test("automatic organization trial duration is 14 days", () => {
  assert.equal(AUTOMATIC_ORGANIZATION_TRIAL_DAYS, 14)
})

test("grants an unconfigured organization one 14-day unlimited trial", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  const service = createAutomaticOrganizationTrialService({ store, now: () => NOW })

  const result = await service.ensureTrial("org_1")

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

test("does not replace any existing billing account or recalculate its expiry", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  store.configured.add("org_1")
  const service = createAutomaticOrganizationTrialService({ store, now: () => NOW })

  assert.deepEqual(await service.ensureTrial("org_1"), { granted: false, expiresAt: EXPIRY })
  assert.deepEqual(store.grants, [])
})

test("reconciliation grants each unconfigured organization only once", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  store.organizationIds = ["org_1", "org_2"]
  store.configured.add("org_2")
  const service = createAutomaticOrganizationTrialService({ store, now: () => NOW })

  assert.deepEqual(await service.reconcile(), { scanned: 2, granted: 1 })
  assert.deepEqual(await service.reconcile(), { scanned: 2, granted: 0 })
  assert.deepEqual(store.grants.map((entry) => entry.orgId), ["org_1"])
})

test("concurrent initialization cannot create two trials for one organization", async () => {
  const store = new FakeAutomaticOrganizationTrialStore()
  const service = createAutomaticOrganizationTrialService({ store, now: () => NOW })

  const results = await Promise.all([
    service.ensureTrial("org_1"),
    service.ensureTrial("org_1"),
  ])

  assert.equal(results.filter((entry) => entry.granted).length, 1)
  assert.equal(store.grants.length, 1)
})
