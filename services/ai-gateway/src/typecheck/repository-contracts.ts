import type { CredentialRepository } from "../credentials/repository.js";
import type { LeaseRepository } from "../leases/repository.js";

// Build-time type checks for repository contracts.
// This is intentionally not a runtime test because `tsx --test` does not type-check.
const credentialRepositoryContractCheck: CredentialRepository = {
  async getCredentialRecordById() {
    return null;
  },
  async listHealthyCredentialRecordIds() {
    return [];
  },
  async markCredentialState() {
    return;
  },
};

const leaseRepositoryContractCheck: LeaseRepository = {
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
};

void credentialRepositoryContractCheck;
void leaseRepositoryContractCheck;
