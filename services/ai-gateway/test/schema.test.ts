import assert from "node:assert/strict";
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
  sessionLeaseTable,
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
    audit_event: "audit_event",
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
});

test("gateway tables include BYOK ownership and provider scoped lease columns", () => {
  const credentialRecordColumns = getTableColumns(credentialRecordTable);
  const credentialBindingColumns = getTableColumns(credentialBindingTable);
  const sessionLeaseColumns = getTableColumns(sessionLeaseTable);

  assert.ok(credentialRecordColumns.owner_user_id);
  assert.ok(credentialBindingColumns.owner_user_id);
  assert.ok(credentialBindingColumns.provider);
  assert.ok(sessionLeaseColumns.owner_user_id);
  assert.ok(sessionLeaseColumns.provider);
});

test("exports db factory", () => {
  assert.equal(typeof createDb, "function");
});

test("repository modules exist at expected paths", async () => {
  await assert.doesNotReject(async () => import("../src/credentials/repository.js"));
  await assert.doesNotReject(async () => import("../src/leases/repository.js"));
});

test("exports drizzle config for ai-gateway migrations", async () => {
  const module = await import("../drizzle.config.ts");

  assert.equal(module.default.dialect, "mysql");
  assert.equal(module.default.schema, "./src/db/schema.ts");
  assert.equal(module.default.out, "./drizzle");
});
