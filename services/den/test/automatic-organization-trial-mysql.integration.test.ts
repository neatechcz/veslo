import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { migrate } from "drizzle-orm/mysql2/migrator"
import mysql, { type Pool, type PoolConnection } from "mysql2/promise"

import {
  AUTOMATIC_ORGANIZATION_TRIAL_DAYS,
  createAutomaticOrganizationTrialService,
  createDrizzleAutomaticOrganizationTrialStore,
  type AutomaticOrganizationTrialGrant,
} from "../src/billing/automatic-organization-trial.js"
import * as schema from "../src/db/schema.js"
import {
  AuthUserTable,
  OrgMembershipTable,
  OrganizationDomainTable,
  OrgTable,
} from "../src/db/schema.js"
import { isMySqlDeadlockError } from "../src/db/mysql-errors.js"
import {
  OrganizationDomainExistsError,
  createDrizzleOrganizationDomainMutationStore,
  createOrganizationDomainMutationService,
} from "../src/org-admin/domain-mutations.js"
import { createDrizzleOrganizationDomainMemberReader } from "../src/org-admin/domain-verification.js"

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
      const { createDatabaseUserProvisioningLock } = await import("../src/auth/verified-signup.js")

      const fixture = randomUUID().replaceAll("-", "").slice(0, 12)
      await verifyUserProvisioningAdvisoryLocks(databaseUrl, fixture, createDatabaseUserProvisioningLock)

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

      const existingTrialOrgId = `org_existing_trial_${fixture}`
      const foreignClaimOrgId = `org_foreign_claim_${fixture}`
      const existingTrialDomains = {
        own: `${fixture}.existing-own.integration.test`,
        fresh: `${fixture}.existing-fresh.integration.test`,
        foreign: `${fixture}.existing-foreign.integration.test`,
      }
      const existingTrialExpiry = new Date("2026-08-01T12:34:56.000Z")
      const existingTrialUpdatedAt = new Date("2026-07-18T09:10:11.000Z")
      await database.insert(OrgTable).values([{
        id: existingTrialOrgId,
        name: "Existing Trial Domain Backfill",
        slug: `existing-trial-domain-backfill-${fixture}`,
        owner_user_id: `user_existing_trial_${fixture}`,
      }, {
        id: foreignClaimOrgId,
        name: "Historical Foreign Claim",
        slug: `historical-foreign-claim-${fixture}`,
        owner_user_id: `user_foreign_claim_${fixture}`,
      }])
      await database.insert(OrganizationDomainTable).values(Object.values(existingTrialDomains).map((domain, index) => ({
        id: `domain_existing_trial_${fixture}_${index}`,
        org_id: existingTrialOrgId,
        domain,
        enabled: true,
        self_signup_enabled: true,
      })))
      await database.insert(schema.OrganizationTrialDomainClaimTable).values([{
        id: `claim_existing_own_${fixture}`,
        domain: existingTrialDomains.own,
        org_id: existingTrialOrgId,
        claimed_at: new Date("2026-07-01T00:00:00.000Z"),
      }, {
        id: `claim_existing_foreign_${fixture}`,
        domain: existingTrialDomains.foreign,
        org_id: foreignClaimOrgId,
        claimed_at: new Date("2026-06-01T00:00:00.000Z"),
      }])
      await database.insert(schema.OrganizationBillingAccountTable).values({
        id: `billing_existing_trial_${fixture}`,
        org_id: existingTrialOrgId,
        mode: "manual_access",
        source: "manual_trial",
        status: "active",
        managed_ai_basic_quantity: 0,
        managed_ai_extended_quantity: 0,
        local_models_quantity: 0,
        manual_access_enabled: true,
        manual_access_unlimited: true,
        manual_access_expires_at: existingTrialExpiry,
        created_at: new Date("2026-07-01T00:00:00.000Z"),
        updated_at: existingTrialUpdatedAt,
      })

      assert.deepEqual(
        await directStore.grantOrSyncDomainTrial({ ...directGrant, orgId: existingTrialOrgId }),
        { granted: false },
      )
      const existingTrialRows = await queryRows(pool, `
        SELECT
          (SELECT org_id FROM organization_trial_domain_claim WHERE domain = ?) AS own_claim_org_id,
          (SELECT org_id FROM organization_trial_domain_claim WHERE domain = ?) AS fresh_claim_org_id,
          (SELECT org_id FROM organization_trial_domain_claim WHERE domain = ?) AS foreign_claim_org_id,
          (SELECT UNIX_TIMESTAMP(manual_access_expires_at) FROM organization_billing_account WHERE org_id = ?) AS expiry_epoch,
          (SELECT UNIX_TIMESTAMP(updated_at) FROM organization_billing_account WHERE org_id = ?) AS updated_epoch,
          (SELECT COUNT(*) FROM organization_billing_event WHERE org_id = ?) AS event_count
      `, [
        existingTrialDomains.own,
        existingTrialDomains.fresh,
        existingTrialDomains.foreign,
        existingTrialOrgId,
        existingTrialOrgId,
        existingTrialOrgId,
      ])
      assert.deepEqual(existingTrialRows[0], {
        own_claim_org_id: existingTrialOrgId,
        fresh_claim_org_id: existingTrialOrgId,
        foreign_claim_org_id: foreignClaimOrgId,
        expiry_epoch: Math.floor(existingTrialExpiry.getTime() / 1_000),
        updated_epoch: Math.floor(existingTrialUpdatedAt.getTime() / 1_000),
        event_count: 0,
      })

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

      const inversionOrgId = `org_lock_inversion_${fixture}`
      const inversionDomain = `${fixture}.lock-inversion.integration.test`
      const inversionOwnerUserId = `inv_u_o_${fixture}`
      const inversionReplacementUserId = `inv_u_r_${fixture}`
      const inversionOwnerMembershipId = `inv_m_o_${fixture}`
      await database.insert(AuthUserTable).values([{
        id: inversionOwnerUserId,
        name: "Lock Inversion Owner",
        email: `owner@${inversionDomain}`,
        emailVerified: true,
      }, {
        id: inversionReplacementUserId,
        name: "Lock Inversion Replacement",
        email: `replacement@unrelated-${fixture}.integration.test`,
        emailVerified: true,
      }])
      await database.insert(OrgTable).values({
        id: inversionOrgId,
        name: "Domain Mutation Lock Inversion",
        slug: `domain-mutation-lock-inversion-${fixture}`,
        owner_user_id: inversionOwnerUserId,
      })
      await database.insert(OrgMembershipTable).values([{
        id: inversionOwnerMembershipId,
        org_id: inversionOrgId,
        user_id: inversionOwnerUserId,
        role: "organization_admin" as const,
        status: "active" as const,
      }, {
        id: `inv_m_r_${fixture}`,
        org_id: inversionOrgId,
        user_id: inversionReplacementUserId,
        role: "organization_admin" as const,
        status: "active" as const,
      }])

      const inversionMembershipLocked = createDeferred<void>()
      const releaseInversionOwnerOrgUpdate = createDeferred<void>()
      const inversionDomainEvidenceStarted = createDeferred<void>()
      const ownerStyleResult = database.transaction(async (tx: any) => {
        await tx
          .update(OrgMembershipTable)
          .set({ role: "member" })
          .where(eq(OrgMembershipTable.id, inversionOwnerMembershipId))
        inversionMembershipLocked.resolve()
        await releaseInversionOwnerOrgUpdate.promise
        await tx
          .update(OrgTable)
          .set({ owner_user_id: inversionReplacementUserId })
          .where(eq(OrgTable.id, inversionOrgId))
      }, { isolationLevel: "serializable" }).then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      )
      await withTimeout(
        inversionMembershipLocked.promise,
        5_000,
        "owner-style transaction did not lock membership",
      )

      let inversionMemberReadAttempts = 0
      const inversionMutationService = createOrganizationDomainMutationService({
        store: createDrizzleOrganizationDomainMutationStore(database, {
          createMemberReader(transaction) {
            const reader = createDrizzleOrganizationDomainMemberReader(transaction)
            return {
              async listMembers(orgId) {
                inversionMemberReadAttempts += 1
                inversionDomainEvidenceStarted.resolve()
                return reader.listMembers(orgId)
              },
            }
          },
        }),
      })
      const inversionDomainResult = inversionMutationService.create({
        id: `domain_lock_inversion_${fixture}`,
        orgId: inversionOrgId,
        domain: inversionDomain,
        enabled: true,
        selfSignupEnabled: false,
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      )
      try {
        await withTimeout(
          inversionDomainEvidenceStarted.promise,
          5_000,
          "domain mutation did not reach membership evidence while holding the organization lock",
        )
      } finally {
        releaseInversionOwnerOrgUpdate.resolve()
      }

      const [settledOwnerStyle, settledInversionDomain] = await withTimeout(
        Promise.all([ownerStyleResult, inversionDomainResult]),
        10_000,
        "lock-inversion transactions did not settle",
      )
      if (settledOwnerStyle.status === "rejected") {
        assert.equal(
          isMySqlDeadlockError(settledOwnerStyle.reason),
          true,
          "the competing owner-style transaction may only fail as the selected deadlock victim",
        )
      } else {
        assert.ok(
          inversionMemberReadAttempts >= 2,
          "a committed owner-style transaction means the domain deadlock victim must have retried",
        )
      }
      assert.equal(settledInversionDomain.status, "fulfilled")
      if (settledInversionDomain.status === "rejected") {
        assert.equal(isMySqlDeadlockError(settledInversionDomain.reason), false)
        assert.fail(`domain mutation leaked an unexpected error: ${String(settledInversionDomain.reason)}`)
      }
      assert.equal(settledInversionDomain.value.domain.domain, inversionDomain)

      const inversionRows = await queryRows(pool, `
        SELECT
          (SELECT COUNT(*) FROM organization_domain WHERE org_id = ? AND domain = ?) AS domain_count,
          (SELECT COUNT(*) FROM organization_trial_domain_claim WHERE org_id = ? AND domain = ?) AS claim_count,
          (SELECT COUNT(*) FROM organization_billing_account WHERE org_id = ?) AS billing_count,
          (SELECT COUNT(*) FROM organization_billing_event
            WHERE org_id = ? AND stripe_event_id = ?) AS event_count
      `, [
        inversionOrgId,
        inversionDomain,
        inversionOrgId,
        inversionDomain,
        inversionOrgId,
        inversionOrgId,
        `automatic_organization_trial:${inversionOrgId}`,
      ])
      assertCountRow(inversionRows[0], {
        domain_count: 1,
        claim_count: 1,
        billing_count: 1,
        event_count: 1,
      })

      const domainRaceDomain = `${fixture}.domain-race.integration.test`
      const domainRaceInputs = ["a", "b"].map((suffix) => ({
        orgId: `org_domain_race_${fixture}_${suffix}`,
        domainId: `domain_race_${fixture}_${suffix}`,
        membershipId: `membership_race_${fixture}_${suffix}`,
        userId: `user_race_${fixture}_${suffix}`,
        email: `${suffix}@${domainRaceDomain}`,
        name: `Domain Race ${suffix.toUpperCase()}`,
        slug: `domain-race-${fixture}-${suffix}`,
      }))
      await database.insert(AuthUserTable).values(domainRaceInputs.map((entry) => ({
        id: entry.userId,
        name: entry.name,
        email: entry.email,
        emailVerified: true,
      })))
      await database.insert(OrgTable).values(domainRaceInputs.map((entry) => ({
        id: entry.orgId,
        name: entry.name,
        slug: entry.slug,
        owner_user_id: entry.userId,
      })))
      await database.insert(OrgMembershipTable).values(domainRaceInputs.map((entry) => ({
        id: entry.membershipId,
        org_id: entry.orgId,
        user_id: entry.userId,
        role: "organization_admin" as const,
        status: "active" as const,
      })))

      const preflightBarrier = createBarrier(2, 5_000, "domain race preflight did not rendezvous")
      const memberProofBarrier = createBarrier(2, 5_000, "domain race member proof did not rendezvous")
      const baseRaceStore = createDrizzleOrganizationDomainMutationStore(database, {
        createMemberReader(transaction) {
          const reader = createDrizzleOrganizationDomainMemberReader(transaction)
          return {
            async listMembers(orgId) {
              const members = await reader.listMembers(orgId)
              await memberProofBarrier.wait()
              return members
            },
          }
        },
      })
      const raceStore = {
        findById: baseRaceStore.findById,
        async findByDomain(domain: string) {
          const existing = await baseRaceStore.findByDomain(domain)
          await preflightBarrier.wait()
          return existing
        },
        transaction: baseRaceStore.transaction,
      }
      const raceService = createOrganizationDomainMutationService({ store: raceStore })
      const raceResults = await withTimeout(
        Promise.allSettled(domainRaceInputs.map((entry) => raceService.create({
          id: entry.domainId,
          orgId: entry.orgId,
          domain: domainRaceDomain,
          enabled: true,
          selfSignupEnabled: false,
        }))),
        10_000,
        "concurrent same-domain mutations did not settle",
      )
      const raceWinningIndexes = raceResults.flatMap((result, index) => result.status === "fulfilled" ? [index] : [])
      const raceLosingIndexes = raceResults.flatMap((result, index) => result.status === "rejected" ? [index] : [])
      assert.equal(raceWinningIndexes.length, 1)
      assert.equal(raceLosingIndexes.length, 1)
      const raceLoser = raceResults[raceLosingIndexes[0] ?? -1]
      assert.ok(raceLoser?.status === "rejected")
      assert.ok(raceLoser.reason instanceof OrganizationDomainExistsError)

      const raceWinnerInput = domainRaceInputs[raceWinningIndexes[0] ?? -1]
      const raceLoserInput = domainRaceInputs[raceLosingIndexes[0] ?? -1]
      assert.ok(raceWinnerInput)
      assert.ok(raceLoserInput)
      const domainRaceRows = await queryRows(pool, `
        SELECT
          (SELECT COUNT(*) FROM organization_domain WHERE org_id = ? AND domain = ?) AS winner_domain_count,
          (SELECT COUNT(*) FROM organization_trial_domain_claim WHERE org_id = ? AND domain = ?) AS winner_claim_count,
          (SELECT COUNT(*) FROM organization_billing_account WHERE org_id = ?) AS winner_billing_count,
          (SELECT COUNT(*) FROM organization_billing_event
            WHERE org_id = ? AND stripe_event_id = ?) AS winner_event_count,
          (SELECT COUNT(*) FROM organization_domain WHERE org_id = ?) AS loser_domain_count,
          (SELECT COUNT(*) FROM organization_trial_domain_claim WHERE org_id = ?) AS loser_claim_count,
          (SELECT COUNT(*) FROM organization_billing_account WHERE org_id = ?) AS loser_billing_count,
          (SELECT COUNT(*) FROM organization_billing_event WHERE org_id = ?) AS loser_event_count
      `, [
        raceWinnerInput.orgId,
        domainRaceDomain,
        raceWinnerInput.orgId,
        domainRaceDomain,
        raceWinnerInput.orgId,
        raceWinnerInput.orgId,
        `automatic_organization_trial:${raceWinnerInput.orgId}`,
        raceLoserInput.orgId,
        raceLoserInput.orgId,
        raceLoserInput.orgId,
        raceLoserInput.orgId,
      ])
      assertCountRow(domainRaceRows[0], {
        winner_domain_count: 1,
        winner_claim_count: 1,
        winner_billing_count: 1,
        winner_event_count: 1,
        loser_domain_count: 0,
        loser_claim_count: 0,
        loser_billing_count: 0,
        loser_event_count: 0,
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

type UserProvisioningLockConnection = {
  execute(query: string, values: unknown[]): Promise<unknown>
  release(): void
  destroy(): void
}

type UserProvisioningLockFactory = (lockPool: {
  getConnection(): Promise<UserProvisioningLockConnection>
}) => <T>(userId: string, operation: () => Promise<T>) => Promise<T>

async function verifyUserProvisioningAdvisoryLocks(
  databaseUrl: string,
  fixture: string,
  createDatabaseUserProvisioningLock: UserProvisioningLockFactory,
) {
  const concurrency = 2
  const workPool = mysql.createPool({
    uri: databaseUrl,
    waitForConnections: true,
    connectionLimit: concurrency,
    queueLimit: 0,
  })
  const lockPool = mysql.createPool({
    uri: databaseUrl,
    waitForConnections: true,
    connectionLimit: concurrency,
    queueLimit: 0,
  })
  const workDatabase = drizzle(workPool, { schema, mode: "default" })
  const secondGetLockAttempted = createDeferred<void>()
  let getLockAttempts = 0
  const observedLockPool = {
    async getConnection(): Promise<UserProvisioningLockConnection> {
      const connection = await lockPool.getConnection()
      return {
        async execute(query, values) {
          if (query.includes("GET_LOCK")) {
            getLockAttempts += 1
            if (getLockAttempts === 2) {
              secondGetLockAttempted.resolve()
            }
          }
          return connection.execute(query, values)
        },
        release() {
          connection.release()
        },
        destroy() {
          connection.destroy()
        },
      }
    },
  }
  const runWithUserProvisioningLock = createDatabaseUserProvisioningLock(observedLockPool)
  const provisioningLockUserId = `not_yet_committed_${fixture}`
  const heldWorkConnections: PoolConnection[] = []
  const firstProvisioningEntered = createDeferred<void>()
  const releaseFirstProvisioning = createDeferred<void>()
  let serializationOperations: Array<Promise<string>> = []
  let exhaustionOperations: Array<Promise<number>> = []

  try {
    const provisioningOrder: string[] = []
    const firstProvisioning = runWithUserProvisioningLock(provisioningLockUserId, async () => {
      provisioningOrder.push("first:start")
      firstProvisioningEntered.resolve()
      await releaseFirstProvisioning.promise
      provisioningOrder.push("first:end")
      return "first"
    })
    serializationOperations = [firstProvisioning]
    await withTimeout(firstProvisioningEntered.promise, 5_000, "first provisioning did not acquire its advisory lock")
    const secondProvisioning = runWithUserProvisioningLock(provisioningLockUserId, async () => {
      provisioningOrder.push("second:start")
      return "second"
    })
    serializationOperations.push(secondProvisioning)
    await withTimeout(secondGetLockAttempted.promise, 5_000, "second provisioning did not attempt the same advisory lock")
    assert.deepEqual(provisioningOrder, ["first:start"])
    releaseFirstProvisioning.resolve()
    assert.deepEqual(
      await withTimeout(Promise.all([firstProvisioning, secondProvisioning]), 15_000, "provisioning lock did not serialize"),
      ["first", "second"],
    )
    assert.deepEqual(provisioningOrder, ["first:start", "first:end", "second:start"])

    await assert.rejects(
      runWithUserProvisioningLock(provisioningLockUserId, async () => {
        throw new Error("expected provisioning failure")
      }),
      /expected provisioning failure/,
    )
    assert.equal(
      await withTimeout(
        runWithUserProvisioningLock(provisioningLockUserId, async () => "reacquired"),
        5_000,
        "provisioning advisory lock was not released after failure",
      ),
      "reacquired",
    )

    heldWorkConnections.push(...await Promise.all(
      Array.from({ length: concurrency }, () => workPool.getConnection()),
    ))
    const allProvisioningCallbacksEntered = createDeferred<void>()
    let enteredCallbacks = 0
    exhaustionOperations = Array.from({ length: concurrency }, (_, index) =>
      runWithUserProvisioningLock(`pool_exhaustion_${fixture}_${index}`, async () => {
        enteredCallbacks += 1
        if (enteredCallbacks === concurrency) {
          allProvisioningCallbacksEntered.resolve()
        }
        return workDatabase.transaction(async (tx) => {
          await tx.execute(sql`SELECT ${index} AS worker_value`)
          return index
        })
      })
    )

    await withTimeout(
      allProvisioningCallbacksEntered.promise,
      5_000,
      "dedicated advisory lock pool was blocked by an exhausted work pool",
    )
    assert.equal(enteredCallbacks, concurrency)
    for (const connection of heldWorkConnections.splice(0)) {
      connection.release()
    }
    assert.deepEqual(
      await withTimeout(Promise.all(exhaustionOperations), 15_000, "work queries did not resume after pool release"),
      [0, 1],
    )
  } finally {
    for (const connection of heldWorkConnections) {
      connection.release()
    }
    releaseFirstProvisioning.resolve()
    await Promise.allSettled(serializationOperations)
    await Promise.allSettled(exhaustionOperations)
    await Promise.all([workPool.end(), lockPool.end()])
  }
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

function createBarrier(participants: number, timeoutMs: number, timeoutMessage: string) {
  const released = createDeferred<void>()
  let arrivals = 0
  return {
    async wait() {
      arrivals += 1
      if (arrivals === participants) {
        released.resolve()
      }
      await withTimeout(released.promise, timeoutMs, timeoutMessage)
    },
  }
}
