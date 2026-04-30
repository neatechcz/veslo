export type RecordUsageInput = {
  requestId: string;
  ownerUserId: string;
  orgId?: string | null;
  provider: string;
  sessionId: string;
  credentialId: string;
  bindingId: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
};

export type UsageGroupBy = "total" | "credential" | "user" | "org";

export type AggregateUsageInput = {
  groupBy: UsageGroupBy;
  credentialId: string | null;
  userId: string | null;
  orgId: string | null;
};

export type UsageAggregateSummary = {
  totalTokens: number;
  totalRequests: number;
};

export type UsageAggregateLabel = {
  id: string;
  label: string;
};

export type UsageAggregateSeries = {
  key: string;
  label: string;
  totalTokens: number;
  totalRequests: number;
};

export type UsageCredentialAggregate = UsageAggregateLabel & {
  totalTokens: number;
  totalRequests: number;
  lastUsedAt: string | null;
};

export type UsageAggregateResponse = {
  summary: UsageAggregateSummary;
  groupBy: UsageGroupBy;
  filters: {
    credentials: UsageAggregateLabel[];
    users: UsageAggregateLabel[];
    orgs: UsageAggregateLabel[];
  };
  series: UsageAggregateSeries[];
  topCredentials: Array<UsageAggregateLabel & { totalTokens: number }>;
  topUsers: Array<UsageAggregateLabel & { totalTokens: number }>;
  topOrgs: Array<UsageAggregateLabel & { totalTokens: number }>;
  credentialUsage: UsageCredentialAggregate[];
};

export interface UsageRepository {
  recordUsage(input: RecordUsageInput): Promise<void>;
  aggregateUsage?(input: AggregateUsageInput): Promise<UsageAggregateResponse>;
}
