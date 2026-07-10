import { MySqlAiAccessRepository } from "./access/mysql-repository.js"
import type { AiAccessRepository } from "./access/repository.js"
import { MySqlCredentialRepository } from "./credentials/mysql-repository.js"
import { MySqlSecretStore } from "./credentials/mysql-secret-store.js"
import type { CredentialRepository } from "./credentials/repository.js"
import { evaluateCodexCredentialEligibility } from "./usage/codex-eligibility.js"
import {
  CachedCodexCredentialStatusProvider,
  type CodexCredentialStatusProvider,
} from "./usage/codex-status.js"

export const DEFAULT_CODEX_AUTO_ASSIGN_MODEL = "gpt-5.6-sol"

export type ManagedAiSignupAssignmentCredential = {
  credentialId: string
  name: string
  activeLeases: number
}

export type ManagedAiSignupAssignmentDependencies = {
  aiAccess: AiAccessRepository
  credentials: CredentialRepository
  codexStatusProvider: CodexCredentialStatusProvider
  now?: () => Date
  logger?: (message: string, error: unknown) => void
}

export type ManagedAiSignupAssignmentService = {
  getEligibleCodexCredentialForAutoAssign(): Promise<ManagedAiSignupAssignmentCredential | null>
  maybeAssignDefaultCodexAccessForNewUser(userId: string): Promise<boolean>
}

let defaultServicePromise: Promise<ManagedAiSignupAssignmentService | null> | null = null

export function createManagedAiSignupAssignmentService(
  deps: ManagedAiSignupAssignmentDependencies,
): ManagedAiSignupAssignmentService {
  const now = deps.now ?? (() => new Date())

  async function listEligibleCodexCredentials(): Promise<ManagedAiSignupAssignmentCredential[]> {
    const listAdminCredentials = deps.credentials.listAdminCredentials
    if (!listAdminCredentials) {
      return []
    }

    const credentials = await listAdminCredentials.call(deps.credentials)
    const candidates = credentials.filter((entry) => entry.provider === "codex_oauth" && entry.state === "healthy")
    const eligible: ManagedAiSignupAssignmentCredential[] = []

    for (const credential of candidates) {
      const status = await deps.codexStatusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name,
      })
      if (!evaluateCodexCredentialEligibility(status, now()).eligible) {
        continue
      }

      eligible.push({
        credentialId: credential.id,
        name: credential.name,
        activeLeases: credential.activeLeases,
      })
    }

    return eligible.sort((left, right) => {
      const leaseDelta = left.activeLeases - right.activeLeases
      if (leaseDelta !== 0) {
        return leaseDelta
      }
      const nameDelta = left.name.localeCompare(right.name)
      if (nameDelta !== 0) {
        return nameDelta
      }
      return left.credentialId.localeCompare(right.credentialId)
    })
  }

  const service: ManagedAiSignupAssignmentService = {
    async getEligibleCodexCredentialForAutoAssign() {
      const [selected] = await listEligibleCodexCredentials()
      return selected ?? null
    },
    async maybeAssignDefaultCodexAccessForNewUser(userId: string) {
      try {
        const existing = await deps.aiAccess.getUserAiAccess(userId)
        if (existing) {
          return false
        }

        const credential = await service.getEligibleCodexCredentialForAutoAssign()
        if (!credential) {
          return false
        }

        await deps.aiAccess.upsertUserAiAccess({
          userId,
          enabled: true,
          provider: "codex_oauth",
          credentialId: credential.credentialId,
          defaultModel: DEFAULT_CODEX_AUTO_ASSIGN_MODEL,
          allowedModels: [DEFAULT_CODEX_AUTO_ASSIGN_MODEL],
          assignmentOrigin: "auto_assigned",
        })
        return true
      } catch (error) {
        deps.logger?.("managed ai signup assignment failed", error)
        return false
      }
    },
  }
  return service
}

export async function getDefaultManagedAiSignupAssignmentService(): Promise<ManagedAiSignupAssignmentService | null> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const [{ env }, { managedAiDb }] = await Promise.all([
        import("../env.js"),
        import("./db.js"),
      ])

      if (!env.managedAi.enabled || !managedAiDb || !env.managedAi.secretKey) {
        return null
      }

      const credentials = new MySqlCredentialRepository(managedAiDb)
      const secrets = new MySqlSecretStore(managedAiDb, env.managedAi.secretKey)
      const aiAccess = new MySqlAiAccessRepository(managedAiDb)
      const codexStatusProvider = new CachedCodexCredentialStatusProvider({
        loadCredentialAuthJson: async (credentialId) => {
          const credential = await credentials.getCredentialRecordById(credentialId)
          if (!credential) {
            return null
          }

          const secret = await secrets.get(credential.secretRef).catch(() => null)
          return secret?.kind === "codex_auth_json" ? secret.authJson : null
        },
      })

      return createManagedAiSignupAssignmentService({
        aiAccess,
        credentials,
        codexStatusProvider,
        logger: (message, error) => {
          console.error(message, error)
        },
      })
    })().catch((error) => {
      console.error("managed ai signup assignment bootstrap failed", error)
      return null
    })
  }

  return defaultServicePromise
}

export async function maybeAssignDefaultManagedAiAccessForNewUser(userId: string): Promise<boolean> {
  const service = await getDefaultManagedAiSignupAssignmentService()
  if (!service) {
    return false
  }

  return service.maybeAssignDefaultCodexAccessForNewUser(userId)
}
