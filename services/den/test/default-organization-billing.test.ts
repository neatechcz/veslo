import assert from "node:assert/strict"
import test from "node:test"

process.env.DATABASE_URL ??= "mysql://veslo:veslo@127.0.0.1:3306/veslo_test"
process.env.BETTER_AUTH_SECRET ??= "test-secret-with-enough-characters"

type CreatedOrganization = { id: string; name: string; slug: string; ownerUserId: string }
type CreatedMembership = { id: string; orgId: string; userId: string; role: "organization_admin" }
type CreatedBillingAccount = {
  id: string
  orgId: string
  mode: "manual_access"
  source: "manual_trial"
  status: "trialing"
  manualAccessEnabled: true
  manualAccessUnlimited: true
  manualAccessExpiresAt: null
}

type DefaultOrgTransaction = {
  findMembershipOrgId(userId: string): Promise<string | null>
  createOrganization(record: CreatedOrganization): Promise<void>
  createMembership(record: CreatedMembership): Promise<void>
  ensureBillingAccount(record: CreatedBillingAccount): Promise<void>
}

type EnsureDefaultOrgWithStore = (
  store: { transaction<T>(callback: (transaction: DefaultOrgTransaction) => Promise<T>): Promise<T> },
  userId: string,
  name: string,
  createId: () => string,
) => Promise<string>

function createTransactionalStore(input: {
  existingOrgId?: string
  existingBillingAccount?: CreatedBillingAccount
  failBilling?: boolean
} = {}) {
  const committed = {
    organizations: [] as CreatedOrganization[],
    memberships: [] as CreatedMembership[],
    billingAccounts: input.existingBillingAccount ? [input.existingBillingAccount] : [] as CreatedBillingAccount[],
  }

  return {
    committed,
    store: {
      async transaction<T>(callback: (transaction: DefaultOrgTransaction) => Promise<T>) {
        const pending = {
          organizations: [...committed.organizations],
          memberships: [...committed.memberships],
          billingAccounts: [...committed.billingAccounts],
        }
        const transaction: DefaultOrgTransaction = {
          async findMembershipOrgId() {
            return input.existingOrgId ?? pending.memberships[0]?.orgId ?? null
          },
          async createOrganization(record) {
            pending.organizations.push(record)
          },
          async createMembership(record) {
            pending.memberships.push(record)
          },
          async ensureBillingAccount(record) {
            if (input.failBilling) {
              throw new Error("billing insert failed")
            }
            if (!pending.billingAccounts.some((account) => account.orgId === record.orgId)) {
              pending.billingAccounts.push(record)
            }
          },
        }

        const result = await callback(transaction)
        committed.organizations.splice(0, committed.organizations.length, ...pending.organizations)
        committed.memberships.splice(0, committed.memberships.length, ...pending.memberships)
        committed.billingAccounts.splice(0, committed.billingAccounts.length, ...pending.billingAccounts)
        return result
      },
    },
  }
}

async function loadEnsureDefaultOrgWithStore() {
  const module = await import("../src/orgs.js") as Record<string, unknown>
  assert.equal(typeof module.ensureDefaultOrgWithStore, "function")
  return module.ensureDefaultOrgWithStore as EnsureDefaultOrgWithStore
}

test("new default organization receives unlimited trial in the same transaction", async () => {
  const ensureDefaultOrgWithStore = await loadEnsureDefaultOrgWithStore()
  const { store, committed } = createTransactionalStore()
  const ids = ["org_12345678", "membership_1", "billing_1"]

  const orgId = await ensureDefaultOrgWithStore(store, "user_1", "Personal", () => ids.shift()!)

  assert.equal(orgId, "org_12345678")
  assert.deepEqual(committed.organizations, [{
    id: "org_12345678",
    name: "Personal",
    slug: "personal-org_1234",
    ownerUserId: "user_1",
  }])
  assert.deepEqual(committed.memberships, [{
    id: "membership_1",
    orgId: "org_12345678",
    userId: "user_1",
    role: "organization_admin",
  }])
  assert.deepEqual(committed.billingAccounts, [{
    id: "billing_1",
    orgId: "org_12345678",
    mode: "manual_access",
    source: "manual_trial",
    status: "trialing",
    manualAccessEnabled: true,
    manualAccessUnlimited: true,
    manualAccessExpiresAt: null,
  }])
})

test("existing default organization created during deployment receives a missing unlimited trial", async () => {
  const ensureDefaultOrgWithStore = await loadEnsureDefaultOrgWithStore()
  const { store, committed } = createTransactionalStore({ existingOrgId: "org_existing" })

  assert.equal(await ensureDefaultOrgWithStore(store, "user_1", "Personal", () => "unused"), "org_existing")
  assert.deepEqual(committed.billingAccounts, [{
    id: "unused",
    orgId: "org_existing",
    mode: "manual_access",
    source: "manual_trial",
    status: "trialing",
    manualAccessEnabled: true,
    manualAccessUnlimited: true,
    manualAccessExpiresAt: null,
  }])
})

test("existing default organization keeps an existing revoked billing row", async () => {
  const ensureDefaultOrgWithStore = await loadEnsureDefaultOrgWithStore()
  const existingBillingAccount: CreatedBillingAccount = {
    id: "billing_existing",
    orgId: "org_existing",
    mode: "manual_access",
    source: "manual_trial",
    status: "trialing",
    manualAccessEnabled: true,
    manualAccessUnlimited: true,
    manualAccessExpiresAt: null,
  }
  const { store, committed } = createTransactionalStore({
    existingOrgId: "org_existing",
    existingBillingAccount,
  })

  assert.equal(await ensureDefaultOrgWithStore(store, "user_1", "Personal", () => "unused"), "org_existing")
  assert.deepEqual(committed.billingAccounts, [existingBillingAccount])
})

test("failed default billing insert rolls back organization and membership", async () => {
  const ensureDefaultOrgWithStore = await loadEnsureDefaultOrgWithStore()
  const { store, committed } = createTransactionalStore({ failBilling: true })
  const ids = ["org_12345678", "membership_1", "billing_1"]

  await assert.rejects(
    ensureDefaultOrgWithStore(store, "user_1", "Personal", () => ids.shift()!),
    /billing insert failed/,
  )
  assert.deepEqual(committed, { organizations: [], memberships: [], billingAccounts: [] })
})
