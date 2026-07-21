import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import {
  OrganizationDomainVerifiedMemberRequiredError,
  createOrganizationDomainVerifier,
} from "../src/org-admin/domain-verification.js"
import {
  OrganizationDomainExistsError,
  createDrizzleOrganizationDomainMutationStore,
  createOrganizationDomainMutationService,
  type OrganizationDomainMutationRecord,
  type OrganizationDomainMutationScope,
} from "../src/org-admin/domain-mutations.js"
import { createAdminRouter } from "../src/http/admin.js"
import { errorMiddleware } from "../src/http/errors.js"

type Member = {
  orgId: string
  userId: string
  email: string
  emailVerified: boolean
  membershipStatus: "active" | "disabled" | "removed"
}

function createVerifier(members: Member[]) {
  return createOrganizationDomainVerifier({
    async listMembers() {
      return members
    },
  })
}

async function assertProofRequired(members: Member[], orgId = "org_1", domain = "team.example.com") {
  await assert.rejects(
    createVerifier(members).requireVerifiedMember(orgId, domain),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationDomainVerifiedMemberRequiredError)
      assert.equal(error.code, "domain_verified_member_required")
      return true
    },
  )
}

test("active verified exact-domain member proves organization ownership", async () => {
  const verifier = createVerifier([{
    orgId: "org_1",
    userId: "user_1",
    email: " Owner@Team.Example.com ",
    emailVerified: true,
    membershipStatus: "active",
  }])

  assert.deepEqual(
    await verifier.requireVerifiedMember("org_1", "team.example.com"),
    { userId: "user_1" },
  )
})

test("verification evidence is deterministic when multiple members match", async () => {
  const verifier = createVerifier([
    {
      orgId: "org_1",
      userId: "user_z",
      email: "z@team.example.com",
      emailVerified: true,
      membershipStatus: "active",
    },
    {
      orgId: "org_1",
      userId: "user_a",
      email: "a@team.example.com",
      emailVerified: true,
      membershipStatus: "active",
    },
  ])

  assert.deepEqual(
    await verifier.requireVerifiedMember("org_1", "TEAM.EXAMPLE.COM"),
    { userId: "user_a" },
  )
})

test("an unverified member cannot prove a domain", async () => {
  await assertProofRequired([{
    orgId: "org_1",
    userId: "user_1",
    email: "owner@team.example.com",
    emailVerified: false,
    membershipStatus: "active",
  }])
})

test("disabled and removed memberships cannot prove a domain", async () => {
  for (const membershipStatus of ["disabled", "removed"] as const) {
    await assertProofRequired([{
      orgId: "org_1",
      userId: `user_${membershipStatus}`,
      email: "owner@team.example.com",
      emailVerified: true,
      membershipStatus,
    }])
  }
})

test("a verified member of another organization cannot prove a domain", async () => {
  await assertProofRequired([{
    orgId: "org_other",
    userId: "user_1",
    email: "owner@team.example.com",
    emailVerified: true,
    membershipStatus: "active",
  }])
})

test("parent and subdomain emails do not prove a different exact domain", async () => {
  await assertProofRequired([{
    orgId: "org_1",
    userId: "user_parent",
    email: "owner@example.com",
    emailVerified: true,
    membershipStatus: "active",
  }])
  await assertProofRequired([{
    orgId: "org_1",
    userId: "user_child",
    email: "owner@child.team.example.com",
    emailVerified: true,
    membershipStatus: "active",
  }])
})

function createMutationHarness(input: {
  members?: Member[]
  domains?: OrganizationDomainMutationRecord[]
  trialError?: Error
} = {}) {
  let domains = structuredClone(input.domains ?? [])
  const calls: string[] = []
  const verifier = createVerifier(input.members ?? [])

  const service = createOrganizationDomainMutationService({
    store: {
      async transaction<T>(run: (scope: OrganizationDomainMutationScope) => Promise<T>) {
        const snapshot = structuredClone(domains)
        calls.push("transaction:serializable")
        try {
          const result = await run({
            async findById(orgId, domainId) {
              calls.push(`find-id:${orgId}:${domainId}`)
              return domains.find((entry) => entry.orgId === orgId && entry.id === domainId) ?? null
            },
            async findByDomain(domain) {
              calls.push(`find-domain:${domain}`)
              return domains.find((entry) => entry.domain === domain) ?? null
            },
            async requireVerifiedMember(orgId, domain) {
              calls.push(`verify:${orgId}:${domain}`)
              return verifier.requireVerifiedMember(orgId, domain)
            },
            async insert(entry) {
              calls.push(`insert:${entry.domain}`)
              domains.push({ ...entry })
            },
            async update(orgId, domainId, update) {
              calls.push(`update:${domainId}:${Object.keys(update).sort().join(",")}`)
              domains = domains.map((entry) => (
                entry.orgId === orgId && entry.id === domainId
                  ? { ...entry, ...update }
                  : entry
              ))
            },
            async synchronizeTrial(orgId) {
              assert.ok(domains.some((entry) => entry.orgId === orgId), "domain must exist before trial sync")
              calls.push(`trial:${orgId}`)
              if (input.trialError) throw input.trialError
            },
          })
          calls.push("transaction:commit")
          return result
        } catch (error) {
          domains = snapshot
          calls.push("transaction:rollback")
          throw error
        }
      },
    },
  })

  return {
    service,
    calls,
    get domains() {
      return structuredClone(domains)
    },
  }
}

test("domain creation without verified member evidence writes nothing", async () => {
  const harness = createMutationHarness()

  await assert.rejects(
    harness.service.create({
      id: "domain_1",
      orgId: "org_1",
      domain: "team.example.com",
      enabled: true,
      selfSignupEnabled: false,
    }),
    OrganizationDomainVerifiedMemberRequiredError,
  )

  assert.deepEqual(harness.domains, [])
  assert.equal(harness.calls.includes("insert:team.example.com"), false)
  assert.equal(harness.calls.includes("trial:org_1"), false)
})

test("verified domain creation inserts before trial synchronization and returns safe evidence", async () => {
  const harness = createMutationHarness({
    members: [{
      orgId: "org_1",
      userId: "user_verified",
      email: "owner@team.example.com",
      emailVerified: true,
      membershipStatus: "active",
    }],
  })

  const result = await harness.service.create({
    id: "domain_1",
    orgId: "org_1",
    domain: "team.example.com",
    enabled: true,
    selfSignupEnabled: false,
  })

  assert.equal(result.verifiedMemberUserId, "user_verified")
  assert.equal(result.domain.domain, "team.example.com")
  assert.ok(harness.calls.indexOf("insert:team.example.com") < harness.calls.indexOf("trial:org_1"))
})

test("trial synchronization failure rolls domain creation back", async () => {
  const harness = createMutationHarness({
    members: [{
      orgId: "org_1",
      userId: "user_verified",
      email: "owner@team.example.com",
      emailVerified: true,
      membershipStatus: "active",
    }],
    trialError: new Error("billing unavailable"),
  })

  await assert.rejects(
    harness.service.create({
      id: "domain_1",
      orgId: "org_1",
      domain: "team.example.com",
      enabled: true,
      selfSignupEnabled: false,
    }),
    /billing unavailable/,
  )
  assert.deepEqual(harness.domains, [])
  assert.equal(harness.calls.at(-1), "transaction:rollback")
})

test("domain rename requires evidence and rolls back when none exists", async () => {
  const harness = createMutationHarness({
    domains: [{
      id: "domain_1",
      orgId: "org_1",
      domain: "old.example.com",
      enabled: true,
      selfSignupEnabled: false,
    }],
  })

  await assert.rejects(
    harness.service.update({
      orgId: "org_1",
      domainId: "domain_1",
      domain: "new.example.com",
    }),
    OrganizationDomainVerifiedMemberRequiredError,
  )

  assert.equal(harness.domains[0].domain, "old.example.com")
  assert.equal(harness.calls.some((entry) => entry.startsWith("update:")), false)
  assert.equal(harness.calls.includes("trial:org_1"), false)
})

test("trial synchronization failure rolls a verified domain rename back", async () => {
  const harness = createMutationHarness({
    domains: [{
      id: "domain_1",
      orgId: "org_1",
      domain: "old.example.com",
      enabled: true,
      selfSignupEnabled: false,
    }],
    members: [{
      orgId: "org_1",
      userId: "user_verified",
      email: "owner@new.example.com",
      emailVerified: true,
      membershipStatus: "active",
    }],
    trialError: new Error("billing unavailable"),
  })

  await assert.rejects(
    harness.service.update({
      orgId: "org_1",
      domainId: "domain_1",
      domain: "new.example.com",
    }),
    /billing unavailable/,
  )

  assert.equal(harness.domains[0].domain, "old.example.com")
  assert.equal(harness.calls.at(-1), "transaction:rollback")
})

test("settings-only and same-normalized-domain updates do not require fresh evidence", async () => {
  const harness = createMutationHarness({
    domains: [{
      id: "domain_1",
      orgId: "org_1",
      domain: "team.example.com",
      enabled: true,
      selfSignupEnabled: false,
    }],
  })

  await harness.service.update({
    orgId: "org_1",
    domainId: "domain_1",
    enabled: false,
  })
  await harness.service.update({
    orgId: "org_1",
    domainId: "domain_1",
    domain: "team.example.com",
    selfSignupEnabled: true,
  })

  assert.equal(harness.domains[0].enabled, false)
  assert.equal(harness.domains[0].selfSignupEnabled, true)
  assert.equal(harness.calls.some((entry) => entry.startsWith("verify:")), false)
  assert.equal(harness.calls.includes("trial:org_1"), false)
})

test("duplicate domain conflict takes precedence over missing verification evidence", async () => {
  const harness = createMutationHarness({
    domains: [{
      id: "domain_existing",
      orgId: "org_other",
      domain: "team.example.com",
      enabled: true,
      selfSignupEnabled: false,
    }],
  })

  await assert.rejects(
    harness.service.create({
      id: "domain_1",
      orgId: "org_1",
      domain: "team.example.com",
      enabled: true,
      selfSignupEnabled: false,
    }),
    OrganizationDomainExistsError,
  )
  assert.equal(harness.calls.some((entry) => entry.startsWith("verify:")), false)
})

test("production domain mutations start a serializable outer transaction", async () => {
  let transactionOptions: unknown = null
  const store = createDrizzleOrganizationDomainMutationStore({
    async transaction<T>(run: (tx: unknown) => Promise<T>, options: unknown) {
      transactionOptions = options
      return run({})
    },
  })

  assert.equal(await store.transaction(async () => "committed"), "committed")
  assert.deepEqual(transactionOptions, { isolationLevel: "serializable" })
})

type StoredDomain = {
  id: string
  org_id: string
  domain: string
  enabled: boolean
  self_signup_enabled: boolean
  created_at: Date
  updated_at: Date
}

function createRecordingDrizzleDomainDatabase(input: {
  domains?: StoredDomain[]
  selectResults: Array<() => StoredDomain[]>
}) {
  let domains = structuredClone(input.domains ?? [])
  let selectIndex = 0
  const calls: string[] = []
  const tx = {
    select() {
      return {
        from() {
          return this
        },
        where() {
          return this
        },
        async limit() {
          calls.push(`select:${selectIndex}`)
          return structuredClone(input.selectResults[selectIndex++]?.() ?? [])
        },
      }
    },
    insert() {
      return {
        async values(value: Omit<StoredDomain, "created_at" | "updated_at">) {
          calls.push(`insert:${value.domain}`)
          const now = new Date("2026-07-21T08:00:00.000Z")
          domains.push({ ...value, created_at: now, updated_at: now })
        },
      }
    },
    update() {
      return {
        set(update: Partial<StoredDomain>) {
          return {
            async where() {
              calls.push(`update:${String(update.domain ?? "settings")}`)
              domains = domains.map((entry) => ({ ...entry, ...update }))
            },
          }
        },
      }
    },
  }
  const database = {
    async transaction<T>(run: (transaction: typeof tx) => Promise<T>, options: unknown) {
      assert.deepEqual(options, { isolationLevel: "serializable" })
      const snapshot = structuredClone(domains)
      calls.push("outer:begin")
      try {
        const result = await run(tx)
        calls.push("outer:commit")
        return result
      } catch (error) {
        domains = snapshot
        calls.push("outer:rollback")
        throw error
      }
    },
  }

  return {
    database,
    tx,
    calls,
    get domains() {
      return structuredClone(domains)
    },
  }
}

test("production mutation store composes verification and trial sync with the exact outer transaction", async () => {
  let harness: ReturnType<typeof createRecordingDrizzleDomainDatabase>
  harness = createRecordingDrizzleDomainDatabase({
    selectResults: [
      () => [],
      () => harness.domains,
    ],
  })
  const factoryTransactions: unknown[] = []
  const store = createDrizzleOrganizationDomainMutationStore(harness.database, {
    createMemberReader(transaction) {
      factoryTransactions.push(transaction)
      return {
        async listMembers() {
          return [{
            orgId: "org_1",
            userId: "user_verified",
            email: "owner@team.example.com",
            emailVerified: true,
            membershipStatus: "active",
          }]
        },
      }
    },
    createAutomaticTrialStore(transaction) {
      factoryTransactions.push(transaction)
      return {
        async listOrganizationIds() {
          return []
        },
        async grantOrSyncDomainTrial() {
          harness.calls.push("trial:sync")
          return { granted: true }
        },
      }
    },
  })
  const service = createOrganizationDomainMutationService({ store })

  await service.create({
    id: "domain_1",
    orgId: "org_1",
    domain: "team.example.com",
    enabled: true,
    selfSignupEnabled: false,
  })

  assert.deepEqual(factoryTransactions, [harness.tx, harness.tx])
  assert.ok(harness.calls.indexOf("insert:team.example.com") < harness.calls.indexOf("trial:sync"))
  assert.ok(harness.calls.indexOf("trial:sync") < harness.calls.indexOf("outer:commit"))
})

test("production mutation store rolls a domain rename back when tx-scoped trial sync fails", async () => {
  const original: StoredDomain = {
    id: "domain_1",
    org_id: "org_1",
    domain: "old.example.com",
    enabled: true,
    self_signup_enabled: false,
    created_at: new Date("2026-07-21T07:00:00.000Z"),
    updated_at: new Date("2026-07-21T07:00:00.000Z"),
  }
  let harness: ReturnType<typeof createRecordingDrizzleDomainDatabase>
  harness = createRecordingDrizzleDomainDatabase({
    domains: [original],
    selectResults: [
      () => harness.domains,
      () => [],
      () => harness.domains,
    ],
  })
  const factoryTransactions: unknown[] = []
  const store = createDrizzleOrganizationDomainMutationStore(harness.database, {
    createMemberReader(transaction) {
      factoryTransactions.push(transaction)
      return {
        async listMembers() {
          return [{
            orgId: "org_1",
            userId: "user_verified",
            email: "owner@new.example.com",
            emailVerified: true,
            membershipStatus: "active",
          }]
        },
      }
    },
    createAutomaticTrialStore(transaction) {
      factoryTransactions.push(transaction)
      return {
        async listOrganizationIds() {
          return []
        },
        async grantOrSyncDomainTrial() {
          harness.calls.push("trial:sync")
          throw new Error("trial persistence failed")
        },
      }
    },
  })

  await assert.rejects(
    createOrganizationDomainMutationService({ store }).update({
      orgId: "org_1",
      domainId: "domain_1",
      domain: "new.example.com",
    }),
    /trial persistence failed/,
  )

  assert.deepEqual(factoryTransactions, [harness.tx, harness.tx])
  assert.ok(harness.calls.indexOf("update:new.example.com") < harness.calls.indexOf("trial:sync"))
  assert.equal(harness.calls.at(-1), "outer:rollback")
  assert.equal(harness.domains[0].domain, "old.example.com")
})

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_test",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

test("admin domain routes return stable verification errors and audit only committed evidence", async () => {
  const { createOrganizationDomainAdminRouteDeps } = await import("../src/http/admin-runtime.js")
  const rejected = createMutationHarness()
  const accepted = createMutationHarness({
    members: [{
      orgId: "org_1",
      userId: "user_verified",
      email: "owner@team.example.com",
      emailVerified: true,
      membershipStatus: "active",
    }],
  })
  const audits: Array<{ action: string; payload: Record<string, unknown> }> = []
  let mutationService = rejected.service
  const snapshot = {
    user: {
      id: "platform_admin",
      email: "admin@unrelated.example",
      emailVerified: true,
      name: "Platform Admin",
    },
    platformAdmin: true,
    activeOrgId: "org_1",
    organizations: [],
  }
  const app = express()
  app.use(express.json())
  app.use(createAdminRouter({
    getSessionSnapshot: async () => snapshot,
    ...createOrganizationDomainAdminRouteDeps({
      get mutations() {
        return mutationService
      },
      createDomainId: () => "domain_1",
      async requireOrganizationAccess() {
        return {
          snapshot,
          organization: {
            id: "org_1",
            name: "Acme",
            slug: "acme",
            ownerUserId: "owner_1",
            seatLimit: null,
          },
        }
      },
      async recordOrganizationAudit(_snapshot, _orgId, action, payload) {
        audits.push({ action, payload: payload as Record<string, unknown> })
        accepted.calls.push(`audit:${action}`)
      },
    }),
  }))
  app.use(errorMiddleware)
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/organizations/org_1/domains`
    const deniedResponse = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "team.example.com" }),
    })
    assert.equal(deniedResponse.status, 409)
    assert.deepEqual(await deniedResponse.json(), { error: "domain_verified_member_required" })
    assert.deepEqual(rejected.domains, [])
    assert.deepEqual(audits, [])

    mutationService = accepted.service
    const createdResponse = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "TEAM.EXAMPLE.COM" }),
    })
    assert.equal(createdResponse.status, 201)
    assert.equal((await createdResponse.json()).domain.domain, "team.example.com")
    assert.equal(audits.length, 1)
    assert.ok(
      accepted.calls.indexOf("transaction:commit") < accepted.calls.indexOf("audit:org.domain.created"),
    )
    assert.deepEqual(audits[0], {
      action: "org.domain.created",
      payload: {
        domainId: "domain_1",
        domain: "team.example.com",
        enabled: true,
        selfSignupEnabled: false,
        verifiedMemberUserId: "user_verified",
      },
    })
    assert.equal("email" in audits[0].payload, false)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("admin domain rename enforces proof while settings and same-domain patches bypass it", async () => {
  const existing = [{
    id: "domain_1",
    orgId: "org_1",
    domain: "team.example.com",
    enabled: true,
    selfSignupEnabled: false,
  }]
  const unverified = createMutationHarness({ domains: existing })
  const verified = createMutationHarness({
    domains: existing,
    members: [{
      orgId: "org_1",
      userId: "user_verified",
      email: "owner@new.example.com",
      emailVerified: true,
      membershipStatus: "active",
    }],
  })
  let mutationService = unverified.service
  const audits: Array<{ action: string; payload: Record<string, unknown> }> = []
  const snapshot = {
    user: {
      id: "platform_admin",
      email: "admin@unrelated.example",
      emailVerified: true,
      name: "Platform Admin",
    },
    platformAdmin: true,
    activeOrgId: "org_1",
    organizations: [],
  }
  const { createOrganizationDomainAdminRouteDeps } = await import("../src/http/admin-runtime.js")
  const app = express()
  app.use(express.json())
  app.use(createAdminRouter({
    getSessionSnapshot: async () => snapshot,
    ...createOrganizationDomainAdminRouteDeps({
      get mutations() {
        return mutationService
      },
      async requireOrganizationAccess() {
        return {
          snapshot,
          organization: {
            id: "org_1",
            name: "Acme",
            slug: "acme",
            ownerUserId: "owner_1",
            seatLimit: null,
          },
        }
      },
      async recordOrganizationAudit(_snapshot, _orgId, action, payload) {
        audits.push({ action, payload: payload as Record<string, unknown> })
        if ((payload as Record<string, unknown>).verifiedMemberUserId) {
          verified.calls.push(`audit:${action}`)
        }
      },
    }),
  }))
  app.use(errorMiddleware)
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/organizations/org_1/domains/domain_1`
    const deniedRename = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "new.example.com" }),
    })
    assert.equal(deniedRename.status, 409)
    assert.deepEqual(await deniedRename.json(), { error: "domain_verified_member_required" })
    assert.equal(unverified.domains[0].domain, "team.example.com")
    assert.deepEqual(audits, [])
    const verificationCallsAfterDeniedRename = unverified.calls.filter((entry) => entry.startsWith("verify:")).length

    const settingsPatch = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(settingsPatch.status, 200)
    assert.equal((await settingsPatch.json()).domain.enabled, false)

    const sameDomainPatch = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "TEAM.EXAMPLE.COM", selfSignupEnabled: true }),
    })
    assert.equal(sameDomainPatch.status, 200)
    assert.equal((await sameDomainPatch.json()).domain.selfSignupEnabled, true)
    assert.equal(
      unverified.calls.filter((entry) => entry.startsWith("verify:")).length,
      verificationCallsAfterDeniedRename,
    )
    assert.equal(unverified.calls.includes("trial:org_1"), false)

    mutationService = verified.service
    const acceptedRename = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "NEW.EXAMPLE.COM" }),
    })
    assert.equal(acceptedRename.status, 200)
    assert.equal((await acceptedRename.json()).domain.domain, "new.example.com")
    assert.ok(verified.calls.indexOf("update:domain_1:domain") < verified.calls.indexOf("trial:org_1"))
    assert.ok(
      verified.calls.indexOf("transaction:commit") < verified.calls.indexOf("audit:org.domain.updated"),
    )
    assert.deepEqual(audits.at(-1), {
      action: "org.domain.updated",
      payload: {
        domainId: "domain_1",
        changedFields: ["domain"],
        verifiedMemberUserId: "user_verified",
      },
    })
    assert.equal("email" in audits.at(-1)!.payload, false)
  } finally {
    server.close()
    await once(server, "close")
  }
})
