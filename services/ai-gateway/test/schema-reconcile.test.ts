import assert from "node:assert/strict";
import test from "node:test";

import { ensureAiGatewaySchema } from "../src/db/schema-reconcile.js";

function flattenSql(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const stringChunk = value as { value?: unknown };
  if (Array.isArray(stringChunk.value)) {
    return stringChunk.value.map(flattenSql).join("");
  }

  const sqlChunk = value as { queryChunks?: unknown[] };
  if (Array.isArray(sqlChunk.queryChunks)) {
    return sqlChunk.queryChunks.map(flattenSql).join("");
  }

  return "";
}

test("ensureAiGatewaySchema repairs managed AI tables and columns for live databases", async () => {
  const statements: string[] = [];
  const db = {
    async execute(query: unknown) {
      statements.push(flattenSql(query));
      return [];
    },
  };

  await ensureAiGatewaySchema(db);

  const sql = statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `user_ai_access_policy`/);
  assert.match(sql, /`id` varchar\(64\) NOT NULL PRIMARY KEY/);
  assert.match(sql, /`created_at` timestamp\(3\) NOT NULL,/);
  assert.match(sql, /`updated_at` timestamp\(3\) NOT NULL,/);
  assert.match(sql, /UNIQUE KEY `user_ai_access_policy_user_id` \(`user_id`\)/);
  assert.doesNotMatch(sql, /DEFAULT CURRENT_TIMESTAMP/);
  assert.doesNotMatch(sql, /CONSTRAINT `user_ai_access_policy_id`/);
  assert.match(sql, /CREATE INDEX `user_ai_access_policy_provider` ON `user_ai_access_policy` \(`provider`\)/);
  assert.match(sql, /ALTER TABLE `credential_record` ADD COLUMN `name` varchar\(255\)/);
});

test("ensureAiGatewaySchema treats mysql2 [rows, fields] metadata as existing rows", async () => {
  const statements: string[] = [];
  const db = {
    async execute(query: unknown) {
      const statement = flattenSql(query);
      statements.push(statement);
      if (/INFORMATION_SCHEMA/.test(statement)) {
        return [[{ found: 1 }], []];
      }
      return [];
    },
  };

  await ensureAiGatewaySchema(db);

  const sql = statements.join("\n");
  assert.doesNotMatch(sql, /CREATE INDEX `user_ai_access_policy_provider`/);
  assert.doesNotMatch(sql, /ALTER TABLE `credential_record` ADD COLUMN `name`/);
});
