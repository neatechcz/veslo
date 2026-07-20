import { and, eq, inArray } from "drizzle-orm";

import type { AiGatewayDb } from "../db/index.js";
import { platformModelPolicyTable, userAiAccessPolicyTable } from "../db/schema.js";
import { CODEX_OAUTH_PROVIDER } from "../providers/ids.js";

const CODEX_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PLATFORM_POLICY_ID = "platform";

export type CodexPolicySnapshot = {
  id: string;
  userId: string;
  enabled: boolean;
  credentialId: string | null;
  defaultModel: string | null;
  allowedModelsJson: string;
  assignmentOrigin: string;
};

export interface CodexPolicyMigrationStore {
  preview(): Promise<CodexPolicySnapshot[]>;
  /**
   * The legacy migration CLI names the intended default model. When the current
   * platform policy is a matching Codex policy, its enabled Codex roster is the
   * authoritative allow-list for the backfill.
   */
  resolveAllowedModels?(model: string): Promise<string[]>;
  apply(input: { model: string; allowedModels?: string[]; now: Date }): Promise<CodexPolicySnapshot[]>;
}

export type CodexModelMigrationSummary = {
  mode: "dry-run" | "apply";
  model: string;
  matchedCount: number;
  changedCount: number;
  enabledCount: number;
  disabledCount: number;
};

export async function runCodexModelMigration(input: {
  store: CodexPolicyMigrationStore;
  model: string;
  apply: boolean;
  now?: Date;
}): Promise<CodexModelMigrationSummary> {
  assertValidCodexModelId(input.model);

  const allowedModels = input.store.resolveAllowedModels
    ? await input.store.resolveAllowedModels(input.model)
    : [input.model];
  const targetAllowedModelsJson = JSON.stringify(allowedModels);

  const rows = input.apply
    ? await input.store.apply({
      model: input.model,
      allowedModels,
      now: input.now ?? new Date(),
    })
    : await input.store.preview();

  return {
    mode: input.apply ? "apply" : "dry-run",
    model: input.model,
    matchedCount: rows.length,
    changedCount: rows.filter(
      (row) => row.defaultModel !== input.model || row.allowedModelsJson !== targetAllowedModelsJson,
    ).length,
    enabledCount: rows.filter((row) => row.enabled).length,
    disabledCount: rows.filter((row) => !row.enabled).length,
  };
}

export function assertValidCodexModelId(model: string): void {
  if (!CODEX_MODEL_ID_PATTERN.test(model)) {
    throw new Error("Invalid Codex model id");
  }
}

export class MySqlCodexPolicyMigrationStore implements CodexPolicyMigrationStore {
  constructor(private readonly db: AiGatewayDb) {}

  async resolveAllowedModels(model: string): Promise<string[]> {
    const rows = await this.db
      .select({
        enabledModelsJson: platformModelPolicyTable.enabled_models_json,
        activeProvider: platformModelPolicyTable.active_provider,
        activeModel: platformModelPolicyTable.active_model,
      })
      .from(platformModelPolicyTable)
      .where(eq(platformModelPolicyTable.id, PLATFORM_POLICY_ID))
      .limit(1);

    return codexRosterFromPlatformPolicy(rows[0], model);
  }

  async preview(): Promise<CodexPolicySnapshot[]> {
    const rows = await this.db
      .select({
        id: userAiAccessPolicyTable.id,
        userId: userAiAccessPolicyTable.user_id,
        enabled: userAiAccessPolicyTable.enabled,
        credentialId: userAiAccessPolicyTable.credential_id,
        defaultModel: userAiAccessPolicyTable.default_model,
        allowedModelsJson: userAiAccessPolicyTable.allowed_models_json,
        assignmentOrigin: userAiAccessPolicyTable.assignment_origin,
      })
      .from(userAiAccessPolicyTable)
      .where(eq(userAiAccessPolicyTable.provider, CODEX_OAUTH_PROVIDER));

    return rows.map(mapPolicySnapshot);
  }

  async apply(input: { model: string; allowedModels?: string[]; now: Date }): Promise<CodexPolicySnapshot[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: userAiAccessPolicyTable.id,
          userId: userAiAccessPolicyTable.user_id,
          enabled: userAiAccessPolicyTable.enabled,
          credentialId: userAiAccessPolicyTable.credential_id,
          defaultModel: userAiAccessPolicyTable.default_model,
          allowedModelsJson: userAiAccessPolicyTable.allowed_models_json,
          assignmentOrigin: userAiAccessPolicyTable.assignment_origin,
        })
        .from(userAiAccessPolicyTable)
        .where(eq(userAiAccessPolicyTable.provider, CODEX_OAUTH_PROVIDER))
        .for("update");
      const snapshots = rows.map(mapPolicySnapshot);
      const targetAllowedModelsJson = JSON.stringify(normalizeCodexRoster(
        input.allowedModels ?? [input.model],
        input.model,
      ));
      const changedIds = snapshots
        .filter(
          (row) => row.defaultModel !== input.model || row.allowedModelsJson !== targetAllowedModelsJson,
        )
        .map((row) => row.id);

      if (changedIds.length > 0) {
        await tx
          .update(userAiAccessPolicyTable)
          .set({
            default_model: input.model,
            allowed_models_json: targetAllowedModelsJson,
            updated_at: input.now,
          })
          .where(and(
            inArray(userAiAccessPolicyTable.id, changedIds),
            eq(userAiAccessPolicyTable.provider, CODEX_OAUTH_PROVIDER),
          ));
      }

      return snapshots;
    });
  }
}

function codexRosterFromPlatformPolicy(
  row: {
    enabledModelsJson: string;
    activeProvider: string;
    activeModel: string;
  } | undefined,
  requestedModel: string,
): string[] {
  if (!row || row.activeProvider !== CODEX_OAUTH_PROVIDER) {
    return [requestedModel];
  }
  if (row.activeModel !== requestedModel) {
    throw new Error("Codex migration model must match the active platform model");
  }

  let rawEnabledModels: unknown;
  try {
    rawEnabledModels = JSON.parse(row.enabledModelsJson);
  } catch {
    throw new Error("Platform model policy has invalid enabled model data");
  }
  if (!Array.isArray(rawEnabledModels)) {
    throw new Error("Platform model policy has invalid enabled model data");
  }

  const models = rawEnabledModels.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as { provider?: unknown; model?: unknown };
    if (value.provider !== CODEX_OAUTH_PROVIDER || typeof value.model !== "string") return [];
    return [value.model];
  });
  return normalizeCodexRoster(models, requestedModel);
}

function normalizeCodexRoster(models: string[], activeModel: string): string[] {
  const normalized = new Set<string>();
  for (const model of models) {
    assertValidCodexModelId(model);
    normalized.add(model);
  }
  if (!normalized.has(activeModel)) {
    throw new Error("Platform model policy does not enable the active Codex model");
  }
  return [activeModel, ...[...normalized].filter((model) => model !== activeModel)];
}

function mapPolicySnapshot(row: {
  id: string;
  userId: string;
  enabled: number;
  credentialId: string | null;
  defaultModel: string | null;
  allowedModelsJson: string;
  assignmentOrigin: string;
}): CodexPolicySnapshot {
  return {
    id: row.id,
    userId: row.userId,
    enabled: Number(row.enabled) === 1,
    credentialId: row.credentialId,
    defaultModel: row.defaultModel,
    allowedModelsJson: row.allowedModelsJson,
    assignmentOrigin: row.assignmentOrigin,
  };
}
