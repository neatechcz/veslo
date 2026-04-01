import assert from "node:assert/strict";
import test from "node:test";

import {
  CoreTableNames,
  credentialBindingTable,
  credentialHealthEventTable,
  credentialRecordTable,
  sessionLeaseTable,
} from "../src/db/schema.js";
import { createDb } from "../src/db/index.js";

test("exports required core table names", () => {
  const requiredCoreNames = {
    credential_record: "credential_record",
    credential_binding: "credential_binding",
    session_lease: "session_lease",
    credential_health_event: "credential_health_event",
  } as const;

  for (const [key, value] of Object.entries(requiredCoreNames)) {
    assert.equal(CoreTableNames[key as keyof typeof requiredCoreNames], value);
  }
});

test("exports required table definitions", () => {
  assert.ok(credentialRecordTable);
  assert.ok(credentialBindingTable);
  assert.ok(sessionLeaseTable);
  assert.ok(credentialHealthEventTable);
});

test("exports db factory", () => {
  assert.equal(typeof createDb, "function");
});

test("repository modules exist at expected paths", async () => {
  await assert.doesNotReject(async () => import("../src/credentials/repository.js"));
  await assert.doesNotReject(async () => import("../src/leases/repository.js"));
});
