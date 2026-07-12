import { MANAGED_AI_PROVIDERS, type ManagedAiProvider } from "../providers/ids.js"

export const AiAccessProviders = MANAGED_AI_PROVIDERS

export type AiAccessProvider = ManagedAiProvider
export const AiAccessAssignmentOrigins = ["auto_assigned", "admin_assigned"] as const
export type AiAccessAssignmentOrigin = (typeof AiAccessAssignmentOrigins)[number]

export type UserAiAccessPolicyRecord = {
  id: string
  userId: string
  enabled: boolean
  provider: AiAccessProvider | null
  credentialId: string | null
  /** Historical rollback-only columns. New policy code must never write or enforce these values. */
  defaultModel: string | null
  allowedModels: string[]
  assignmentOrigin: AiAccessAssignmentOrigin
  createdAt: Date
  updatedAt: Date
}

export type UpsertUserAiAccessPolicyInput = {
  userId: string
  enabled: boolean
  provider: AiAccessProvider | null
  credentialId: string | null
  assignmentOrigin: AiAccessAssignmentOrigin
}

export interface AiAccessRepository {
  getUserAiAccess(userId: string): Promise<UserAiAccessPolicyRecord | null>
  upsertUserAiAccess(input: UpsertUserAiAccessPolicyInput): Promise<UserAiAccessPolicyRecord>
}
