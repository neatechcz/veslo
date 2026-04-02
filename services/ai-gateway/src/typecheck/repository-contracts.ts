import type {
  AdminCredentialRecord,
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
  MarkCredentialStateInput,
} from "../credentials/repository.js";
import type { AuditEventRecord, AuditRepository, ListAuditEventsInput, RecordAuditEventInput } from "../audit/repository.js";
import type {
  AdminSessionRecord,
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../leases/repository.js";
import type {
  AggregateUsageInput,
  RecordUsageInput,
  UsageAggregateResponse,
  UsageRepository,
} from "../usage/repository.js";

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
  async listAdminCredentials(): Promise<AdminCredentialRecord[]> {
    return [];
  },
  async markCredentialState(_input: MarkCredentialStateInput) {
    return;
  },
};

const leaseRepositoryContractCheck: LeaseRepository = {
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
  async listAdminSessions(): Promise<AdminSessionRecord[]> {
    return [];
  },
};

const usageRepositoryContractCheck: UsageRepository = {
  async recordUsage(_input: RecordUsageInput) {
    return;
  },
  async aggregateUsage(_input: AggregateUsageInput): Promise<UsageAggregateResponse> {
    return {
      summary: { totalTokens: 0, totalRequests: 0 },
      groupBy: "total",
      filters: { credentials: [], users: [], orgs: [] },
      series: [],
      topCredentials: [],
      topUsers: [],
      topOrgs: [],
    };
  },
};

const auditRepositoryContractCheck: AuditRepository = {
  async recordEvent(_input: RecordAuditEventInput) {
    return;
  },
  async listEvents(_input: ListAuditEventsInput): Promise<AuditEventRecord[]> {
    return [];
  },
};

void credentialRepositoryContractCheck;
void leaseRepositoryContractCheck;
void usageRepositoryContractCheck;
void auditRepositoryContractCheck;
