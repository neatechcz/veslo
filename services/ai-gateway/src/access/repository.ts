export const AiAccessProviders = ["openai", "anthropic"] as const;

export type AiAccessProvider = (typeof AiAccessProviders)[number];

export type UserAiAccessPolicyRecord = {
  id: string;
  userId: string;
  enabled: boolean;
  provider: AiAccessProvider | null;
  defaultModel: string | null;
  allowedModels: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertUserAiAccessPolicyInput = {
  userId: string;
  enabled: boolean;
  provider: AiAccessProvider | null;
  defaultModel: string | null;
  allowedModels: string[];
};

export interface AiAccessRepository {
  getUserAiAccess(userId: string): Promise<UserAiAccessPolicyRecord | null>;
  upsertUserAiAccess(input: UpsertUserAiAccessPolicyInput): Promise<UserAiAccessPolicyRecord>;
}
