import assert from "node:assert/strict"
import test from "node:test"

import {
  createDrizzleAutomaticOrganizationTrialStore,
  type AutomaticOrganizationTrialGrant,
} from "../src/billing/automatic-organization-trial.js"
import {
  OrganizationBillingAccountTable,
  OrganizationBillingEventTable,
  OrganizationDomainTable,
  OrganizationTrialDomainClaimTable,
  OrgTable,
} from "../src/db/schema.js"

type RawRow = Record<string, unknown>

type HarnessState = {
  organizations: string[]
  domains: Array<{ id: string; org_id: string; domain: string }>
  claims: Map<string, RawRow>
  accounts: Map<string, RawRow>
  events: Map<string, RawRow>
}

type HarnessOptions = {
  organizations?: string[]
  domains?: Array<{ orgId: string; domain: string }>
  claims?: Array<{ domain: string; orgId: string }>
  accounts?: RawRow[]
  events?: RawRow[]
  duplicateClaimDomains?: string[]
  claimInsertError?: unknown
  accountInsertError?: unknown
  eventInsertError?: unknown
}

const TRIAL_EXPIRY = new Date("2026-08-04T00:00:00.000Z")
const TRIAL_CREATED_AT = new Date("2026-07-21T00:00:00.000Z")

function grantInput(orgId = "org_1"): AutomaticOrganizationTrialGrant {
  return {
    orgId,
    mode: "manual_access",
    source: "manual_trial",
    status: "active",
    manualAccessEnabled: true,
    manualAccessUnlimited: true,
    manualAccessExpiresAt: TRIAL_EXPIRY,
  }
}

function automaticHistoryId(orgId: string) {
  return `automatic_organization_trial:${orgId}`
}

function duplicateKeyError() {
  return Object.assign(new Error("Duplicate entry for organization_trial_domain_claim_domain"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sqlState: "23000",
  })
}

function cloneState(state: HarnessState): HarnessState {
  return {
    organizations: [...state.organizations],
    domains: state.domains.map((entry) => ({ ...entry })),
    claims: new Map([...state.claims].map(([key, value]) => [key, { ...value }])),
    accounts: new Map([...state.accounts].map(([key, value]) => [key, { ...value }])),
    events: new Map([...state.events].map(([key, value]) => [key, { ...value }])),
  }
}

function replaceState(target: HarnessState, source: HarnessState) {
  target.organizations = source.organizations
  target.domains = source.domains
  target.claims = source.claims
  target.accounts = source.accounts
  target.events = source.events
}

function sqlParameterValues(expression: unknown): unknown[] {
  if (!expression || typeof expression !== "object") {
    return []
  }

  const candidate = expression as {
    constructor?: { name?: string }
    value?: unknown
    queryChunks?: unknown[]
  }
  if (candidate.constructor?.name === "Param") {
    return [candidate.value]
  }
  if (Array.isArray(expression)) {
    return expression.flatMap(sqlParameterValues)
  }
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.flatMap(sqlParameterValues)
  }
  return []
}

function createDatabaseHarness(options: HarnessOptions = {}) {
  const state: HarnessState = {
    organizations: options.organizations ?? ["org_1"],
    domains: (options.domains ?? []).map((entry, index) => ({
      id: `domain_${index + 1}`,
      org_id: entry.orgId,
      domain: entry.domain,
    })),
    claims: new Map((options.claims ?? []).map((entry, index) => [entry.domain, {
      id: `claim_${index + 1}`,
      domain: entry.domain,
      org_id: entry.orgId,
      claimed_at: TRIAL_CREATED_AT,
    }])),
    accounts: new Map((options.accounts ?? []).map((entry) => [String(entry.org_id), { ...entry }])),
    events: new Map((options.events ?? []).map((entry) => [String(entry.stripe_event_id), { ...entry }])),
  }
  const operations: string[] = []
  const isolationLevels: string[] = []
  const duplicateClaimDomains = new Set(options.duplicateClaimDomains ?? [])

  function project(selection: Record<string, any>, row: RawRow) {
    return Object.fromEntries(Object.entries(selection).map(([alias, column]) => [alias, row[column.name]]))
  }

  function rowsFor(
    snapshot: HarnessState,
    table: unknown,
    selection: Record<string, any>,
    parameters: unknown[],
    ordered: boolean,
    limit: number | null,
  ) {
    const stringParameters = parameters.filter((entry): entry is string => typeof entry === "string")
    let rows: RawRow[]
    if (table === OrgTable) {
      rows = snapshot.organizations
        .filter((id) => stringParameters.length === 0 || stringParameters.includes(id))
        .map((id) => ({ id }))
    } else if (table === OrganizationDomainTable) {
      rows = snapshot.domains.filter((entry) => stringParameters.length === 0 || stringParameters.includes(entry.org_id))
      if (ordered) {
        rows.sort((left, right) => String(left.domain).localeCompare(String(right.domain)))
      }
    } else if (table === OrganizationTrialDomainClaimTable) {
      rows = [...snapshot.claims.values()]
        .filter((entry) => stringParameters.length === 0 || stringParameters.includes(String(entry.domain)))
    } else if (table === OrganizationBillingAccountTable) {
      rows = [...snapshot.accounts.values()]
        .filter((entry) => stringParameters.length === 0 || stringParameters.includes(String(entry.org_id)))
    } else if (table === OrganizationBillingEventTable) {
      rows = [...snapshot.events.values()]
        .filter((entry) => stringParameters.length === 0 || stringParameters.includes(String(entry.stripe_event_id)))
    } else {
      throw new Error("automatic_trial_store_test_unknown_select_table")
    }

    const selected = rows.map((row) => project(selection, row))
    return limit === null ? selected : selected.slice(0, limit)
  }

  function createQuery(snapshot: HarnessState, selection: Record<string, any>) {
    let table: unknown
    let parameters: unknown[] = []
    let ordered = false
    let limit: number | null = null

    const query = {
      from(nextTable: unknown) {
        table = nextTable
        return query
      },
      where(expression: unknown) {
        parameters = sqlParameterValues(expression)
        return query
      },
      orderBy(..._expressions: unknown[]) {
        ordered = true
        operations.push("select:domains:stable-order")
        return query
      },
      limit(nextLimit: number) {
        limit = nextLimit
        return query
      },
      for(lock: string) {
        const tableName = table === OrgTable
          ? "organization"
          : table === OrganizationDomainTable
            ? "domains"
            : table === OrganizationBillingAccountTable
              ? "account"
              : table === OrganizationBillingEventTable
                ? "history"
                : table === OrganizationTrialDomainClaimTable
                  ? "claims"
                  : "other"
        operations.push(`lock:${tableName}:${lock}`)
        return query
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(rowsFor(snapshot, table, selection, parameters, ordered, limit))
          .then(onfulfilled, onrejected)
      },
    }
    return query
  }

  function createConnection(snapshot: HarnessState) {
    return {
      select(selection: Record<string, any>) {
        return createQuery(snapshot, selection)
      },
      insert(table: unknown) {
        return {
          async values(input: RawRow | RawRow[]) {
            const rows = Array.isArray(input) ? input : [input]
            if (table === OrganizationTrialDomainClaimTable) {
              for (const row of rows) {
                const domain = String(row.domain)
                operations.push(`insert:claim:${domain}`)
                if (options.claimInsertError) {
                  throw options.claimInsertError
                }
                if (duplicateClaimDomains.has(domain) || snapshot.claims.has(domain)) {
                  throw duplicateKeyError()
                }
                snapshot.claims.set(domain, { ...row })
              }
              return
            }
            if (table === OrganizationBillingAccountTable) {
              const row = rows[0]
              assert.ok(row)
              const orgId = String(row.org_id)
              operations.push(`insert:account:${orgId}`)
              if (options.accountInsertError) {
                throw options.accountInsertError
              }
              if (snapshot.accounts.has(orgId)) {
                throw duplicateKeyError()
              }
              snapshot.accounts.set(orgId, { ...row })
              return
            }
            if (table === OrganizationBillingEventTable) {
              const row = rows[0]
              assert.ok(row)
              const eventId = String(row.stripe_event_id)
              operations.push(`insert:event:${eventId}`)
              if (options.eventInsertError) {
                throw options.eventInsertError
              }
              if (snapshot.events.has(eventId)) {
                throw duplicateKeyError()
              }
              snapshot.events.set(eventId, { ...row })
              return
            }
            throw new Error("automatic_trial_store_test_unknown_insert_table")
          },
        }
      },
    }
  }

  const database = {
    ...createConnection(state),
    async transaction<T>(callback: (transaction: ReturnType<typeof createConnection>) => Promise<T>, config: {
      isolationLevel?: string
    } = {}) {
      isolationLevels.push(config.isolationLevel ?? "")
      const snapshot = cloneState(state)
      const result = await callback(createConnection(snapshot))
      replaceState(state, snapshot)
      return result
    },
  }

  return { database, isolationLevels, operations, state }
}

test("store skips organizations without registered domains after locking the organization", async () => {
  const harness = createDatabaseHarness()
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput()), { granted: false })
  assert.deepEqual([...harness.state.claims], [])
  assert.deepEqual([...harness.state.accounts], [])
  assert.deepEqual([...harness.state.events], [])
  assert.deepEqual(harness.isolationLevels, ["serializable"])
  assert.equal(harness.operations[0], "lock:organization:update")
})

test("store atomically consumes all current domains and creates the unlimited manual trial", async () => {
  const harness = createDatabaseHarness({
    domains: [
      { orgId: "org_1", domain: " Beta.Example " },
      { orgId: "org_1", domain: "alpha.example" },
    ],
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput()), { granted: true })
  assert.deepEqual([...harness.state.claims].map(([domain, claim]) => [domain, claim.org_id]), [
    ["alpha.example", "org_1"],
    ["beta.example", "org_1"],
  ])
  assert.deepEqual(harness.isolationLevels, ["serializable"])
  assert.deepEqual(harness.operations.filter((entry) => entry.startsWith("lock:")), [
    "lock:organization:update",
    "lock:domains:update",
    "lock:account:update",
    "lock:history:update",
    "lock:claims:update",
  ])
  assert.ok(harness.operations.includes("select:domains:stable-order"))
  const account = harness.state.accounts.get("org_1")
  assert.equal(account?.mode, "manual_access")
  assert.equal(account?.source, "manual_trial")
  assert.equal(account?.status, "active")
  assert.equal(account?.manual_access_enabled, true)
  assert.equal(account?.manual_access_unlimited, true)
  assert.equal(account?.manual_access_expires_at, TRIAL_EXPIRY)
  assert.equal(account?.created_at instanceof Date && account.created_at.getTime(), TRIAL_CREATED_AT.getTime())
  assert.equal(harness.state.events.get(automaticHistoryId("org_1"))?.status, "applied")
})

test("store rejects a mixed claimed and fresh domain set without partial writes", async () => {
  const harness = createDatabaseHarness({
    domains: [
      { orgId: "org_2", domain: "used.example" },
      { orgId: "org_2", domain: "fresh.example" },
    ],
    claims: [{ domain: "used.example", orgId: "org_1" }],
    organizations: ["org_2"],
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput("org_2")), { granted: false })
  assert.equal(harness.state.claims.has("fresh.example"), false)
  assert.equal(harness.state.accounts.has("org_2"), false)
  assert.equal(harness.state.events.has(automaticHistoryId("org_2")), false)
})

test("store backfills an existing manual trial without changing billing dates", async () => {
  const originalExpiry = new Date("2026-07-29T10:15:00.000Z")
  const originalUpdatedAt = new Date("2026-07-15T10:15:00.000Z")
  const harness = createDatabaseHarness({
    domains: [
      { orgId: "org_1", domain: "existing.example" },
      { orgId: "org_1", domain: "later.example" },
    ],
    claims: [{ domain: "existing.example", orgId: "org_1" }],
    accounts: [{
      id: "billing_existing",
      org_id: "org_1",
      source: "manual_trial",
      manual_access_expires_at: originalExpiry,
      updated_at: originalUpdatedAt,
    }],
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput()), { granted: false })
  assert.equal(harness.state.claims.get("later.example")?.org_id, "org_1")
  assert.equal(harness.state.accounts.get("org_1")?.manual_access_expires_at, originalExpiry)
  assert.equal(harness.state.accounts.get("org_1")?.updated_at, originalUpdatedAt)
  assert.equal(harness.operations.some((entry) => entry.startsWith("insert:account:")), false)
  assert.equal(harness.operations.some((entry) => entry.startsWith("insert:event:")), false)
})

test("store does not partially backfill an existing trial with a foreign-claimed current domain", async () => {
  const originalExpiry = new Date("2026-07-29T10:15:00.000Z")
  const originalUpdatedAt = new Date("2026-07-15T10:15:00.000Z")
  const harness = createDatabaseHarness({
    domains: [
      { orgId: "org_1", domain: "own.example" },
      { orgId: "org_1", domain: "fresh.example" },
      { orgId: "org_1", domain: "foreign.example" },
    ],
    claims: [
      { domain: "own.example", orgId: "org_1" },
      { domain: "foreign.example", orgId: "org_2" },
    ],
    accounts: [{
      id: "billing_existing",
      org_id: "org_1",
      source: "manual_trial",
      manual_access_expires_at: originalExpiry,
      updated_at: originalUpdatedAt,
    }],
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput()), { granted: false })
  assert.equal(harness.state.claims.get("own.example")?.org_id, "org_1")
  assert.equal(harness.state.claims.get("foreign.example")?.org_id, "org_2")
  assert.equal(harness.state.claims.has("fresh.example"), false)
  assert.equal(harness.state.accounts.get("org_1")?.manual_access_expires_at, originalExpiry)
  assert.equal(harness.state.accounts.get("org_1")?.updated_at, originalUpdatedAt)
  assert.equal(harness.operations.some((entry) => entry.startsWith("insert:")), false)
})

test("store uses historical automatic-trial event to backfill claims without creating billing", async () => {
  const historyId = automaticHistoryId("org_1")
  const harness = createDatabaseHarness({
    domains: [{ orgId: "org_1", domain: "later.example" }],
    events: [{
      id: "event_existing",
      org_id: "org_1",
      stripe_event_id: historyId,
      status: "applied",
    }],
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput()), { granted: false })
  assert.equal(harness.state.claims.get("later.example")?.org_id, "org_1")
  assert.equal(harness.state.accounts.has("org_1"), false)
  assert.equal(harness.state.events.size, 1)
})

test("store preserves non-trial billing without consuming domain claims", async () => {
  for (const source of ["stripe_subscription", "manual_external"] as const) {
    const harness = createDatabaseHarness({
      domains: [{ orgId: "org_1", domain: `${source}.example` }],
      accounts: [{
        id: `billing_${source}`,
        org_id: "org_1",
        source,
        manual_access_expires_at: null,
      }],
    })
    const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

    assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput()), { granted: false })
    assert.equal(harness.state.claims.size, 0)
    assert.equal(harness.state.accounts.get("org_1")?.source, source)
  }
})

test("store retains a deleted domain claim and blocks it after re-registration", async () => {
  const harness = createDatabaseHarness({
    organizations: ["org_1", "org_2"],
    domains: [{ orgId: "org_1", domain: "consumed.example" }],
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)
  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput("org_1")), { granted: true })

  harness.state.domains = [{ id: "domain_recreated", org_id: "org_2", domain: "consumed.example" }]

  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput("org_2")), { granted: false })
  assert.equal(harness.state.claims.get("consumed.example")?.org_id, "org_1")
  assert.equal(harness.state.accounts.has("org_2"), false)
})

test("duplicate-key claim race rolls back every claim and billing write", async () => {
  const harness = createDatabaseHarness({
    domains: [
      { orgId: "org_1", domain: "alpha.example" },
      { orgId: "org_1", domain: "beta.example" },
    ],
    duplicateClaimDomains: ["beta.example"],
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  assert.deepEqual(await store.grantOrSyncDomainTrial(grantInput()), { granted: false })
  assert.equal(harness.operations.includes("insert:claim:alpha.example"), true)
  assert.equal(harness.operations.includes("insert:claim:beta.example"), true)
  assert.equal(harness.state.claims.size, 0)
  assert.equal(harness.state.accounts.size, 0)
  assert.equal(harness.state.events.size, 0)
})

test("account insert failure rolls back all preceding domain claims and propagates", async () => {
  const accountFailure = new Error("account_insert_failed")
  const harness = createDatabaseHarness({
    domains: [{ orgId: "org_1", domain: "account-failure.example" }],
    accountInsertError: accountFailure,
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  await assert.rejects(store.grantOrSyncDomainTrial(grantInput()), accountFailure)
  assert.equal(harness.operations.includes("insert:claim:account-failure.example"), true)
  assert.equal(harness.operations.includes("insert:account:org_1"), true)
  assert.equal(harness.state.claims.size, 0)
  assert.equal(harness.state.accounts.size, 0)
  assert.equal(harness.state.events.size, 0)
})

test("event insert failure rolls back domain claims and billing account and propagates", async () => {
  const eventFailure = new Error("event_insert_failed")
  const harness = createDatabaseHarness({
    domains: [{ orgId: "org_1", domain: "event-failure.example" }],
    eventInsertError: eventFailure,
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  await assert.rejects(store.grantOrSyncDomainTrial(grantInput()), eventFailure)
  assert.equal(harness.operations.includes("insert:claim:event-failure.example"), true)
  assert.equal(harness.operations.includes("insert:account:org_1"), true)
  assert.equal(harness.operations.includes(`insert:event:${automaticHistoryId("org_1")}`), true)
  assert.equal(harness.state.claims.size, 0)
  assert.equal(harness.state.accounts.size, 0)
  assert.equal(harness.state.events.size, 0)
})

test("store does not swallow unrelated transaction failures", async () => {
  const databaseFailure = new Error("database_unavailable")
  const harness = createDatabaseHarness({
    domains: [{ orgId: "org_1", domain: "failure.example" }],
    claimInsertError: databaseFailure,
  })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  await assert.rejects(store.grantOrSyncDomainTrial(grantInput()), databaseFailure)
  assert.equal(harness.state.claims.size, 0)
  assert.equal(harness.state.accounts.size, 0)
  assert.equal(harness.state.events.size, 0)
})

test("listOrganizationIds returns every organization id", async () => {
  const harness = createDatabaseHarness({ organizations: ["org_1", "org_2"] })
  const store = createDrizzleAutomaticOrganizationTrialStore(harness.database)

  assert.deepEqual(await store.listOrganizationIds(), ["org_1", "org_2"])
})
