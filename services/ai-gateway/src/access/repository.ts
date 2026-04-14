import type { AiGatewayProvider } from "../providers/ids.js";

export const AiAccessProviders = ["openai", "anthropic", "codex_oauth"] as const;

export type AiAccessProvider = AiGatewayProvider;

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
