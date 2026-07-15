import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { AiGatewayDb } from "../db/index.js";
import { auditEventTable, platformModelPolicyTable, userAiAccessPolicyTable } from "../db/schema.js";
import { CODEX_DEFAULT_MODEL } from "../providers/codex-model-catalog.js";
import { isAiGatewayProvider } from "../providers/ids.js";
import type {
  AiAccessAssignmentOrigin,
  AiAccessProvider,
  AiAccessMutation,
  AiAccessRepository,
  UpsertUserAiAccessPolicyInput,
  UpsertUserAiAccessWithAuditInput,
  UserAiAccessPolicyRecord,
} from "./repository.js";

export class AiAccessAuditPersistenceError extends Error {
  readonly code = "user_ai_access_audit_failed";

  constructor(cause: unknown) {
    super("user_ai_access_audit_failed", { cause });
    this.name = "AiAccessAuditPersistenceError";
  }
}

export class AiAccessModelPolicyUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super("platform_model_policy_not_configured");
    this.name = "AiAccessModelPolicyUnavailableError";
  }
}

export class AiAccessProviderMismatchError extends Error {
  readonly status = 409;

  constructor() {
    super("ai_access_provider_mismatch");
    this.name = "AiAccessProviderMismatchError";
  }
}

export class MySqlAiAccessMutation implements AiAccessMutation {
  constructor(private readonly db: AiGatewayDb) {}

  async upsertUserAiAccessWithAudit(
    input: UpsertUserAiAccessWithAuditInput,
  ): Promise<UserAiAccessPolicyRecord> {
    return this.db.transaction(async (tx) => {
      const activeProvider = await lockPlatformActiveProvider(tx);
      if (input.enabled && input.provider !== activeProvider) {
        throw new AiAccessProviderMismatchError();
      }

      const rows = await tx
        .select()
        .from(userAiAccessPolicyTable)
        .where(eq(userAiAccessPolicyTable.user_id, input.userId))
        .limit(1)
        .for("update");
      const existing = rows[0] ? mapUserAiAccessPolicy(rows[0]) : null;
      const now = new Date();
      const assignmentOrigin = parseAssignmentOrigin(input.assignmentOrigin);
      const modelPolicy = resolveAiAccessModelFields(input, existing);
      let saved: UserAiAccessPolicyRecord;

      if (existing) {
        await tx
          .update(userAiAccessPolicyTable)
          .set({
            enabled: input.enabled ? 1 : 0,
            provider: input.provider,
            credential_id: input.credentialId,
            default_model: modelPolicy.defaultModel,
            allowed_models_json: JSON.stringify(modelPolicy.allowedModels),
            assignment_origin: assignmentOrigin,
            updated_at: now,
          })
          .where(eq(userAiAccessPolicyTable.user_id, input.userId));
        saved = {
          ...existing,
          enabled: input.enabled,
          provider: input.provider,
          credentialId: input.credentialId,
          defaultModel: modelPolicy.defaultModel,
          allowedModels: modelPolicy.allowedModels,
          assignmentOrigin,
          updatedAt: now,
        };
      } else {
        const id = `ai_access_${randomUUID()}`;
        await tx.insert(userAiAccessPolicyTable).values({
          id,
          user_id: input.userId,
          enabled: input.enabled ? 1 : 0,
          provider: input.provider,
          credential_id: input.credentialId,
          default_model: modelPolicy.defaultModel,
          allowed_models_json: JSON.stringify(modelPolicy.allowedModels),
          assignment_origin: assignmentOrigin,
          created_at: now,
          updated_at: now,
        });
        saved = {
          id,
          userId: input.userId,
          enabled: input.enabled,
          provider: input.provider,
          credentialId: input.credentialId,
          defaultModel: modelPolicy.defaultModel,
          allowedModels: modelPolicy.allowedModels,
          assignmentOrigin,
          createdAt: now,
          updatedAt: now,
        };
      }

      try {
        await tx.insert(auditEventTable).values({
          id: `audit_${randomUUID()}`,
          actor_user_id: input.actorUserId,
          organization_id: input.organizationId,
          entity_type: "user",
          entity_id: input.userId,
          action: "user.ai_access.update",
          result: "ok",
          summary: `Updated AI access for user ${input.userId}.`,
          created_at: now,
        });
      } catch (error) {
        throw new AiAccessAuditPersistenceError(error);
      }

      return saved;
    }, { isolationLevel: "serializable" });
  }
}

export class MySqlAiAccessRepository implements AiAccessRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async countEnabledPolicies(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(userAiAccessPolicyTable)
      .where(eq(userAiAccessPolicyTable.enabled, 1));

    return Number(rows[0]?.count ?? 0);
  }

  async countEnabledPoliciesIncompatibleWithProvider(provider: AiAccessProvider): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(userAiAccessPolicyTable)
      .where(and(
        eq(userAiAccessPolicyTable.enabled, 1),
        or(
          isNull(userAiAccessPolicyTable.provider),
          ne(userAiAccessPolicyTable.provider, provider),
        ),
      ));

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
    return this.db.transaction(async (tx) => {
      const activeProvider = await lockPlatformActiveProvider(tx);
      if (input.enabled && input.provider !== activeProvider) {
        throw new AiAccessProviderMismatchError();
      }

      const rows = await tx
        .select()
        .from(userAiAccessPolicyTable)
        .where(eq(userAiAccessPolicyTable.user_id, input.userId))
        .limit(1)
        .for("update");
      const existing = rows[0] ? mapUserAiAccessPolicy(rows[0]) : null;
      const now = new Date();
      const assignmentOrigin = parseAssignmentOrigin(input.assignmentOrigin);
      const modelPolicy = resolveAiAccessModelFields(input, existing);

      if (existing) {
        await tx
          .update(userAiAccessPolicyTable)
          .set({
            enabled: input.enabled ? 1 : 0,
            provider: input.provider,
            credential_id: input.credentialId,
            default_model: modelPolicy.defaultModel,
            allowed_models_json: JSON.stringify(modelPolicy.allowedModels),
            assignment_origin: assignmentOrigin,
            updated_at: now,
          })
          .where(eq(userAiAccessPolicyTable.user_id, input.userId));

        return {
          ...existing,
          enabled: input.enabled,
          provider: input.provider,
          credentialId: input.credentialId,
          defaultModel: modelPolicy.defaultModel,
          allowedModels: modelPolicy.allowedModels,
          assignmentOrigin,
          updatedAt: now,
        };
      }

      const id = `ai_access_${randomUUID()}`;
      await tx.insert(userAiAccessPolicyTable).values({
        id,
        user_id: input.userId,
        enabled: input.enabled ? 1 : 0,
        provider: input.provider,
        credential_id: input.credentialId,
        default_model: modelPolicy.defaultModel,
        allowed_models_json: JSON.stringify(modelPolicy.allowedModels),
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
        defaultModel: modelPolicy.defaultModel,
        allowedModels: modelPolicy.allowedModels,
        assignmentOrigin,
        createdAt: now,
        updatedAt: now,
      };
    }, { isolationLevel: "serializable" });
  }
}

function mapUserAiAccessPolicy(row: typeof userAiAccessPolicyTable.$inferSelect): UserAiAccessPolicyRecord {
  const provider = parseProvider(row.provider);
  const parsedAllowedModels = parseAllowedModelsJson(row.allowed_models_json);
  const defaultModel = resolveDefaultModel({
    provider,
    defaultModel: row.default_model,
    allowedModels: parsedAllowedModels,
  });
  return {
    id: row.id,
    userId: row.user_id,
    enabled: Number(row.enabled) === 1,
    provider,
    credentialId: row.credential_id,
    defaultModel,
    allowedModels: normalizeAllowedModels(
      parsedAllowedModels.length > 0
        ? parsedAllowedModels
        : defaultModel
          ? [defaultModel]
          : [],
    ),
    assignmentOrigin: parseAssignmentOrigin(row.assignment_origin),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function resolveAiAccessModelFields(
  input: UpsertUserAiAccessPolicyInput,
  existing: UserAiAccessPolicyRecord | null,
): { defaultModel: string | null; allowedModels: string[] } {
  if (!input.enabled) {
    return { defaultModel: null, allowedModels: [] };
  }
  const allowedModels = normalizeAllowedModels(
    Object.hasOwn(input, "allowedModels") ? input.allowedModels ?? [] : existing?.allowedModels ?? [],
  );
  const defaultModel = resolveDefaultModel({
    provider: input.provider,
    defaultModel: Object.hasOwn(input, "defaultModel") ? input.defaultModel : existing?.defaultModel ?? null,
    allowedModels,
  });
  return {
    defaultModel,
    allowedModels: normalizeAllowedModels(
      allowedModels.length > 0
        ? allowedModels
        : defaultModel
          ? [defaultModel]
          : [],
    ),
  };
}

function resolveDefaultModel(input: {
  provider: AiAccessProvider | null;
  defaultModel: unknown;
  allowedModels: string[];
}): string | null {
  const explicit = normalizeModel(input.defaultModel);
  if (explicit) {
    return explicit;
  }
  const firstAllowed = input.allowedModels[0]?.trim() ?? "";
  if (firstAllowed) {
    return firstAllowed;
  }
  if (input.provider === "codex_oauth") {
    return CODEX_DEFAULT_MODEL;
  }
  return null;
}

function parseProvider(value: string | null): AiAccessProvider | null {
  return isAiGatewayProvider(value) ? value : null;
}

async function lockPlatformActiveProvider(tx: Pick<AiGatewayDb, "select">): Promise<AiAccessProvider> {
  const rows = await tx
    .select({ activeProvider: platformModelPolicyTable.active_provider })
    .from(platformModelPolicyTable)
    .where(eq(platformModelPolicyTable.id, "platform"))
    .limit(1)
    .for("update");
  const activeProvider = parseProvider(rows[0]?.activeProvider ?? null);
  if (!activeProvider) {
    throw new AiAccessModelPolicyUnavailableError();
  }
  return activeProvider;
}

function parseAssignmentOrigin(value: string | null | undefined): AiAccessAssignmentOrigin {
  return value === "auto_assigned" ? "auto_assigned" : "admin_assigned";
}

function parseAllowedModelsJson(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeAllowedModels(parsed);
  } catch {
    return [];
  }
}

function normalizeAllowedModels(values: unknown[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const model = normalizeModel(value);
    if (model) {
      unique.add(model);
    }
  }
  return Array.from(unique);
}

function normalizeModel(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
