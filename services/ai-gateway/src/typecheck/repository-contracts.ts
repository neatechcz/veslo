import type {
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
  MarkCredentialStateInput,
} from "../credentials/repository.js";
import type { AuditRepository, RecordAuditEventInput } from "../audit/repository.js";
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../leases/repository.js";
import type { RecordUsageInput, UsageRepository } from "../usage/repository.js";

// Build-time type checks for repository contracts.
// This is intentionally not a runtime test because `tsx --test` does not type-check.
const credentialRepositoryContractCheck: CredentialRepository = {
  async getCredentialRecordById(): Promise<CredentialRecord | null> {
    return null;
  },
  async listHealthyCredentialRecordIds() {
    return [];
  },
  async listEligibleBindings(_input: ListEligibleBindingsInput): Promise<CredentialBinding[]> {
    return [];
  },
  async getCredentialRecordByBindingId(_bindingId: string): Promise<CredentialRecord | null> {
    return null;
  },
  async markCredentialState(_input: MarkCredentialStateInput) {
    return;
  },
};

const leaseRepositoryContractCheck: LeaseRepository = {
  async getActiveLeaseBySessionId(): Promise<SessionLease | null> {
    return null;
  },
  async createSessionLeaseIfMissing(_input: CreateSessionLeaseInput): Promise<SessionLease> {
    return {
      id: "lease_legacy_1",
      sessionId: "session_legacy_1",
      activeBindingId: "binding_legacy_1",
    };
  },
  async rebindSessionLease(_input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    return {
      id: "lease_legacy_1",
      sessionId: "session_legacy_1",
      activeBindingId: "binding_legacy_2",
    };
  },
  async getActiveLease(_input: ResolveLeaseInput): Promise<SessionLease | null> {
    return null;
  },
  async createLeaseIfMissing(_input: CreateSessionLeaseInput): Promise<SessionLease> {
    return {
      id: "lease_1",
      ownerUserId: "user_1",
      provider: "openai",
      sessionId: "session_1",
      activeBindingId: "binding_1",
    };
  },
  async rebindLease(_input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    return {
      id: "lease_1",
      ownerUserId: "user_1",
      provider: "openai",
      sessionId: "session_1",
      activeBindingId: "binding_2",
    };
  },
};

const usageRepositoryContractCheck: UsageRepository = {
  async recordUsage(_input: RecordUsageInput) {
    return;
  },
};

const auditRepositoryContractCheck: AuditRepository = {
  async recordEvent(_input: RecordAuditEventInput) {
    return;
  },
};

void credentialRepositoryContractCheck;
void leaseRepositoryContractCheck;
void usageRepositoryContractCheck;
void auditRepositoryContractCheck;
