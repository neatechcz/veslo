import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { AiGatewayDb } from "../db/index.js";
import { userAiAccessPolicyTable } from "../db/schema.js";
import { isAiGatewayProvider } from "../providers/ids.js";
import type {
  AiAccessProvider,
  AiAccessRepository,
  UpsertUserAiAccessPolicyInput,
  UserAiAccessPolicyRecord,
} from "./repository.js";

export class MySqlAiAccessRepository implements AiAccessRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async getUserAiAccess(userId: string): Promise<UserAiAccessPolicyRecord | null> {
    const rows = await this.db
      .select()
      .from(userAiAccessPolicyTable)
      .where(eq(userAiAccessPolicyTable.user_id, userId))
      .limit(1);

    const row = rows[0];
    return row ? mapUserAiAccessPolicy(row) : null;
  }

  async upsertUserAiAccess(input: UpsertUserAiAccessPolicyInput): Promise<UserAiAccessPolicyRecord> {
    const existing = await this.getUserAiAccess(input.userId);
    const now = new Date();
    const allowedModelsJson = JSON.stringify(normalizeAllowedModels(input.allowedModels));

    if (existing) {
      await this.db
        .update(userAiAccessPolicyTable)
        .set({
          enabled: input.enabled ? 1 : 0,
          provider: input.provider,
          default_model: input.defaultModel,
          allowed_models_json: allowedModelsJson,
          updated_at: now,
        })
        .where(eq(userAiAccessPolicyTable.user_id, input.userId));

      return {
        ...existing,
        enabled: input.enabled,
        provider: input.provider,
        defaultModel: input.defaultModel,
        allowedModels: normalizeAllowedModels(input.allowedModels),
        updatedAt: now,
      };
    }

    const id = `ai_access_${randomUUID()}`;
    await this.db.insert(userAiAccessPolicyTable).values({
      id,
      user_id: input.userId,
      enabled: input.enabled ? 1 : 0,
      provider: input.provider,
      default_model: input.defaultModel,
      allowed_models_json: allowedModelsJson,
      created_at: now,
      updated_at: now,
    });

    return {
      id,
      userId: input.userId,
      enabled: input.enabled,
      provider: input.provider,
      defaultModel: input.defaultModel,
      allowedModels: normalizeAllowedModels(input.allowedModels),
      createdAt: now,
      updatedAt: now,
    };
  }
}

function mapUserAiAccessPolicy(row: typeof userAiAccessPolicyTable.$inferSelect): UserAiAccessPolicyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    enabled: Number(row.enabled) === 1,
    provider: parseProvider(row.provider),
    defaultModel: typeof row.default_model === "string" && row.default_model.trim() ? row.default_model : null,
    allowedModels: parseAllowedModelsJson(row.allowed_models_json),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function parseProvider(value: string | null): AiAccessProvider | null {
  return isAiGatewayProvider(value) ? value : null;
}

function parseAllowedModelsJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeAllowedModels(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return [];
  }
}

function normalizeAllowedModels(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
