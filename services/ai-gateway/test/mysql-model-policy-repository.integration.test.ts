import assert from "node:assert/strict";
import test from "node:test";

import { createDb } from "../src/db/index.js";
import { MySqlPlatformModelPolicyRepository } from "../src/model-policy/mysql-repository.js";

const testDatabaseUrl = process.env.AI_GATEWAY_MODEL_POLICY_TEST_DATABASE_URL?.trim();

test(
  "concurrent real MySQL replacements return each caller's own policy",
  { skip: testDatabaseUrl ? false : "AI_GATEWAY_MODEL_POLICY_TEST_DATABASE_URL is not configured" },
  async (context) => {
    assert.ok(testDatabaseUrl);
    assertDedicatedTestDatabase(testDatabaseUrl);

    const handle = createDb(testDatabaseUrl);
    context.after(async () => {
      try {
        await handle.client.query("DROP TABLE IF EXISTS `platform_model_policy`");
      } finally {
        await handle.close();
      }
    });

    await handle.client.query("DROP TABLE IF EXISTS `platform_model_policy`");
    await handle.client.query(`
      CREATE TABLE \`platform_model_policy\` (
        \`id\` varchar(32) NOT NULL PRIMARY KEY,
        \`enabled_models_json\` text NOT NULL,
        \`active_provider\` varchar(64) NOT NULL,
        \`active_model\` varchar(128) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL,
        \`updated_at\` timestamp(3) NOT NULL
      )
    `);

    const repository = new MySqlPlatformModelPolicyRepository(handle.db);
    const initial = await repository.replacePolicy({
      enabledModels: [{ provider: "openai", model: "initial-model" }],
      activeModel: { provider: "openai", model: "initial-model" },
    });
    const submittedModels = Array.from({ length: 100 }, (_, index) => `concurrent-model-${index}`);

    const returnedPolicies = await Promise.all(
      submittedModels.map((model) =>
        repository.replacePolicy({
          enabledModels: [{ provider: "openai", model }],
          activeModel: { provider: "openai", model },
        }),
      ),
    );

    for (const [index, policy] of returnedPolicies.entries()) {
      assert.equal(policy.activeModel.model, submittedModels[index]);
      assert.deepEqual(policy.enabledModels, [{ provider: "openai", model: submittedModels[index] }]);
      assert.equal(policy.createdAt.getTime(), initial.createdAt.getTime());
    }
  },
);

function assertDedicatedTestDatabase(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (parsed.protocol !== "mysql:" || !/^veslo_model_policy_test(?:_[a-z0-9_]+)?$/.test(databaseName)) {
    throw new Error(
      "AI_GATEWAY_MODEL_POLICY_TEST_DATABASE_URL must use mysql:// and a dedicated veslo_model_policy_test database",
    );
  }
}
