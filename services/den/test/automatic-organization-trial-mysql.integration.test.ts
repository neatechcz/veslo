import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { drizzle } from "drizzle-orm/mysql2"
import { migrate } from "drizzle-orm/mysql2/migrator"
import mysql, { type Pool } from "mysql2/promise"

import {
  AUTOMATIC_ORGANIZATION_TRIAL_DAYS,
  createAutomaticOrganizationTrialService,
  createDrizzleAutomaticOrganizationTrialStore,
  type AutomaticOrganizationTrialGrant,
} from "../src/billing/automatic-organization-trial.js"
import * as schema from "../src/db/schema.js"
import {
  OrganizationDomainTable,
  OrgTable,
} from "../src/db/schema.js"
import {
  createDrizzleOrganizationDomainMutationStore,
  createOrganizationDomainMutationService,
} from "../src/org-admin/domain-mutations.js"

const DEDICATED_DATABASE_URL_ENV = "DEN_AUTOMATIC_TRIAL_MYSQL_TEST_DATABASE_URL"
const dedicatedDatabaseUrl = process.env[DEDICATED_DATABASE_URL_ENV]?.trim()

test("MySQL integration database guard rejects production-like database URLs", () => {
  assert.throws(
    () => parseDedicatedDatabaseUrl("mysql://root:secret@127.0.0.1:3306/veslo_production"),
    /database name must contain test, integration, or ci/,
  )
  assert.throws(
    () => parseDedicatedDatabaseUrl("postgres://root:secret@127.0.0.1:5432/veslo_test"),
    /must use the mysql protocol/,
  )
  assert.equal(
    parseDedicatedDatabaseUrl("mysql://root:secret@127.0.0.1:3306/veslo_integration").pathname,
    "/veslo_integration",
  )
})

if (!dedicatedDatabaseUrl) {
  test("automatic organization trials are atomic in real MySQL", {
    skip: `set ${DEDICATED_DATABASE_URL_ENV} to an isolated MySQL test database URL`,
  }, () => {})
} else {
  test("automatic organization trials are atomic in real MySQL", async () => {
    await withTemporaryIntegrationDatabase(dedicatedDatabaseUrl, async ({ database, pool, databaseUrl }) => {
      process.env.DATABASE_URL = databaseUrl
      process.env.BETTER_AUTH_SECRET = "12345678901234567890123456789012"
      process.env.BETTER_AUTH_URL = "https://den.integration.test"

      await assertRequiredTablesUseInnoDb(pool)

      const {
        createSignupOrganizationPersistence,
        SignupOrganizationDomainConflictError,
      } = await import("../src/orgs.js")

      const fixture = randomUUID().replaceAll("-", "").slice(0, 12)
      const sharedDomain = `${fixture}.signup.integration.test`
      const signupInputs = ["a", "b"].map((suffix) => ({
        orgId: `org_signup_${fixture}_${suffix}`,
        membershipId: `membership_signup_${fixture}_${suffix}`,
        domainId: `domain_signup_${fixture}_${suffix}`,
        userId: `user_signup_${fixture}_${suffix}`,
        name: `Concurrent Signup ${suffix.toUpperCase()}`,
        slug: `concurrent-signup-${fixture}-${suffix}`,
        domain: sharedDomain,
      }))
      const persistSignupOrganization = createSignupOrganizationPersistence(database)

      const signupResults = await Promise.allSettled(signupInputs.map(persistSignupOrganization))
      const winningIndexes = signupResults.flatMap((result, index) => result.status === "fulfilled" ? [index] : [])
      const losingIndexes = signupResults.flatMap((result, index) => result.status === "rejected" ? [index] : [])
      assert.equal(winningIndexes.length, 1)
      assert.equal(losingIndexes.length, 1)

      const winningInput = signupInputs[winningIndexes[0] ?? -1]
      const losingInput = signupInputs[losingIndexes[0] ?? -1]
      const losingResult = signupResults[losingIndexes[0] ?? -1]
      assert.ok(winningInput)
      assert.ok(losingInput)
      assert.ok(losingResult?.status === "rejected")
      assert.ok(losingResult.reason instanceof SignupOrganizationDomainConflictError)

      const signupCounts = await queryRows(pool, `
        SELECT
          (SELECT COUNT(*) FROM org WHERE id IN (?, ?)) AS org_count,
          (SELECT COUNT(*) FROM org_membership WHERE org_id IN (?, ?)) AS membership_count,
          (SELECT COUNT(*) FROM organization_domain WHERE domain = ?) AS domain_count,
          (SELECT COUNT(*) FROM organization_trial_domain_claim WHERE domain = ?) AS claim_count,
          (SELECT COUNT(*) FROM organization_billing_account WHERE org_id IN (?, ?)) AS billing_count,
          (SELECT COUNT(*) FROM organization_billing_event WHERE org_id IN (?, ?)
            AND stripe_event_type = 'automatic_organization_trial.granted') AS event_count
      `, [
        signupInputs[0]?.orgId,
        signupInputs[1]?.orgId,
        signupInputs[0]?.orgId,
        signupInputs[1]?.orgId,
        sharedDomain,
        sharedDomain,
        signupInputs[0]?.orgId,
        signupInputs[1]?.orgId,
        signupInputs[0]?.orgId,
        signupInputs[1]?.orgId,
      ])
      assertCountRow(signupCounts[0], {
        org_count: 1,
        membership_count: 1,
        domain_count: 1,
        claim_count: 1,
        billing_count: 1,
        event_count: 1,
      })

      const losingPartialRows = await queryRows(pool, `
        SELECT
          (SELECT COUNT(*) FROM org WHERE id = ?) AS org_count,
          (SELECT COUNT(*) FROM org_membership WHERE id = ?) AS membership_count,
          (SELECT COUNT(*) FROM organization_domain WHERE id = ?) AS domain_count
      `, [losingInput.orgId, losingInput.membershipId, losingInput.domainId])
      assertCountRow(losingPartialRows[0], {
        org_count: 0,
        membership_count: 0,
        domain_count: 0,
      })

      const directOrgId = `org_direct_${fixture}`
      const directDomain = `${fixture}.direct.integration.test`
      await database.insert(OrgTable).values({
        id: directOrgId,
        name: "Direct Trial Race",
        slug: `direct-trial-race-${fixture}`,
        owner_user_id: `user_direct_${fixture}`,
      })
      await database.insert(OrganizationDomainTable).values({
        id: `domain_direct_${fixture}`,
        org_id: directOrgId,
        domain: directDomain,
        enabled: true,
        self_signup_enabled: true,
      })

      const expiresAt = new Date(Date.now() + AUTOMATIC_ORGANIZATION_TRIAL_DAYS * 24 * 60 * 60 * 1_000)
      const directGrant: AutomaticOrganizationTrialGrant = {
        orgId: directOrgId,
        mode: "manual_access",
        source: "manual_trial",
        status: "active",
        manualAccessEnabled: true,
        manualAccessUnlimited: true,
        manualAccessExpiresAt: expiresAt,
      }
      const directStore = createDrizzleAutomaticOrganizationTrialStore(database)
      const directResults = await Promise.all([
        directStore.grantOrSyncDomainTrial(directGrant),
        directStore.grantOrSyncDomainTrial(directGrant),
      ])
      assert.equal(directResults.filter((entry) => entry.granted).length, 1)

      const directRows = await queryRows(pool, `
        SELECT
          (SELECT COUNT(*) FROM organization_trial_domain_claim WHERE org_id = ?) AS claim_count,
          (SELECT COUNT(*) FROM organization_billing_account WHERE org_id = ?) AS billing_count,
          (SELECT COUNT(*) FROM organization_billing_event
            WHERE stripe_event_id = ?) AS event_count
      `, [directOrgId, directOrgId, `automatic_organization_trial:${directOrgId}`])
      assertCountRow(directRows[0], { claim_count: 1, billing_count: 1, event_count: 1 })

      const lockOrderOrgId = `org_lock_order_${fixture}`
      const lockOrderDomain = `${fixture}.lock-order.integration.test`
      await database.insert(OrgTable).values({
        id: lockOrderOrgId,
        name: "Domain Mutation Lock Order",
        slug: `domain-mutation-lock-order-${fixture}`,
        owner_user_id: `user_lock_order_${fixture}`,
      })

      const memberReadReached = createDeferred<void>()
      const releaseMemberRead = createDeferred<void>()
      const directTransactionStarted = createDeferred<void>()
      const domainMutationService = createOrganizationDomainMutationService({
        store: createDrizzleOrganizationDomainMutationStore(database, {
          createMemberReader() {
            return {
              async listMembers() {
                memberReadReached.resolve()
                await releaseMemberRead.promise
                return [{
                  orgId: lockOrderOrgId,
                  userId: `user_lock_order_${fixture}`,
                  email: `owner@${lockOrderDomain}`,
                  emailVerified: true,
                  membershipStatus: "active",
                }]
              },
            }
          },
        }),
      })
      const adminMutation = domainMutationService.create({
        id: `domain_lock_order_${fixture}`,
        orgId: lockOrderOrgId,
        domain: lockOrderDomain,
        enabled: true,
        selfSignupEnabled: false,
      })
      let directTrial: Promise<{ granted: boolean; expiresAt: Date }> | undefined
      let directSettled = false
      let directRemainedPendingWhileAdminHeldLock = false
      try {
        await withTimeout(memberReadReached.promise, 5_000, "admin mutation did not reach member proof")
        const directStore = createDrizzleAutomaticOrganizationTrialStore({
          async transaction<T>(run: (transaction: any) => Promise<T>, options: unknown) {
            directTransactionStarted.resolve()
            return database.transaction(run, options as any)
          },
        })
        directTrial = createAutomaticOrganizationTrialService({ store: directStore })
          .ensureTrial(lockOrderOrgId)
        void directTrial.then(
          () => { directSettled = true },
          () => { directSettled = true },
        )
        await withTimeout(directTransactionStarted.promise, 5_000, "direct trial transaction did not start")
        await delay(200)
        directRemainedPendingWhileAdminHeldLock = !directSettled
      } finally {
        releaseMemberRead.resolve()
      }

      assert.ok(directTrial)
      const [adminMutationResult, directTrialResult] = await withTimeout(
        Promise.allSettled([adminMutation, directTrial]),
        10_000,
        "domain mutation and direct trial did not settle",
      )
      assert.equal(
        directRemainedPendingWhileAdminHeldLock,
        true,
        "direct trial must wait for the admin transaction's organization lock",
      )
      assert.equal(adminMutationResult.status, "fulfilled")
      assert.equal(directTrialResult.status, "fulfilled")
      if (adminMutationResult.status === "fulfilled") {
        assert.equal(adminMutationResult.value.domain.domain, lockOrderDomain)
      }
      if (directTrialResult.status === "fulfilled") {
        assert.equal(directTrialResult.value.granted, false)
      }

      const lockOrderRows = await queryRows(pool, `
        SELECT
          (SELECT COUNT(*) FROM organization_domain WHERE org_id = ? AND domain = ?) AS domain_count,
          (SELECT COUNT(*) FROM organization_trial_domain_claim WHERE org_id = ? AND domain = ?) AS claim_count,
          (SELECT COUNT(*) FROM organization_billing_account WHERE org_id = ?) AS billing_count,
          (SELECT COUNT(*) FROM organization_billing_event
            WHERE org_id = ? AND stripe_event_id = ?) AS event_count
      `, [
        lockOrderOrgId,
        lockOrderDomain,
        lockOrderOrgId,
        lockOrderDomain,
        lockOrderOrgId,
        lockOrderOrgId,
        `automatic_organization_trial:${lockOrderOrgId}`,
      ])
      assertCountRow(lockOrderRows[0], {
        domain_count: 1,
        claim_count: 1,
        billing_count: 1,
        event_count: 1,
      })

      const uniquenessOrgIds = [`org_unique_${fixture}_a`, `org_unique_${fixture}_b`]
      await database.insert(OrgTable).values(uniquenessOrgIds.map((orgId, index) => ({
        id: orgId,
        name: `Domain Uniqueness ${index}`,
        slug: `domain-uniqueness-${fixture}-${index}`,
        owner_user_id: `user_unique_${fixture}_${index}`,
      })))
      const uniquenessDomain = `${fixture}.unique.integration.test`
      const domainInsertResults = await Promise.allSettled(uniquenessOrgIds.map((orgId, index) =>
        database.insert(OrganizationDomainTable).values({
          id: `domain_unique_${fixture}_${index}`,
          org_id: orgId,
          domain: uniquenessDomain,
          enabled: true,
          self_signup_enabled: true,
        })
      ))
      assert.equal(domainInsertResults.filter((entry) => entry.status === "fulfilled").length, 1)
      assert.equal(domainInsertResults.filter((entry) => entry.status === "rejected").length, 1)
    })
  })
}

async function withTemporaryIntegrationDatabase(
  rawUrl: string,
  callback: (context: {
    database: any
    pool: Pool
    databaseUrl: string
  }) => Promise<void>,
) {
  const dedicatedUrl = parseDedicatedDatabaseUrl(rawUrl)
  const serverUrl = new URL(dedicatedUrl)
  serverUrl.pathname = "/"
  const temporaryDatabaseName = `veslo_trial_integration_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  assert.match(temporaryDatabaseName, /^veslo_trial_integration_[a-f0-9]{12}$/)

  const admin = await mysql.createConnection(serverUrl.toString())
  let pool: Pool | undefined
  let databaseCreated = false
  try {
    await admin.query(`CREATE DATABASE \`${temporaryDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    databaseCreated = true

    const temporaryDatabaseUrl = new URL(dedicatedUrl)
    temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`
    pool = mysql.createPool({
      uri: temporaryDatabaseUrl.toString(),
      waitForConnections: true,
      connectionLimit: 8,
      queueLimit: 0,
    })
    const database = drizzle(pool, { schema, mode: "default" })
    await migrate(database, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    })
    await callback({ database, pool, databaseUrl: temporaryDatabaseUrl.toString() })
  } finally {
    try {
      await pool?.end()
    } finally {
      try {
        if (databaseCreated) {
          assert.match(temporaryDatabaseName, /^veslo_trial_integration_[a-f0-9]{12}$/)
          await admin.query(`DROP DATABASE \`${temporaryDatabaseName}\``)
        }
      } finally {
        await admin.end()
      }
    }
  }
}

function parseDedicatedDatabaseUrl(rawUrl: string) {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`${DEDICATED_DATABASE_URL_ENV} must be a valid MySQL URL`)
  }

  if (url.protocol !== "mysql:" && url.protocol !== "mysql2:") {
    throw new Error(`${DEDICATED_DATABASE_URL_ENV} must use the mysql protocol`)
  }
  const configuredDatabaseName = decodeURIComponent(url.pathname.replace(/^\//, ""))
  if (!configuredDatabaseName || !/(?:test|integration|ci)/i.test(configuredDatabaseName)) {
    throw new Error(`${DEDICATED_DATABASE_URL_ENV} database name must contain test, integration, or ci`)
  }
  return url
}

async function assertRequiredTablesUseInnoDb(pool: Pool) {
  const rows = await queryRows(pool, `
    SELECT TABLE_NAME AS table_name, ENGINE AS engine
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN (
        'org',
        'org_membership',
        'organization_domain',
        'organization_trial_domain_claim',
        'organization_billing_account',
        'organization_billing_event'
      )
    ORDER BY TABLE_NAME
  `)
  assert.equal(rows.length, 6)
  assert.equal(rows.every((row) => String(row.engine).toLowerCase() === "innodb"), true)
}

async function queryRows(pool: Pool, sql: string, values: unknown[] = []) {
  const [rows] = await pool.query(sql, values)
  assert.ok(Array.isArray(rows))
  return rows as Array<Record<string, unknown>>
}

function assertCountRow(row: Record<string, unknown> | undefined, expected: Record<string, number>) {
  assert.ok(row)
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, Number(row[key])])),
    expected,
  )
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
