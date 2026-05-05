import { AI_GATEWAY_PROVIDERS, type AiGatewayProvider } from "../providers/ids.js";

export const AiAccessProviders = AI_GATEWAY_PROVIDERS;

export type AiAccessProvider = AiGatewayProvider;
export const AiAccessAssignmentOrigins = ["auto_assigned", "admin_assigned"] as const;
export type AiAccessAssignmentOrigin = (typeof AiAccessAssignmentOrigins)[number];

export type UserAiAccessPolicyRecord = {
  id: string;
  userId: string;
  enabled: boolean;
  provider: AiAccessProvider | null;
  credentialId: string | null;
  defaultModel: string | null;
  allowedModels: string[];
  assignmentOrigin: AiAccessAssignmentOrigin;
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
  assignmentOrigin: AiAccessAssignmentOrigin;
};

export interface AiAccessRepository {
  getUserAiAccess(userId: string): Promise<UserAiAccessPolicyRecord | null>;
  upsertUserAiAccess(input: UpsertUserAiAccessPolicyInput): Promise<UserAiAccessPolicyRecord>;
}
