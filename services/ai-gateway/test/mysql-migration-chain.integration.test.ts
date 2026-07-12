import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import mysql from "mysql2/promise";

type MigrationJournal = {
  entries: Array<{ tag: string }>;
};

const testDatabaseUrl = process.env.AI_GATEWAY_MIGRATION_TEST_DATABASE_URL?.trim();

test(
  "real MySQL fresh and reconciled upgrade chains preserve audit history",
  { skip: testDatabaseUrl ? false : "AI_GATEWAY_MIGRATION_TEST_DATABASE_URL is not configured" },
  async (context) => {
    assert.ok(testDatabaseUrl);
    assertDedicatedTestDatabase(testDatabaseUrl);
    const connection = await mysql.createConnection(testDatabaseUrl);
    context.after(async () => {
      await resetDatabase(connection);
      await connection.end();
    });

    await resetDatabase(connection);
    const journal = JSON.parse(
      await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
    ) as MigrationJournal;
    for (const entry of journal.entries) {
      await executeMigration(connection, entry.tag);
    }

    const [freshColumns] = await connection.query(
      "SHOW COLUMNS FROM `ai_gateway_audit_event` LIKE 'organization_id'",
    ) as unknown as [Array<{ Null: string }>, unknown];
    const [freshIndexes] = await connection.query(
      "SHOW INDEX FROM `ai_gateway_audit_event` WHERE `Key_name` <> 'PRIMARY'",
    ) as unknown as [Array<{ Key_name: string }>, unknown];
    assert.equal(freshColumns[0]?.Null, "YES");
    assert.deepEqual(
      new Set(freshIndexes.map((index) => index.Key_name)),
      new Set([
        "audit_event_entity",
        "audit_event_actor",
        "audit_event_action",
        "audit_event_organization_created",
      ]),
    );

    await resetDatabase(connection);
    await connection.query(`
      CREATE TABLE \`user_ai_access_policy\` (
        \`id\` varchar(64) NOT NULL PRIMARY KEY,
        \`user_id\` varchar(64) NOT NULL,
        \`enabled\` int NOT NULL DEFAULT 1,
        \`provider\` varchar(64),
        \`credential_id\` varchar(64),
        \`default_model\` varchar(128),
        \`allowed_models_json\` text NOT NULL,
        \`assignment_origin\` varchar(32) NOT NULL DEFAULT 'admin_assigned',
        \`created_at\` timestamp(3) NOT NULL,
        \`updated_at\` timestamp(3) NOT NULL
      )
    `);
    await connection.query(`
      INSERT INTO \`user_ai_access_policy\`
        (\`id\`, \`user_id\`, \`allowed_models_json\`, \`assignment_origin\`, \`created_at\`, \`updated_at\`)
      VALUES
        ('access_1', 'user_1', '[]', 'auto_assigned', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
    `);
    await executeMigration(connection, "0002_user_ai_access_assignment_origin");
    const [accessRows] = await connection.query(
      "SELECT `id`, `assignment_origin` FROM `user_ai_access_policy`",
    );
    assert.deepEqual(accessRows, [{ id: "access_1", assignment_origin: "auto_assigned" }]);

    await connection.query(`
      CREATE TABLE \`audit_event\` (
        \`id\` varchar(64) NOT NULL PRIMARY KEY,
        \`actor_user_id\` varchar(64),
        \`entity_type\` varchar(64) NOT NULL,
        \`entity_id\` varchar(64) NOT NULL,
        \`action\` varchar(64) NOT NULL,
        \`result\` varchar(32) NOT NULL,
        \`summary\` text,
        \`created_at\` timestamp(3) NOT NULL
      )
    `);
    await connection.query(`
      INSERT INTO \`audit_event\`
        (\`id\`, \`entity_type\`, \`entity_id\`, \`action\`, \`result\`, \`summary\`, \`created_at\`)
      VALUES
        ('legacy_1', 'credential', 'cred_legacy', 'credential.create', 'ok', 'legacy row', CURRENT_TIMESTAMP(3)),
        ('shared_1', 'credential', 'cred_shared', 'credential.create', 'ok', 'legacy collision', CURRENT_TIMESTAMP(3))
    `);
    await connection.query(`
      CREATE TABLE \`ai_gateway_audit_event\` (
        \`id\` varchar(64) NOT NULL PRIMARY KEY,
        \`actor_user_id\` varchar(64),
        \`entity_type\` varchar(64) NOT NULL,
        \`entity_id\` varchar(64) NOT NULL,
        \`action\` varchar(64) NOT NULL,
        \`result\` varchar(32) NOT NULL,
        \`summary\` text,
        \`created_at\` timestamp(3) NOT NULL
      )
    `);
    await connection.query(`
      INSERT INTO \`ai_gateway_audit_event\`
        (\`id\`, \`entity_type\`, \`entity_id\`, \`action\`, \`result\`, \`summary\`, \`created_at\`)
      VALUES
        ('current_1', 'credential', 'cred_1', 'credential.create', 'ok', 'current row', CURRENT_TIMESTAMP(3)),
        ('shared_1', 'credential', 'cred_shared', 'credential.create', 'ok', 'current collision', CURRENT_TIMESTAMP(3))
    `);

    await executeMigration(connection, "0004_organization_audit_scope");

    const [legacyRows] = await connection.query("SELECT `id`, `summary` FROM `audit_event`");
    const [currentRows] = await connection.query(
      "SELECT `id`, `summary`, `organization_id` FROM `ai_gateway_audit_event` ORDER BY `id`",
    );
    const [upgradeIndexes] = await connection.query(
      "SHOW INDEX FROM `ai_gateway_audit_event` WHERE `Key_name` = 'audit_event_organization_created'",
    ) as unknown as [unknown[], unknown];
    assert.deepEqual(legacyRows, [
      { id: "legacy_1", summary: "legacy row" },
      { id: "shared_1", summary: "legacy collision" },
    ]);
    assert.deepEqual(currentRows, [
      { id: "current_1", summary: "current row", organization_id: null },
      { id: "legacy_1", summary: "legacy row", organization_id: null },
      { id: "shared_1", summary: "current collision", organization_id: null },
    ]);
    assert.equal(upgradeIndexes.length, 2);

    await executeMigration(connection, "0004_organization_audit_scope");
    const [rerunRows] = await connection.query(
      "SELECT `id`, `summary`, `organization_id` FROM `ai_gateway_audit_event` ORDER BY `id`",
    );
    const [rerunIndexes] = await connection.query(
      "SHOW INDEX FROM `ai_gateway_audit_event` WHERE `Key_name` = 'audit_event_organization_created'",
    ) as unknown as [unknown[], unknown];
    assert.deepEqual(rerunRows, currentRows);
    assert.equal(rerunIndexes.length, 2);
  },
);

async function executeMigration(connection: mysql.Connection, tag: string) {
  const sql = await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    await connection.query(statement);
  }
}

async function resetDatabase(connection: mysql.Connection) {
  const [rows] = await connection.query("SHOW TABLES") as unknown as [Array<Record<string, string>>, unknown];
  await connection.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const row of rows) {
      const tableName = Object.values(row)[0];
      assert.match(tableName, /^[a-zA-Z0-9_]+$/);
      await connection.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  }
}

function assertDedicatedTestDatabase(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (parsed.protocol !== "mysql:" || !/^veslo_migration_chain_test(?:_[a-z0-9_]+)?$/.test(databaseName)) {
    throw new Error(
      "AI_GATEWAY_MIGRATION_TEST_DATABASE_URL must use mysql:// and a dedicated veslo_migration_chain_test database",
    );
  }
}
