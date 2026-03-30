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
import type { CredentialRepository } from "../src/credentials/repository.js";
import type { LeaseRepository } from "../src/leases/repository.js";

function assertCredentialRepositoryContract(repo: CredentialRepository): CredentialRepository {
  return repo;
}

function assertLeaseRepositoryContract(repo: LeaseRepository): LeaseRepository {
  return repo;
}

test("exports required core table names", () => {
  assert.deepEqual(CoreTableNames, {
    credential_record: "credential_record",
    credential_binding: "credential_binding",
    session_lease: "session_lease",
    credential_health_event: "credential_health_event",
  });
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

test("repository interfaces accept small transport-agnostic contracts", async () => {
  const credentialRepo = assertCredentialRepositoryContract({
    async getCredentialRecordById() {
      return null;
    },
    async listHealthyCredentialRecordIds() {
      return [];
    },
    async markCredentialState() {
      return;
    },
  });

  const leaseRepo = assertLeaseRepositoryContract({
    async getActiveLeaseBySessionId() {
      return null;
    },
    async createSessionLease() {
      return {
        id: "lease_1",
        sessionId: "session_1",
        activeBindingId: "binding_1",
      };
    },
    async rebindSessionLease() {
      return {
        id: "lease_1",
        sessionId: "session_1",
        activeBindingId: "binding_2",
      };
    },
  });

  assert.equal(typeof credentialRepo.getCredentialRecordById, "function");
  assert.equal(typeof leaseRepo.getActiveLeaseBySessionId, "function");
});
