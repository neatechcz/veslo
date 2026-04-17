import assert from "node:assert/strict";
import test from "node:test";

import { ensureAiGatewaySchema } from "../src/db/schema-reconcile.js";

test("ensureAiGatewaySchema repairs managed AI tables and columns for live databases", async () => {
  const statements: string[] = [];
  const db = {
    async query(statement: string) {
      statements.push(statement);
      return [[], []];
    },
  };

  await ensureAiGatewaySchema(db);

  const sql = statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `user_ai_access_policy`/);
  assert.match(sql, /`id` varchar\(64\) NOT NULL PRIMARY KEY/);
  assert.match(sql, /`created_at` timestamp\(3\) NOT NULL,/);
  assert.match(sql, /`updated_at` timestamp\(3\) NOT NULL,/);
  assert.match(sql, /`credential_id` varchar\(64\),/);
  assert.match(sql, /UNIQUE KEY `user_ai_access_policy_user_id` \(`user_id`\)/);
  assert.doesNotMatch(sql, /DEFAULT CURRENT_TIMESTAMP/);
  assert.doesNotMatch(sql, /CONSTRAINT `user_ai_access_policy_id`/);
  assert.match(sql, /CREATE INDEX `user_ai_access_policy_provider` ON `user_ai_access_policy` \(`provider`\)/);
  assert.match(sql, /ALTER TABLE `user_ai_access_policy` ADD COLUMN `credential_id` varchar\(64\)/);
  assert.match(sql, /ALTER TABLE `credential_record` ADD COLUMN `name` varchar\(255\)/);
});

test("ensureAiGatewaySchema creates credential tables before repairing columns", async () => {
  const statements: string[] = [];
  const db = {
    async query(statement: string) {
      statements.push(statement);
      return [[], []];
    },
  };

  await ensureAiGatewaySchema(db);

  const createCredentialRecordIndex = statements.findIndex((statement) =>
    /CREATE TABLE IF NOT EXISTS `credential_record`/.test(statement),
  );
  const alterCredentialRecordIndex = statements.findIndex((statement) =>
    /ALTER TABLE `credential_record` ADD COLUMN `name`/.test(statement),
  );

  assert.notEqual(createCredentialRecordIndex, -1);
  assert.notEqual(alterCredentialRecordIndex, -1);
  assert.ok(
    createCredentialRecordIndex < alterCredentialRecordIndex,
    "credential_record must exist before schema reconciliation alters its columns",
  );
});

test("ensureAiGatewaySchema treats mysql2 [rows, fields] metadata as existing rows", async () => {
  const statements: string[] = [];
  const db = {
    async query(statement: string) {
      statements.push(statement);
      if (/INFORMATION_SCHEMA/.test(statement)) {
        return [[{ found: 1 }], []];
      }
      return [[], []];
    },
  };

  await ensureAiGatewaySchema(db);

  const sql = statements.join("\n");
  assert.doesNotMatch(sql, /CREATE INDEX `user_ai_access_policy_provider`/);
  assert.doesNotMatch(sql, /ALTER TABLE `credential_record` ADD COLUMN `name`/);
  assert.doesNotMatch(sql, /ALTER TABLE `user_ai_access_policy` ADD COLUMN `credential_id`/);
});
