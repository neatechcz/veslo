import type {
  AdminCredentialRecord,
  CreatePlatformCredentialInput,
  CreateUserCredentialInput,
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
  ListUserCredentialsInput,
  MarkCredentialStateInput,
  RevokeUserCredentialInput,
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
  async createUserCredential(_input: CreateUserCredentialInput): Promise<CredentialRecord> {
    return {
      id: "cred_1",
      name: null,
      ownerUserId: "user_1",
      provider: "openai",
      credentialType: "oauth",
      state: "healthy",
      secretRef: "secret_1",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastFailureAt: null,
    };
  },
  async createPlatformCredential(_input: CreatePlatformCredentialInput): Promise<CredentialRecord> {
    return {
      id: "cred_platform_1",
      name: "Shared OpenAI key",
      ownerUserId: "platform:openai",
      provider: "openai",
      credentialType: "api_key",
      state: "healthy",
      secretRef: "secret_platform_1",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastFailureAt: null,
    };
  },
  async listUserCredentials(_input: ListUserCredentialsInput): Promise<CredentialRecord[]> {
    return [];
  },
  async revokeUserCredential(_input: RevokeUserCredentialInput): Promise<CredentialRecord | null> {
    return null;
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
      credentialUsage: [],
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
