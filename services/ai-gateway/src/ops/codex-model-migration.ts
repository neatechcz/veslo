import { eq, inArray } from "drizzle-orm";

import type { AiGatewayDb } from "../db/index.js";
import { userAiAccessPolicyTable } from "../db/schema.js";
import { CODEX_OAUTH_PROVIDER } from "../providers/ids.js";

const CODEX_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

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
  apply(input: { model: string; now: Date }): Promise<CodexPolicySnapshot[]>;
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

  const rows = input.apply
    ? await input.store.apply({ model: input.model, now: input.now ?? new Date() })
    : await input.store.preview();
  const targetAllowedModelsJson = JSON.stringify([input.model]);

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

  async apply(input: { model: string; now: Date }): Promise<CodexPolicySnapshot[]> {
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
        .where(eq(userAiAccessPolicyTable.provider, CODEX_OAUTH_PROVIDER));
      const snapshots = rows.map(mapPolicySnapshot);
      const targetAllowedModelsJson = JSON.stringify([input.model]);
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
          .where(inArray(userAiAccessPolicyTable.id, changedIds));
      }

      return snapshots;
    });
  }
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
