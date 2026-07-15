import assert from "node:assert/strict";
import test from "node:test";

import type { AiGatewayDb } from "../src/db/index.js";
import { auditEventTable, platformModelPolicyTable, userAiAccessPolicyTable } from "../src/db/schema.js";
import {
  MySqlPlatformModelPolicyMutation,
  MySqlPlatformModelPolicyRepository,
  PlatformModelPolicyAssignmentConflictError,
} from "../src/model-policy/mysql-repository.js";

type ModelPolicyRow = {
  id: "platform";
  enabled_models_json: string;
  active_provider: string;
  active_model: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function createModelPolicyDb(
  initialRow: ModelPolicyRow | null = null,
  options: { incompatibleAssignmentCount?: number } = {},
) {
  let row = initialRow;
  const transactions: unknown[] = [];
  const lockedTables: string[] = [];
  const writes: Array<{
    values: Record<string, unknown>;
    set: Record<string, unknown>;
  }> = [];

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === userAiAccessPolicyTable) {
                return Promise.resolve([{ count: options.incompatibleAssignmentCount ?? 0 }]);
              }

              return {
                limit() {
                  const result = Promise.resolve(row ? [row] : []) as Promise<ModelPolicyRow[]> & {
                    for(mode: string): Promise<ModelPolicyRow[]>;
                  };
                  result.for = async () => {
                    if (table !== platformModelPolicyTable) {
                      throw new Error("unexpected locking select table");
                    }
                    lockedTables.push("platform_model_policy:update");
                    return row ? [row] : [];
                  };
                  return result;
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          return {
            async onDuplicateKeyUpdate(input: { set: Record<string, unknown> }) {
              writes.push({ values, set: input.set });
              row = row
                ? ({ ...row, ...input.set } as ModelPolicyRow)
                : (values as ModelPolicyRow);
            },
          };
        },
      };
    },
    update() {
      throw new Error("policy replacement must use one atomic upsert");
    },
    delete() {
      throw new Error("policy replacement must not delete the current policy first");
    },
    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      transactions.push(callback);
      return callback(db);
    },
  };

  return {
    lockedTables,
    transactions,
    writes,
    db,
  };
}

function createModelPolicyMutationDb(options: {
  initialRow?: ModelPolicyRow | null;
  incompatibleAssignmentCount?: number;
} = {}) {
  let row = options.initialRow ?? {
    id: "platform" as const,
    enabled_models_json: JSON.stringify([{ provider: "codex_oauth", model: "gpt-5.4" }]),
    active_provider: "codex_oauth",
    active_model: "gpt-5.4",
    created_at: new Date("2026-07-12T08:00:00.000Z"),
    updated_at: new Date("2026-07-12T08:00:00.000Z"),
  };
  const lockedTables: string[] = [];
  const policyWrites: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }> = [];
  const auditWrites: Record<string, unknown>[] = [];

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === userAiAccessPolicyTable) {
                return Promise.resolve([{ count: options.incompatibleAssignmentCount ?? 0 }]);
              }

              return {
                limit() {
                  return {
                    async for() {
                      if (table !== platformModelPolicyTable) {
                        throw new Error("unexpected locking select table");
                      }
                      lockedTables.push("platform_model_policy:update");
                      return row ? [row] : [];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === auditEventTable) {
            auditWrites.push(values);
            return Promise.resolve();
          }

          return {
            async onDuplicateKeyUpdate(input: { set: Record<string, unknown> }) {
              policyWrites.push({ values, set: input.set });
              row = row
                ? ({ ...row, ...input.set } as ModelPolicyRow)
                : (values as ModelPolicyRow);
            },
          };
        },
      };
    },
    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(db);
    },
  };

  return {
    auditWrites,
    lockedTables,
    policyWrites,
    db,
  };
}

test("returns null when the platform model policy has not been configured", async () => {
  const writable = createModelPolicyDb();
  const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);

  assert.equal(await repository.getPolicy(), null);
});

test("normalizes and stores multiple unique provider and model references", async () => {
  const writable = createModelPolicyDb();
  const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);

  const policy = await repository.replacePolicy({
    enabledModels: [
      { provider: "openai", model: "  gpt-5.4  " },
      { provider: "anthropic", model: " shared-model " },
      { provider: "openai", model: "gpt-5.4" },
      { provider: "openai_compatible", model: "shared-model" },
    ],
    activeModel: { provider: "openai", model: " gpt-5.4 " },
  });

  assert.deepEqual(policy.enabledModels, [
    { provider: "openai", model: "gpt-5.4" },
    { provider: "anthropic", model: "shared-model" },
    { provider: "openai_compatible", model: "shared-model" },
  ]);
  assert.deepEqual(policy.activeModel, { provider: "openai", model: "gpt-5.4" });
  assert.equal(policy.id, "platform");
  assert.deepEqual(writable.lockedTables, ["platform_model_policy:update"]);
});

test("rejects empty policies and active models outside the enabled model set", async () => {
  const writable = createModelPolicyDb();
  const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);

  await assert.rejects(
    repository.replacePolicy({
      enabledModels: [],
      activeModel: { provider: "openai", model: "gpt-5.4" },
    }),
    /at least one enabled model/i,
  );
  await assert.rejects(
    repository.replacePolicy({
      enabledModels: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
      activeModel: { provider: "openai", model: "gpt-5.4" },
    }),
    /active model must be enabled/i,
  );
  assert.equal(writable.writes.length, 0);
});

test("rejects active and non-active model identifiers longer than the storage limit", async () => {
  const writable = createModelPolicyDb();
  const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);
  const overlongModel = "m".repeat(129);

  await assert.rejects(
    repository.replacePolicy({
      enabledModels: [{ provider: "openai", model: overlongModel }],
      activeModel: { provider: "openai", model: overlongModel },
    }),
    /model.*128/i,
  );
  await assert.rejects(
    repository.replacePolicy({
      enabledModels: [
        { provider: "openai", model: "gpt-5.4" },
        { provider: "anthropic", model: overlongModel },
      ],
      activeModel: { provider: "openai", model: "gpt-5.4" },
    }),
    /model.*128/i,
  );
  assert.equal(writable.writes.length, 0);
});

test("round-trips providers, models, and timestamps from the singleton row", async () => {
  const writable = createModelPolicyDb({
    id: "platform",
    enabled_models_json: JSON.stringify([
      { provider: "openai", model: "gpt-5.4" },
      { provider: "codex_oauth", model: "gpt-5.3-codex" },
    ]),
    active_provider: "codex_oauth",
    active_model: "gpt-5.3-codex",
    created_at: "2026-07-12T08:00:00.000Z",
    updated_at: "2026-07-12T08:05:00.000Z",
  });
  const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);

  const policy = await repository.getPolicy();

  assert.deepEqual(policy, {
    id: "platform",
    enabledModels: [
      { provider: "openai", model: "gpt-5.4" },
      { provider: "codex_oauth", model: "gpt-5.3-codex" },
    ],
    activeModel: { provider: "codex_oauth", model: "gpt-5.3-codex" },
    createdAt: new Date("2026-07-12T08:00:00.000Z"),
    updatedAt: new Date("2026-07-12T08:05:00.000Z"),
  });
});

test("audited model policy mutation rejects active providers that would strand enabled assignments", async () => {
  const writable = createModelPolicyMutationDb({ incompatibleAssignmentCount: 1 });
  const mutation = new MySqlPlatformModelPolicyMutation(writable.db as AiGatewayDb);

  await assert.rejects(
    mutation.replacePolicyWithAudit({
      actorUserId: "user_platform_admin",
      enabledModels: [{ provider: "openai_compatible", model: "custom/model-v1" }],
      activeModel: { provider: "openai_compatible", model: "custom/model-v1" },
    }),
    (error: unknown) => error instanceof PlatformModelPolicyAssignmentConflictError
      && error.message === "model_policy_active_provider_has_incompatible_assignments"
      && (error as { status?: number }).status === 409,
  );

  assert.deepEqual(writable.lockedTables, ["platform_model_policy:update"]);
  assert.deepEqual(writable.policyWrites, []);
  assert.deepEqual(writable.auditWrites, []);
});

test("non-audited model policy replacement rejects active providers that would strand enabled assignments", async () => {
  const writable = createModelPolicyDb(null, { incompatibleAssignmentCount: 1 });
  const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);

  await assert.rejects(
    repository.replacePolicy({
      enabledModels: [{ provider: "openai_compatible", model: "custom/model-v1" }],
      activeModel: { provider: "openai_compatible", model: "custom/model-v1" },
    }),
    (error: unknown) => error instanceof PlatformModelPolicyAssignmentConflictError
      && error.message === "model_policy_active_provider_has_incompatible_assignments"
      && (error as { status?: number }).status === 409,
  );

  assert.deepEqual(writable.lockedTables, ["platform_model_policy:update"]);
  assert.deepEqual(writable.writes, []);
});

test("fails closed when stored enabled models are malformed", async () => {
  const cases: Array<{ name: string; enabledModelsJson: string; pattern: RegExp }> = [
    { name: "invalid JSON", enabledModelsJson: "{", pattern: /invalid json/i },
    {
      name: "unknown provider",
      enabledModelsJson: JSON.stringify([
        { provider: "openai", model: "gpt-5.4" },
        { provider: "unknown", model: "other" },
      ]),
      pattern: /provider is invalid/i,
    },
    {
      name: "partially malformed array",
      enabledModelsJson: JSON.stringify([
        { provider: "openai", model: "gpt-5.4" },
        { provider: "anthropic", model: "   " },
      ]),
      pattern: /stored.*model.*invalid/i,
    },
  ];

  for (const malformed of cases) {
    const writable = createModelPolicyDb({
      id: "platform",
      enabled_models_json: malformed.enabledModelsJson,
      active_provider: "openai",
      active_model: "gpt-5.4",
      created_at: "2026-07-12T08:00:00.000Z",
      updated_at: "2026-07-12T08:05:00.000Z",
    });
    const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);

    await assert.rejects(repository.getPolicy(), malformed.pattern, malformed.name);
  }
});

test("fails closed with clear errors for invalid stored timestamps", async () => {
  for (const timestamp of ["created_at", "updated_at"] as const) {
    const writable = createModelPolicyDb({
      id: "platform",
      enabled_models_json: JSON.stringify([{ provider: "openai", model: "gpt-5.4" }]),
      active_provider: "openai",
      active_model: "gpt-5.4",
      created_at: timestamp === "created_at" ? "not-a-date" : "2026-07-12T08:00:00.000Z",
      updated_at: timestamp === "updated_at" ? "not-a-date" : "2026-07-12T08:05:00.000Z",
    });
    const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);

    await assert.rejects(repository.getPolicy(), new RegExp(`stored.*${timestamp}.*invalid`, "i"));
  }
});

test("replaces the complete policy with one transactional singleton upsert and read", async () => {
  const writable = createModelPolicyDb();
  const repository = new MySqlPlatformModelPolicyRepository(writable.db as AiGatewayDb);

  const original = await repository.replacePolicy({
    enabledModels: [
      { provider: "openai", model: "gpt-5.4" },
      { provider: "anthropic", model: "claude-sonnet-4-5" },
    ],
    activeModel: { provider: "openai", model: "gpt-5.4" },
  });
  const replacement = await repository.replacePolicy({
    enabledModels: [{ provider: "codex_oauth", model: "gpt-5.3-codex" }],
    activeModel: { provider: "codex_oauth", model: "gpt-5.3-codex" },
  });

  assert.equal(writable.writes.length, 2);
  assert.equal(writable.transactions.length, 2);
  assert.deepEqual(Object.keys(writable.writes[1]?.set ?? {}).sort(), [
    "active_model",
    "active_provider",
    "enabled_models_json",
    "updated_at",
  ]);
  assert.deepEqual(replacement.enabledModels, [{ provider: "codex_oauth", model: "gpt-5.3-codex" }]);
  assert.deepEqual(replacement.activeModel, { provider: "codex_oauth", model: "gpt-5.3-codex" });
  assert.equal(replacement.createdAt.getTime(), original.createdAt.getTime());
  assert.ok(replacement.updatedAt.getTime() >= original.updatedAt.getTime());
});
