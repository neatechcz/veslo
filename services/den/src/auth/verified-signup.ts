import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { extractMetadataRows } from "../db/schema-reconcile.js"
import { maybeAssignDefaultManagedAiAccessForNewUser } from "../managed-ai/signup-assignment.js"
import {
  createOrActivateOrganizationMembership,
  resolveEnabledOrganizationDomainForEmail,
} from "../org-admin/repository.js"
import {
  ensureSignupOrganization,
  findExistingActiveOrganizationId,
} from "../orgs.js"
import { provisionVerifiedSignupUser } from "./signup-gate.js"

export type VerifiedSignupIdentity = {
  id: string
  name: string | null | undefined
  email: string | null | undefined
  emailVerified: boolean
}

function readLockResult(result: unknown, key: "acquired" | "released") {
  const value = extractMetadataRows(result)[0]?.[key]
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value)
  }
  return Number.NaN
}

function provisioningLockName(userId: string) {
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 48)
  return `veslo:signup:${digest}`
}

export function createDatabaseUserProvisioningLock(database: any) {
  return async <T>(userId: string, operation: () => Promise<T>) => {
    if (!userId.trim()) {
      throw new Error("signup_user_provisioning_lock_unavailable")
    }

    return database.transaction(async (tx: any) => {
      const lockName = provisioningLockName(userId)
      const acquired = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 10) AS acquired`)
      if (readLockResult(acquired, "acquired") !== 1) {
        throw new Error("signup_user_provisioning_lock_unavailable")
      }

      try {
        return await operation()
      } finally {
        const released = await tx.execute(sql`SELECT RELEASE_LOCK(${lockName}) AS released`)
        if (readLockResult(released, "released") !== 1) {
          throw new Error("signup_user_provisioning_lock_release_failed")
        }
      }
    })
  }
}

export const runWithUserProvisioningLock = createDatabaseUserProvisioningLock(db)

export function provisionVerifiedSignupIdentity(user: VerifiedSignupIdentity) {
  return provisionVerifiedSignupUser({
    user,
    runWithUserProvisioningLock,
    createMembershipId: randomUUID,
    findExistingOrganizationId: findExistingActiveOrganizationId,
    resolveEnabledOrganizationDomainForEmail,
    createOrActivateOrganizationMembership,
    ensureSignupOrganization,
    assignManagedAiAccess: maybeAssignDefaultManagedAiAccessForNewUser,
  })
}
