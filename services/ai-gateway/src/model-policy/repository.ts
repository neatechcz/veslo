import type { AiGatewayProvider } from "../providers/ids.js";

export type PlatformModelRef = {
  provider: AiGatewayProvider;
  model: string;
};

export type PlatformModelPolicyRecord = {
  id: "platform";
  enabledModels: PlatformModelRef[];
  activeModel: PlatformModelRef;
  createdAt: Date;
  updatedAt: Date;
};

export interface PlatformModelPolicyRepository {
  getPolicy(): Promise<PlatformModelPolicyRecord | null>;
  replacePolicy(input: {
    enabledModels: PlatformModelRef[];
    activeModel: PlatformModelRef;
  }): Promise<PlatformModelPolicyRecord>;
}

export type ReplacePlatformModelPolicyWithAuditInput = {
  actorUserId: string;
  enabledModels: PlatformModelRef[];
  activeModel: PlatformModelRef;
};

export interface PlatformModelPolicyMutation {
  replacePolicyWithAudit(
    input: ReplacePlatformModelPolicyWithAuditInput,
  ): Promise<PlatformModelPolicyRecord>;
}
