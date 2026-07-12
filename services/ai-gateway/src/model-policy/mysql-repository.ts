import { eq } from "drizzle-orm";

import type { AiGatewayDb } from "../db/index.js";
import { platformModelPolicyTable } from "../db/schema.js";
import { isAiGatewayProvider } from "../providers/ids.js";
import type {
  PlatformModelPolicyRecord,
  PlatformModelPolicyRepository,
  PlatformModelRef,
} from "./repository.js";

const PLATFORM_POLICY_ID = "platform" as const;

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

    await this.db
      .insert(platformModelPolicyTable)
      .values({
        id: PLATFORM_POLICY_ID,
        ...replacement,
        created_at: now,
      })
      .onDuplicateKeyUpdate({ set: replacement });

    const policy = await this.getPolicy();
    if (!policy) {
      throw new Error("Platform model policy was not persisted");
    }
    return policy;
  }
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
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
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

  const enabledModels = normalizeModelRefs(parsed as PlatformModelRef[]);
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
  return model ? { provider, model } : null;
}

function modelRefsEqual(left: PlatformModelRef, right: PlatformModelRef) {
  return left.provider === right.provider && left.model === right.model;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
