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
  const initializations = new Map<string, Promise<UserAiAccessPolicyRecord>>();

  async function buildEnabledUpdate(
    userId: string,
    assignmentOrigin: AiAccessAssignmentOrigin,
  ): Promise<UpsertUserAiAccessPolicyInput> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new Error("automatic_user_ai_access_user_id_required");
    }

    const policy = await deps.modelPolicy.getPolicy();
    if (!policy) {
      throw new AutomaticUserAiAccessInfrastructureError("gateway_platform_model_policy_unavailable");
    }

    return {
      userId: normalizedUserId,
      enabled: true,
      provider: policy.activeModel.provider,
      credentialId: await resolvePinnedCredential(policy.activeModel),
      defaultModel: policy.activeModel.model,
      allowedModels: enabledSameProviderModels(policy),
      assignmentOrigin,
    };
  }

  async function initializeMissingUser(userId: string) {
    const update = await buildEnabledUpdate(userId, "auto_assigned");
    return deps.aiAccess.upsertUserAiAccess(update);
  }

  async function getOrCreateUserAiAccess(userId: string) {
    const existing = await deps.aiAccess.getUserAiAccess(userId);
    if (existing) {
      return existing;
    }

    const normalizedUserId = userId.trim();
    const inFlight = initializations.get(normalizedUserId);
    if (inFlight) {
      return inFlight;
    }

    const initialization = initializeMissingUser(normalizedUserId);
    initializations.set(normalizedUserId, initialization);
    try {
      return await initialization;
    } finally {
      if (initializations.get(normalizedUserId) === initialization) {
        initializations.delete(normalizedUserId);
      }
    }
  }

  async function resolvePinnedCredential(activeModel: PlatformModelRef) {
    if (activeModel.provider !== "codex_oauth" && activeModel.provider !== "openai_compatible") {
      return null;
    }
    const capability = await deps.modelCapabilities.checkHealthyCredentialForModel(activeModel);
    return capability.status === "supported" ? capability.credentialId : null;
  }

  return {
    getOrCreateUserAiAccess,
    buildEnabledUpdate,
  };
}

function enabledSameProviderModels(policy: PlatformModelPolicyRecord) {
  const provider = policy.activeModel.provider;
  const activeModel = policy.activeModel.model.trim();
  const seen = new Set<string>();
  const models: string[] = [];

  for (const entry of [policy.activeModel, ...policy.enabledModels]) {
    const model = entry.model.trim();
    if (entry.provider !== provider || !model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    models.push(model);
  }

  return activeModel && models.includes(activeModel)
    ? [activeModel, ...models.filter((model) => model !== activeModel)]
    : models;
}
