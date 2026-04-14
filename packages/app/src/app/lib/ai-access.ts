import type { ModelRef } from "../types";
import type { VesloGatewayProvider, VesloUserAiAccess } from "./veslo-server";
import { formatConfigWithDefaultModel } from "./model-persistence";
import { applyGatewayProviderRouting } from "./opencode";
import { isGatewayOwnedProvider } from "../utils/providers";

export const AI_ACCESS_ADMIN_MANAGED_MESSAGE =
  "Provider and model selection are managed by your platform admin.";
export const AI_ACCESS_LOADING_MESSAGE = "Loading your AI access configuration.";
export const AI_ACCESS_NOT_CONFIGURED_MESSAGE =
  "Your AI access has not been configured by the platform admin yet.";
export const AI_ACCESS_INVALID_MESSAGE =
  "Assigned AI access is incomplete. Ask your platform admin to update it.";

export type ManagedAiAccessProfile = {
  userId: string;
  providerId: VesloGatewayProvider;
  defaultModel: ModelRef;
  allowedModels: string[];
  updatedAt: string | null;
};

export function resolveManagedAiAccess(record: VesloUserAiAccess | null | undefined): {
  profile: ManagedAiAccessProfile | null;
  reason: string | null;
} {
  if (!record || record.enabled !== true) {
    return { profile: null, reason: AI_ACCESS_NOT_CONFIGURED_MESSAGE };
  }

  const userId = record.userId?.trim() ?? "";
  const provider = record.provider?.trim().toLowerCase() ?? "";
  const defaultModelId = record.defaultModel?.trim() ?? "";
  if (!userId || !isGatewayOwnedProvider(provider) || !defaultModelId) {
    return { profile: null, reason: AI_ACCESS_INVALID_MESSAGE };
  }

  const allowedModels = Array.isArray(record.allowedModels)
    ? record.allowedModels
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  if (allowedModels.length > 0 && !allowedModels.includes(defaultModelId)) {
    return { profile: null, reason: AI_ACCESS_INVALID_MESSAGE };
  }

  return {
    profile: {
      userId,
      providerId: provider,
      defaultModel: {
        providerID: provider,
        modelID: defaultModelId,
      },
      allowedModels,
      updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim()
        ? record.updatedAt
        : null,
    },
    reason: null,
  };
}

export function formatManagedAiAccessConfig(
  content: string | null | undefined,
  input: {
    profile: ManagedAiAccessProfile;
    serverBaseUrl: string;
    gatewayAccessToken: string;
  },
): string {
  const withDefaultModel = formatConfigWithDefaultModel(content ?? "", input.profile.defaultModel);
  return `${applyGatewayProviderRouting(withDefaultModel, {
    providerId: input.profile.providerId,
    serverBaseUrl: input.serverBaseUrl,
    gatewayAccessToken: input.gatewayAccessToken,
    models: [input.profile.defaultModel.modelID, ...input.profile.allowedModels],
  })}\n`;
}
