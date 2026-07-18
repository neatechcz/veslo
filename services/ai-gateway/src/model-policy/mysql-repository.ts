import { randomUUID } from "node:crypto";

import { and, eq, isNull, ne, or, sql } from "drizzle-orm";

import type { AiGatewayDb } from "../db/index.js";
import { auditEventTable, platformModelPolicyTable, userAiAccessPolicyTable } from "../db/schema.js";
import { isAiGatewayProvider, type AiGatewayProvider } from "../providers/ids.js";
import type {
  PlatformModelPolicyRecord,
  PlatformModelPolicyMutation,
  PlatformModelPolicyRepository,
  PlatformModelRef,
  ReplacePlatformModelPolicyWithAuditInput,
} from "./repository.js";

const PLATFORM_POLICY_ID = "platform" as const;
const MODEL_STORAGE_LENGTH = 128;

export class MySqlPlatformModelPolicyRepository implements PlatformModelPolicyRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async getPolicy(): Promise<PlatformModelPolicyRecord | null> {
    const rows = await this.db
      .select()
      .from(platformModelPolicyTable)
      .where(eq(platformModelPolicyTable.id, PLATFORM_POLICY_ID))
      .limit(1);

    const row = rows[0];
    return row ? mapPlatformModelPolicy(row) : null;
  }

  async replacePolicy(input: {
    enabledModels: PlatformModelRef[];
    activeModel: PlatformModelRef;
  }): Promise<PlatformModelPolicyRecord> {
    const enabledModels = normalizeModelRefs(input.enabledModels);
    if (enabledModels.length === 0) {
      throw new Error("Platform model policy requires at least one enabled model");
    }

    const activeModel = normalizeModelRef(input.activeModel);
    if (!activeModel || !enabledModels.some((model) => modelRefsEqual(model, activeModel))) {
      throw new Error("Platform active model must be enabled");
    }

    const now = new Date();
    const replacement = {
      enabled_models_json: JSON.stringify(enabledModels),
      active_provider: activeModel.provider,
      active_model: activeModel.model,
      updated_at: now,
    };

    return this.db.transaction(async (tx) => {
      await tx
        .select()
        .from(platformModelPolicyTable)
        .where(eq(platformModelPolicyTable.id, PLATFORM_POLICY_ID))
        .limit(1)
        .for("update");
      await assertNoEnabledAssignmentsIncompatibleWithProvider(tx, activeModel.provider);

      await tx
        .insert(platformModelPolicyTable)
        .values({
          id: PLATFORM_POLICY_ID,
          ...replacement,
          created_at: now,
        })
        .onDuplicateKeyUpdate({ set: replacement });

      const rows = await tx
        .select()
        .from(platformModelPolicyTable)
        .where(eq(platformModelPolicyTable.id, PLATFORM_POLICY_ID))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new Error("Platform model policy was not persisted");
      }
      return mapPlatformModelPolicy(row);
    });
  }
}

export class PlatformModelPolicyAuditPersistenceError extends Error {
  readonly code = "model_policy_audit_failed";

  constructor(cause: unknown) {
    super("model_policy_audit_failed", { cause });
    this.name = "PlatformModelPolicyAuditPersistenceError";
  }
}

export class PlatformModelPolicyAssignmentConflictError extends Error {
  readonly code = "model_policy_active_provider_has_incompatible_assignments";
  readonly status = 409;

  constructor() {
    super("model_policy_active_provider_has_incompatible_assignments");
    this.name = "PlatformModelPolicyAssignmentConflictError";
  }
}

export class MySqlPlatformModelPolicyMutation implements PlatformModelPolicyMutation {
  constructor(private readonly db: AiGatewayDb) {}

  async replacePolicyWithAudit(
    input: ReplacePlatformModelPolicyWithAuditInput,
  ): Promise<PlatformModelPolicyRecord> {
    const enabledModels = normalizeModelRefs(input.enabledModels);
    if (enabledModels.length === 0) {
      throw new Error("Platform model policy requires at least one enabled model");
    }
    const activeModel = normalizeModelRef(input.activeModel);
    if (!activeModel || !enabledModels.some((model) => modelRefsEqual(model, activeModel))) {
      throw new Error("Platform active model must be enabled");
    }

    return this.db.transaction(async (tx) => {
      const previousRows = await tx
        .select()
        .from(platformModelPolicyTable)
        .where(eq(platformModelPolicyTable.id, PLATFORM_POLICY_ID))
        .limit(1)
        .for("update");
      const previous = previousRows[0] ? mapPlatformModelPolicy(previousRows[0]) : null;
      const now = new Date();
      const replacement = {
        enabled_models_json: JSON.stringify(enabledModels),
        active_provider: activeModel.provider,
        active_model: activeModel.model,
        updated_at: now,
      };
      await assertNoEnabledAssignmentsIncompatibleWithProvider(tx, activeModel.provider);

      await tx
        .insert(platformModelPolicyTable)
        .values({
          id: PLATFORM_POLICY_ID,
          ...replacement,
          created_at: now,
        })
        .onDuplicateKeyUpdate({ set: replacement });

      const savedRows = await tx
        .select()
        .from(platformModelPolicyTable)
        .where(eq(platformModelPolicyTable.id, PLATFORM_POLICY_ID))
        .limit(1);
      const savedRow = savedRows[0];
      if (!savedRow) {
        throw new Error("Platform model policy was not persisted");
      }
      const saved = mapPlatformModelPolicy(savedRow);

      // Admin assignments deliberately publish the complete enabled roster for
      // the active provider. Keep existing assignments in that same contract
      // inside the policy/audit transaction, rather than relying on a desktop
      // client to infer or repair authorization.
      await synchronizeEnabledAssignmentRosters(tx, saved, now);

      try {
        await tx.insert(auditEventTable).values({
          id: `audit_${randomUUID()}`,
          actor_user_id: input.actorUserId,
          entity_type: "platform_model_policy",
          entity_id: PLATFORM_POLICY_ID,
          action: "platform.model_policy.update",
          result: "ok",
          summary: formatPlatformModelPolicyAuditSummary(previous, saved),
          created_at: now,
        });
      } catch (error) {
        throw new PlatformModelPolicyAuditPersistenceError(error);
      }

      return saved;
    }, { isolationLevel: "serializable" });
  }
}

async function assertNoEnabledAssignmentsIncompatibleWithProvider(
  db: Pick<AiGatewayDb, "select">,
  provider: AiGatewayProvider,
): Promise<void> {
  const incompatibleAssignments = await db
    .select({ count: sql<number>`count(*)` })
    .from(userAiAccessPolicyTable)
    .where(and(
      eq(userAiAccessPolicyTable.enabled, 1),
      or(
        isNull(userAiAccessPolicyTable.provider),
        ne(userAiAccessPolicyTable.provider, provider),
      ),
    ));
  if (Number(incompatibleAssignments[0]?.count ?? 0) > 0) {
    throw new PlatformModelPolicyAssignmentConflictError();
  }
}

async function synchronizeEnabledAssignmentRosters(
  db: Pick<AiGatewayDb, "update">,
  policy: PlatformModelPolicyRecord,
  now: Date,
): Promise<void> {
  const allowedModels = platformProviderRoster(policy);
  await db
    .update(userAiAccessPolicyTable)
    .set({
      default_model: policy.activeModel.model,
      allowed_models_json: JSON.stringify(allowedModels),
      updated_at: now,
    })
    .where(and(
      eq(userAiAccessPolicyTable.enabled, 1),
      eq(userAiAccessPolicyTable.provider, policy.activeModel.provider),
    ));
}

function platformProviderRoster(policy: PlatformModelPolicyRecord): string[] {
  const activeModel = policy.activeModel.model;
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of policy.enabledModels) {
    if (entry.provider !== policy.activeModel.provider) continue;
    const model = entry.model.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models.includes(activeModel)
    ? [activeModel, ...models.filter((model) => model !== activeModel)]
    : [activeModel];
}

export function formatPlatformModelPolicyAuditSummary(
  before: PlatformModelPolicyRecord | null,
  after: PlatformModelPolicyRecord,
): string {
  return `Updated platform model policy: active ${formatModelRef(before?.activeModel)} -> ${formatModelRef(after.activeModel)}; enabled [${formatModelRefs(before?.enabledModels ?? [])}] -> [${formatModelRefs(after.enabledModels)}].`;
}

function formatModelRefs(models: PlatformModelRef[]): string {
  return [...models]
    .sort((left, right) => modelRefKey(left).localeCompare(modelRefKey(right)))
    .map(formatModelRef)
    .join(", ");
}

function formatModelRef(model: PlatformModelRef | null | undefined): string {
  return model ? `${model.provider}/${model.model}` : "none";
}

function modelRefKey(model: PlatformModelRef): string {
  return `${model.provider}\u0000${model.model}`;
}

function mapPlatformModelPolicy(row: typeof platformModelPolicyTable.$inferSelect): PlatformModelPolicyRecord {
  const enabledModels = parseEnabledModelsJson(row.enabled_models_json);
  const activeModel = normalizeModelRef({
    provider: row.active_provider as PlatformModelRef["provider"],
    model: row.active_model,
  });

  if (!activeModel || !enabledModels.some((model) => modelRefsEqual(model, activeModel))) {
    throw new Error("Stored platform active model must be enabled");
  }

  return {
    id: PLATFORM_POLICY_ID,
    enabledModels,
    activeModel,
    createdAt: asStoredDate(row.created_at, "created_at"),
    updatedAt: asStoredDate(row.updated_at, "updated_at"),
  };
}

function parseEnabledModelsJson(value: string): PlatformModelRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored platform enabled models are invalid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Stored platform enabled models must be an array");
  }

  const enabledModels = normalizeStoredModelRefs(parsed);
  if (enabledModels.length === 0) {
    throw new Error("Stored platform model policy requires at least one enabled model");
  }
  return enabledModels;
}

function normalizeModelRefs(values: PlatformModelRef[]): PlatformModelRef[] {
  const normalized: PlatformModelRef[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const modelRef = normalizeModelRef(value);
    if (!modelRef) continue;
    const key = `${modelRef.provider}\u0000${modelRef.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(modelRef);
  }

  return normalized;
}

function normalizeModelRef(value: PlatformModelRef): PlatformModelRef | null {
  const provider = typeof value?.provider === "string" ? value.provider.trim() : "";
  if (!isAiGatewayProvider(provider)) {
    throw new Error("Platform model provider is invalid");
  }

  const model = typeof value?.model === "string" ? value.model.trim() : "";
  if (!model) return null;
  validateModelStorageLength(model);
  return { provider, model };
}

function normalizeStoredModelRefs(values: unknown[]): PlatformModelRef[] {
  const normalized: PlatformModelRef[] = [];
  const seen = new Set<string>();

  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== "object") {
      throw new Error(`Stored platform enabled model at index ${index} is invalid`);
    }

    let modelRef: PlatformModelRef | null;
    try {
      modelRef = normalizeModelRef(value as PlatformModelRef);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Stored platform enabled model at index ${index} is invalid: ${message}`);
    }
    if (!modelRef) {
      throw new Error(`Stored platform enabled model at index ${index} is invalid`);
    }

    const key = `${modelRef.provider}\u0000${modelRef.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(modelRef);
  }

  return normalized;
}

function validateModelStorageLength(model: string) {
  if (Array.from(model).length > MODEL_STORAGE_LENGTH) {
    throw new Error(`Platform model identifier must be at most ${MODEL_STORAGE_LENGTH} characters`);
  }
}

function modelRefsEqual(left: PlatformModelRef, right: PlatformModelRef) {
  return left.provider === right.provider && left.model === right.model;
}

function asStoredDate(value: Date | string, column: "created_at" | "updated_at"): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Stored platform model policy ${column} timestamp is invalid`);
  }
  return date;
}
