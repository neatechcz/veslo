import assert from "node:assert/strict";
import test from "node:test";

import type { AiGatewayDb } from "../src/db/index.js";
import { MySqlPlatformModelPolicyRepository } from "../src/model-policy/mysql-repository.js";

type ModelPolicyRow = {
  id: "platform";
  enabled_models_json: string;
  active_provider: string;
  active_model: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function createModelPolicyDb(initialRow: ModelPolicyRow | null = null) {
  let row = initialRow;
  const writes: Array<{
    values: Record<string, unknown>;
    set: Record<string, unknown>;
  }> = [];

  return {
    writes,
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return row ? [row] : [];
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
    },
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

test("replaces the complete policy with one atomic singleton upsert", async () => {
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
