import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string }>;
};

const expectedTags = [
  "0000_past_randall_flagg",
  "0001_vslo_133_usage_accounting",
  "0002_user_ai_access_assignment_origin",
  "0003_platform_model_policy",
  "0004_organization_audit_scope",
];

test("migration journal executes the complete 0000 through 0004 chain in order", async () => {
  const journal = await readJournal();

  assert.deepEqual(
    journal.entries.map(({ idx, tag }) => ({ idx, tag })),
    expectedTags.map((tag, idx) => ({ idx, tag })),
  );
});

test("assignment-origin migration is safe for a table already repaired by reconciliation", async () => {
  const statements = await readMigrationStatements("0002_user_ai_access_assignment_origin");

  assert.equal(statements.length, 4);
  assert.match(statements[0]!, /^SET @add_assignment_origin_sql/);
  assert.match(statements[0]!, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(statements[0]!, /ALTER TABLE `user_ai_access_policy` ADD COLUMN `assignment_origin`/);
  assert.match(statements[1]!, /^PREPARE add_assignment_origin/);
  assert.match(statements[2]!, /^EXECUTE add_assignment_origin/);
  assert.match(statements[3]!, /^DEALLOCATE PREPARE add_assignment_origin/);
});

test("organization audit migration splits conditional column and index DDL into executable statements", async () => {
  const statements = await readMigrationStatements("0004_organization_audit_scope");

  assert.equal(statements.length, 13);
  assert.match(statements[0]!, /^CREATE TABLE IF NOT EXISTS `ai_gateway_audit_event`/);
  assert.match(statements[0]!, /(?:KEY|INDEX) `audit_event_entity` \(`entity_type`, ?`entity_id`\)/);
  assert.match(statements[0]!, /(?:KEY|INDEX) `audit_event_actor` \(`actor_user_id`\)/);
  assert.match(statements[0]!, /(?:KEY|INDEX) `audit_event_action` \(`action`\)/);
  assert.match(statements[1]!, /^SET @backfill_legacy_audit_events_sql/);
  assert.match(statements[1]!, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(statements[1]!, /COLUMN_NAME IN/);
  assert.match(statements[1]!, /'entity_type'/);
  assert.match(statements[1]!, /'result'/);
  assert.match(statements[1]!, /INSERT IGNORE INTO `ai_gateway_audit_event`/);
  assert.match(statements[1]!, /FROM `audit_event`/);
  assert.match(statements[2]!, /^PREPARE backfill_legacy_audit_events/);
  assert.match(statements[3]!, /^EXECUTE backfill_legacy_audit_events/);
  assert.match(statements[4]!, /^DEALLOCATE PREPARE backfill_legacy_audit_events/);
  assert.match(statements[5]!, /^SET @add_audit_organization_column_sql/);
  assert.match(statements[5]!, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(statements[5]!, /ALTER TABLE `ai_gateway_audit_event` ADD COLUMN `organization_id` varchar\(64\) NULL/);
  assert.match(statements[6]!, /^PREPARE add_audit_organization_column/);
  assert.match(statements[7]!, /^EXECUTE add_audit_organization_column/);
  assert.match(statements[8]!, /^DEALLOCATE PREPARE add_audit_organization_column/);
  assert.match(statements[9]!, /^SET @create_audit_organization_index_sql/);
  assert.match(statements[9]!, /INFORMATION_SCHEMA\.STATISTICS/);
  assert.match(statements[9]!, /CREATE INDEX `audit_event_organization_created`/);
  assert.match(statements[10]!, /^PREPARE create_audit_organization_index/);
  assert.match(statements[11]!, /^EXECUTE create_audit_organization_index/);
  assert.match(statements[12]!, /^DEALLOCATE PREPARE create_audit_organization_index/);
});

test("fresh migration order creates the current audit table before altering or indexing it", async () => {
  const journal = await readJournal();
  const createdTables = new Set<string>();

  for (const entry of journal.entries) {
    for (const statement of await readMigrationStatements(entry.tag)) {
      const createTable = statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? `([^`]+)`/);
      if (createTable) {
        createdTables.add(createTable[1]!);
      }

      const targetTable = statement.match(/^(?:ALTER TABLE|CREATE INDEX[^]*? ON) `([^`]+)`/);
      if (targetTable) {
        assert.ok(
          createdTables.has(targetTable[1]!),
          `${targetTable[1]} must be created before: ${statement}`,
        );
      }
    }
  }

  assert.ok(createdTables.has("audit_event"), "legacy audit history must remain represented");
  assert.ok(createdTables.has("ai_gateway_audit_event"), "current audit table must be created by the chain");
});

async function readJournal(): Promise<MigrationJournal> {
  return JSON.parse(
    await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as MigrationJournal;
}

async function readMigrationStatements(tag: string): Promise<string[]> {
  const sql = await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}
