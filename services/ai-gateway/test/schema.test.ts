import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getTableColumns } from "drizzle-orm";

import {
  CoreTableNames,
  auditEventTable,
  credentialBindingTable,
  credentialHealthEventTable,
  credentialRecordTable,
  credentialSecretTable,
  credentialUsageEventTable,
  platformModelPolicyTable,
  sessionLeaseTable,
  userAiAccessPolicyTable,
} from "../src/db/schema.js";
import { createDb } from "../src/db/index.js";

test("exports required core table names", () => {
  const requiredCoreNames = {
    credential_record: "credential_record",
    credential_secret: "credential_secret",
    credential_binding: "credential_binding",
    session_lease: "session_lease",
    credential_health_event: "credential_health_event",
    credential_usage_event: "credential_usage_event",
    audit_event: "ai_gateway_audit_event",
    user_ai_access_policy: "user_ai_access_policy",
    platform_model_policy: "platform_model_policy",
  } as const;

  for (const [key, value] of Object.entries(requiredCoreNames)) {
    assert.equal(CoreTableNames[key as keyof typeof requiredCoreNames], value);
  }
});

test("exports required table definitions", () => {
  assert.ok(credentialRecordTable);
  assert.ok(credentialSecretTable);
  assert.ok(credentialBindingTable);
  assert.ok(sessionLeaseTable);
  assert.ok(credentialHealthEventTable);
  assert.ok(credentialUsageEventTable);
  assert.ok(auditEventTable);
  assert.ok(userAiAccessPolicyTable);
  assert.ok(platformModelPolicyTable);
});

test("gateway tables include BYOK ownership and provider scoped lease columns", () => {
  const credentialRecordColumns = getTableColumns(credentialRecordTable);
  const credentialBindingColumns = getTableColumns(credentialBindingTable);
  const sessionLeaseColumns = getTableColumns(sessionLeaseTable);
  const userAiAccessPolicyColumns = getTableColumns(userAiAccessPolicyTable);

  assert.ok(credentialRecordColumns.name);
  assert.ok(credentialRecordColumns.owner_user_id);
  assert.ok(credentialBindingColumns.owner_user_id);
  assert.ok(credentialBindingColumns.provider);
  assert.ok(sessionLeaseColumns.owner_user_id);
  assert.ok(sessionLeaseColumns.provider);
  assert.ok(userAiAccessPolicyColumns.user_id);
  assert.ok(userAiAccessPolicyColumns.enabled);
  assert.ok(userAiAccessPolicyColumns.provider);
  assert.ok(userAiAccessPolicyColumns.default_model);
  assert.ok(userAiAccessPolicyColumns.allowed_models_json);
});

test("platform model policy schema stores one active model and the enabled model set", () => {
  const columns = getTableColumns(platformModelPolicyTable);

  assert.ok(columns.id);
  assert.ok(columns.enabled_models_json);
  assert.ok(columns.active_provider);
  assert.ok(columns.active_model);
  assert.ok(columns.created_at);
  assert.ok(columns.updated_at);
});

test("audit schema stores nullable organization scope", () => {
  const columns = getTableColumns(auditEventTable);
  assert.ok(columns.organization_id);
  assert.equal(columns.organization_id.notNull, false);
});

test("exports db factory", () => {
  assert.equal(typeof createDb, "function");
});

test("repository modules exist at expected paths", async () => {
  await assert.doesNotReject(async () => import("../src/credentials/repository.js"));
  await assert.doesNotReject(async () => import("../src/leases/repository.js"));
  await assert.doesNotReject(async () => import("../src/access/repository.js"));
  await assert.doesNotReject(async () => import("../src/access/mysql-repository.js"));
  await assert.doesNotReject(async () => import("../src/model-policy/repository.js"));
  await assert.doesNotReject(async () => import("../src/model-policy/mysql-repository.js"));
});

test("platform model policy migration creates the singleton persistence shape", async () => {
  const migration = await readFile(new URL("../drizzle/0003_platform_model_policy.sql", import.meta.url), "utf8");
  const journal = JSON.parse(
    await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: Array<{ tag: string }> };

  assert.match(migration, /CREATE TABLE IF NOT EXISTS `platform_model_policy`/);
  assert.match(migration, /`id` varchar\(32\) NOT NULL PRIMARY KEY/);
  assert.match(migration, /`enabled_models_json` text NOT NULL/);
  assert.match(migration, /`active_provider` varchar\(64\) NOT NULL/);
  assert.match(migration, /`active_model` varchar\(128\) NOT NULL/);
  assert.match(migration, /`created_at` timestamp\(3\) NOT NULL/);
  assert.match(migration, /`updated_at` timestamp\(3\) NOT NULL/);
  assert.ok(journal.entries.some((entry) => entry.tag === "0003_platform_model_policy"));
});

test("exports drizzle config for ai-gateway migrations", async () => {
  const module = await import("../drizzle.config.ts");

  assert.equal(module.default.dialect, "mysql");
  assert.equal(module.default.schema, "./src/db/schema.ts");
  assert.equal(module.default.out, "./drizzle");
});
