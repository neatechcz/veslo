export type RecordUsageInput = {
  requestId: string;
  ownerUserId: string;
  provider: string;
  sessionId: string;
  bindingId: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
};

export interface UsageRepository {
  recordUsage(input: RecordUsageInput): Promise<void>;
}
