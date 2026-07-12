import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import { userAiAccessPolicyTable } from "../schema.js"
import type {
  AiAccessAssignmentOrigin,
  AiAccessProvider,
  AiAccessRepository,
  UpsertUserAiAccessPolicyInput,
  UserAiAccessPolicyRecord,
} from "./repository.js"
import { isManagedAiProvider } from "../providers/ids.js"

export class MySqlAiAccessRepository implements AiAccessRepository {
  constructor(private readonly db: any) {}

  async getUserAiAccess(userId: string): Promise<UserAiAccessPolicyRecord | null> {
    const rows = await this.db
      .select()
      .from(userAiAccessPolicyTable)
      .where(eq(userAiAccessPolicyTable.user_id, userId))
      .limit(1)

    const row = rows[0]
    return row ? mapUserAiAccessPolicy(row) : null
  }

  async upsertUserAiAccess(input: UpsertUserAiAccessPolicyInput): Promise<UserAiAccessPolicyRecord> {
    const existing = await this.getUserAiAccess(input.userId)
    const now = new Date()
    const assignmentOrigin = parseAssignmentOrigin(input.assignmentOrigin)

    if (existing) {
      await this.db
        .update(userAiAccessPolicyTable)
        .set({
          enabled: input.enabled ? 1 : 0,
          provider: input.provider,
          credential_id: input.credentialId,
          assignment_origin: assignmentOrigin,
          updated_at: now,
        })
        .where(eq(userAiAccessPolicyTable.user_id, input.userId))

      return {
        ...existing,
        enabled: input.enabled,
        provider: input.provider,
        credentialId: input.credentialId,
        assignmentOrigin,
        updatedAt: now,
      }
    }

    const id = `ai_access_${randomUUID()}`
    await this.db.insert(userAiAccessPolicyTable).values({
      id,
      user_id: input.userId,
      enabled: input.enabled ? 1 : 0,
      provider: input.provider,
      credential_id: input.credentialId,
      default_model: null,
      allowed_models_json: "[]",
      assignment_origin: assignmentOrigin,
      created_at: now,
      updated_at: now,
    })

    return {
      id,
      userId: input.userId,
      enabled: input.enabled,
      provider: input.provider,
      credentialId: input.credentialId,
      defaultModel: null,
      allowedModels: [],
      assignmentOrigin,
      createdAt: now,
      updatedAt: now,
    }
  }
}

function mapUserAiAccessPolicy(row: typeof userAiAccessPolicyTable.$inferSelect): UserAiAccessPolicyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    enabled: Number(row.enabled) === 1,
    provider: parseProvider(row.provider),
    credentialId: row.credential_id,
    defaultModel: typeof row.default_model === "string" && row.default_model.trim() ? row.default_model : null,
    allowedModels: parseAllowedModelsJson(row.allowed_models_json),
    assignmentOrigin: parseAssignmentOrigin(row.assignment_origin),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  }
}

function parseProvider(value: string | null): AiAccessProvider | null {
  return isManagedAiProvider(value) ? value : null
}

function parseAssignmentOrigin(value: string | null | undefined): AiAccessAssignmentOrigin {
  return value === "auto_assigned" ? "auto_assigned" : "admin_assigned"
}

function parseAllowedModelsJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return []
    }
    return normalizeAllowedModels(parsed.filter((entry): entry is string => typeof entry === "string"))
  } catch {
    return []
  }
}

function normalizeAllowedModels(values: string[]): string[] {
  const unique = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    unique.add(trimmed)
  }
  return Array.from(unique)
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
