import { createHash, randomUUID } from "node:crypto"
import mysql from "mysql2/promise"
import { extractMetadataRows } from "../db/schema-reconcile.js"
import { env } from "../env.js"
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

type UserProvisioningLockConnection = {
  execute(query: string, values: unknown[]): Promise<unknown>
  release(): void
  destroy(): void
}

type UserProvisioningLockPool = {
  getConnection(): Promise<UserProvisioningLockConnection>
}

const USER_PROVISIONING_LOCK_TIMEOUT_SECONDS = 10
const userProvisioningLockPool = mysql.createPool({
  uri: env.databaseUrl,
  waitForConnections: true,
  connectionLimit: 4,
  maxIdle: 4,
  idleTimeout: 60_000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
})

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

export function createDatabaseUserProvisioningLock(lockPool: UserProvisioningLockPool) {
  return async <T>(userId: string, operation: () => Promise<T>) => {
    if (!userId.trim()) {
      throw new Error("signup_user_provisioning_lock_unavailable")
    }

    const connection = await lockPool.getConnection()
    const lockName = provisioningLockName(userId)
    let acquiredLock = false
    try {
      const acquired = await connection.execute(
        "SELECT GET_LOCK(?, ?) AS acquired",
        [lockName, USER_PROVISIONING_LOCK_TIMEOUT_SECONDS],
      )
      if (readLockResult(acquired, "acquired") !== 1) {
        throw new Error("signup_user_provisioning_lock_unavailable")
      }
      acquiredLock = true

      return await operation()
    } finally {
      if (acquiredLock) {
        try {
          const released = await connection.execute(
            "SELECT RELEASE_LOCK(?) AS released",
            [lockName],
          )
          if (readLockResult(released, "released") !== 1) {
            throw new Error("signup_user_provisioning_lock_release_failed")
          }
        } catch (error) {
          connection.destroy()
          throw error
        }
      }
      connection.release()
    }
  }
}

export const runWithUserProvisioningLock = createDatabaseUserProvisioningLock(userProvisioningLockPool)

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
