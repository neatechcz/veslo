import { AI_GATEWAY_PROVIDERS, type AiGatewayProvider } from "../providers/ids.js";

export const AiAccessProviders = AI_GATEWAY_PROVIDERS;

export type AiAccessProvider = AiGatewayProvider;

export type UserAiAccessPolicyRecord = {
  id: string;
  userId: string;
  enabled: boolean;
  provider: AiAccessProvider | null;
  credentialId: string | null;
  defaultModel: string | null;
  allowedModels: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertUserAiAccessPolicyInput = {
  userId: string;
  enabled: boolean;
  provider: AiAccessProvider | null;
  credentialId: string | null;
  defaultModel: string | null;
  allowedModels: string[];
};

export interface AiAccessRepository {
  getUserAiAccess(userId: string): Promise<UserAiAccessPolicyRecord | null>;
  upsertUserAiAccess(input: UpsertUserAiAccessPolicyInput): Promise<UserAiAccessPolicyRecord>;
}
