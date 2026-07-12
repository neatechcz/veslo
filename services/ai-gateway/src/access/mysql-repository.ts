import { and, eq, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { AiGatewayDb } from "../db/index.js";
import { userAiAccessPolicyTable } from "../db/schema.js";
import { isAiGatewayProvider } from "../providers/ids.js";
import type {
  AiAccessAssignmentOrigin,
  AiAccessProvider,
  AiAccessRepository,
  UpsertUserAiAccessPolicyInput,
  UserAiAccessPolicyRecord,
} from "./repository.js";

export class MySqlAiAccessRepository implements AiAccessRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async countEnabledPolicies(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(userAiAccessPolicyTable)
      .where(and(eq(userAiAccessPolicyTable.enabled, 1), isNotNull(userAiAccessPolicyTable.provider)));

    return Number(rows[0]?.count ?? 0);
  }

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
    const assignmentOrigin = parseAssignmentOrigin(input.assignmentOrigin);

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
        .where(eq(userAiAccessPolicyTable.user_id, input.userId));

      return {
        ...existing,
        enabled: input.enabled,
        provider: input.provider,
        credentialId: input.credentialId,
        assignmentOrigin,
        updatedAt: now,
      };
    }

    const id = `ai_access_${randomUUID()}`;
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
    });

    return {
      id,
      userId: input.userId,
      enabled: input.enabled,
      provider: input.provider,
      credentialId: input.credentialId,
      assignmentOrigin,
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
    credentialId: row.credential_id,
    assignmentOrigin: parseAssignmentOrigin(row.assignment_origin),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function parseProvider(value: string | null): AiAccessProvider | null {
  return isAiGatewayProvider(value) ? value : null;
}

function parseAssignmentOrigin(value: string | null | undefined): AiAccessAssignmentOrigin {
  return value === "auto_assigned" ? "auto_assigned" : "admin_assigned";
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
