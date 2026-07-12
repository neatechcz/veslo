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
