import assert from "node:assert/strict";
import test from "node:test";

import { createDb } from "../src/db/index.js";
import { MySqlPlatformModelPolicyRepository } from "../src/model-policy/mysql-repository.js";
import * as modelPolicyMysql from "../src/model-policy/mysql-repository.js";
import type { PlatformModelPolicyRecord, PlatformModelRef } from "../src/model-policy/repository.js";

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
        await handle.client.query("DROP TRIGGER IF EXISTS `fail_model_policy_audit`");
        await handle.client.query("DROP TABLE IF EXISTS `ai_gateway_audit_event`");
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

test(
  "real MySQL rolls back policy replacement when the audit insert fails",
  { skip: testDatabaseUrl ? false : "AI_GATEWAY_MODEL_POLICY_TEST_DATABASE_URL is not configured" },
  async (context) => {
    assert.ok(testDatabaseUrl);
    assertDedicatedTestDatabase(testDatabaseUrl);
    const handle = createDb(testDatabaseUrl);
    context.after(async () => {
      try {
        await handle.client.query("DROP TRIGGER IF EXISTS `fail_model_policy_audit`");
        await handle.client.query("DROP TABLE IF EXISTS `ai_gateway_audit_event`");
        await handle.client.query("DROP TABLE IF EXISTS `platform_model_policy`");
      } finally {
        await handle.close();
      }
    });
    await createMutationTables(handle.client);

    const repository = new MySqlPlatformModelPolicyRepository(handle.db);
    const initial = await repository.replacePolicy({
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
    });
    await handle.client.query(`
      CREATE TRIGGER fail_model_policy_audit
      BEFORE INSERT ON ai_gateway_audit_event
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced audit failure'
    `);

    const mutation = createRealMutation(handle.db);
    await assert.rejects(
      mutation.replacePolicyWithAudit({
        actorUserId: "user_admin_rollback",
        enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
        activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
      }),
      /forced audit failure|model_policy_audit_failed/i,
    );
    assert.deepEqual(await repository.getPolicy(), initial);
  },
);

test(
  "real MySQL concurrent mutations serialize into one truthful audit chain",
  { skip: testDatabaseUrl ? false : "AI_GATEWAY_MODEL_POLICY_TEST_DATABASE_URL is not configured" },
  async (context) => {
    assert.ok(testDatabaseUrl);
    assertDedicatedTestDatabase(testDatabaseUrl);
    const handle = createDb(testDatabaseUrl);
    context.after(async () => {
      try {
        await handle.client.query("DROP TABLE IF EXISTS `ai_gateway_audit_event`");
        await handle.client.query("DROP TABLE IF EXISTS `platform_model_policy`");
      } finally {
        await handle.close();
      }
    });
    await createMutationTables(handle.client);

    const repository = new MySqlPlatformModelPolicyRepository(handle.db);
    await repository.replacePolicy({
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
    });
    const mutation = createRealMutation(handle.db);
    await Promise.all([
      mutation.replacePolicyWithAudit({
        actorUserId: "user_admin_b",
        enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
        activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
      }),
      mutation.replacePolicyWithAudit({
        actorUserId: "user_admin_c",
        enabledModels: [{ provider: "codex_oauth", model: "gpt-5.3-codex" }],
        activeModel: { provider: "codex_oauth", model: "gpt-5.3-codex" },
      }),
    ]);

    const [auditRows] = await handle.client.query(
      "SELECT `actor_user_id`, `summary` FROM `ai_gateway_audit_event` WHERE `action` = 'platform.model_policy.update'",
    ) as unknown as [Array<{ actor_user_id: string; summary: string }>];
    assert.equal(auditRows.length, 2);
    assert.deepEqual(new Set(auditRows.map((row) => row.actor_user_id)), new Set(["user_admin_b", "user_admin_c"]));

    const edges = auditRows.map((row) => parseActiveEdge(row.summary));
    const first = edges.find((edge) => edge.before === "codex_oauth/gpt-5.4");
    assert.ok(first, "one audit edge must start from the initial model");
    const second = edges.find((edge) => edge !== first);
    assert.ok(second);
    assert.equal(second.before, first.after);
    assert.equal((await repository.getPolicy())?.activeModel.model, second.after.split("/").at(-1));
  },
);

type RealMutation = {
  replacePolicyWithAudit(input: {
    actorUserId: string;
    enabledModels: PlatformModelRef[];
    activeModel: PlatformModelRef;
  }): Promise<PlatformModelPolicyRecord>;
};

function createRealMutation(db: ReturnType<typeof createDb>["db"]): RealMutation {
  const Constructor = (modelPolicyMysql as unknown as {
    MySqlPlatformModelPolicyMutation?: new (database: typeof db) => RealMutation;
  }).MySqlPlatformModelPolicyMutation;
  assert.equal(typeof Constructor, "function");
  return new Constructor!(db);
}

async function createMutationTables(client: ReturnType<typeof createDb>["client"]) {
  await client.query("DROP TRIGGER IF EXISTS `fail_model_policy_audit`");
  await client.query("DROP TABLE IF EXISTS `ai_gateway_audit_event`");
  await client.query("DROP TABLE IF EXISTS `platform_model_policy`");
  await client.query(`
    CREATE TABLE platform_model_policy (
      id varchar(32) NOT NULL PRIMARY KEY,
      enabled_models_json text NOT NULL,
      active_provider varchar(64) NOT NULL,
      active_model varchar(128) NOT NULL,
      created_at timestamp(3) NOT NULL,
      updated_at timestamp(3) NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE ai_gateway_audit_event (
      id varchar(64) NOT NULL PRIMARY KEY,
      actor_user_id varchar(64),
      entity_type varchar(64) NOT NULL,
      entity_id varchar(64) NOT NULL,
      action varchar(64) NOT NULL,
      result varchar(32) NOT NULL,
      summary text,
      created_at timestamp(3) NOT NULL
    )
  `);
}

function parseActiveEdge(summary: string) {
  const match = summary.match(/active ([^ ]+) -> ([^;]+);/);
  assert.ok(match, `audit summary must contain an active edge: ${summary}`);
  return { before: match[1]!, after: match[2]! };
}

function assertDedicatedTestDatabase(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (parsed.protocol !== "mysql:" || !/^veslo_model_policy_test(?:_[a-z0-9_]+)?$/.test(databaseName)) {
    throw new Error(
      "AI_GATEWAY_MODEL_POLICY_TEST_DATABASE_URL must use mysql:// and a dedicated veslo_model_policy_test database",
    );
  }
}
