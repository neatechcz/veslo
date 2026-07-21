import type {
  AiAccessAssignmentOrigin,
  AiAccessRepository,
  UpsertUserAiAccessPolicyInput,
  UserAiAccessPolicyRecord,
} from "./repository.js";
import type {
  PlatformModelPolicyRecord,
  PlatformModelPolicyRepository,
  PlatformModelRef,
} from "../model-policy/repository.js";

type AutomaticUserAiAccessModelCapabilities = {
  checkHealthyCredentialForModel(model: PlatformModelRef): Promise<
    | { status: "supported"; credentialId: string }
    | { status: "unsupported" }
    | { status: "transient"; reason: string }
  >;
};

export type AutomaticUserAiAccessService = {
  resolveUserAiAccess(userId: string): Promise<{
    aiAccess: UserAiAccessPolicyRecord;
    platformPolicy: PlatformModelPolicyRecord | null;
  }>;
  getOrCreateUserAiAccess(userId: string): Promise<UserAiAccessPolicyRecord>;
  buildEnabledUpdate(
    userId: string,
    assignmentOrigin: AiAccessAssignmentOrigin,
  ): Promise<UpsertUserAiAccessPolicyInput>;
};

export class AutomaticUserAiAccessInfrastructureError extends Error {
  readonly status = 503;

  constructor(readonly code: "gateway_platform_model_policy_unavailable") {
    super(code);
    this.name = "AutomaticUserAiAccessInfrastructureError";
  }
}

export function createAutomaticUserAiAccessService(deps: {
  aiAccess: AiAccessRepository;
  modelPolicy: PlatformModelPolicyRepository;
  modelCapabilities: AutomaticUserAiAccessModelCapabilities;
}): AutomaticUserAiAccessService {
  const resolutions = new Map<string, Promise<{
    aiAccess: UserAiAccessPolicyRecord;
    platformPolicy: PlatformModelPolicyRecord;
  }>>();

  async function buildEnabledUpdate(
    userId: string,
    assignmentOrigin: AiAccessAssignmentOrigin,
  ): Promise<UpsertUserAiAccessPolicyInput> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new Error("automatic_user_ai_access_user_id_required");
    }

    return (await buildEnabledResolution(normalizedUserId, assignmentOrigin)).update;
  }

  async function buildEnabledResolution(
    userId: string,
    assignmentOrigin: AiAccessAssignmentOrigin,
  ) {
    const platformPolicy = await deps.modelPolicy.getPolicy();
    if (!platformPolicy) {
      throw new AutomaticUserAiAccessInfrastructureError("gateway_platform_model_policy_unavailable");
    }
    const activeModel = {
      provider: platformPolicy.activeModel.provider,
      model: platformPolicy.activeModel.model.trim(),
    };
    const update: UpsertUserAiAccessPolicyInput = {
      userId,
      enabled: true,
      provider: activeModel.provider,
      credentialId: await resolvePinnedCredential(activeModel),
      defaultModel: activeModel.model,
      allowedModels: [activeModel.model],
      assignmentOrigin,
    };
    return { update, platformPolicy };
  }

  async function resolveEnabledUser(
    userId: string,
    existing: UserAiAccessPolicyRecord | null,
  ) {
    const { update, platformPolicy } = await buildEnabledResolution(
      userId,
      existing?.assignmentOrigin ?? "auto_assigned",
    );
    const aiAccess = existing
      ? {
          ...existing,
          enabled: true,
          provider: update.provider,
          credentialId: update.credentialId,
          defaultModel: update.defaultModel ?? null,
          allowedModels: update.allowedModels ?? [],
        }
      : await deps.aiAccess.upsertUserAiAccess(update);
    return { aiAccess, platformPolicy };
  }

  async function resolveUserAiAccess(userId: string) {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new Error("automatic_user_ai_access_user_id_required");
    }
    const existing = await deps.aiAccess.getUserAiAccess(normalizedUserId);
    if (existing?.enabled === false) {
      return { aiAccess: existing, platformPolicy: null };
    }

    const inFlight = resolutions.get(normalizedUserId);
    if (inFlight) {
      return inFlight;
    }

    const resolution = resolveEnabledUser(normalizedUserId, existing);
    resolutions.set(normalizedUserId, resolution);
    try {
      return await resolution;
    } finally {
      if (resolutions.get(normalizedUserId) === resolution) {
        resolutions.delete(normalizedUserId);
      }
    }
  }

  async function getOrCreateUserAiAccess(userId: string) {
    return (await resolveUserAiAccess(userId)).aiAccess;
  }

  async function resolvePinnedCredential(activeModel: PlatformModelRef) {
    if (activeModel.provider !== "codex_oauth" && activeModel.provider !== "openai_compatible") {
      return null;
    }
    const capability = await deps.modelCapabilities.checkHealthyCredentialForModel(activeModel);
    return capability.status === "supported" ? capability.credentialId : null;
  }

  return {
    resolveUserAiAccess,
    getOrCreateUserAiAccess,
    buildEnabledUpdate,
  };
}
