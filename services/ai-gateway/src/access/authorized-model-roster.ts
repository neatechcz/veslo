import type { PlatformModelPolicyRecord } from "../model-policy/repository.js";
import type { UserAiAccessPolicyRecord } from "./repository.js";

export function resolveAuthorizedModelRoster(input: {
  aiAccess: Pick<UserAiAccessPolicyRecord, "provider" | "defaultModel" | "allowedModels">;
  platformPolicy?: PlatformModelPolicyRecord | null;
}): string[] {
  const provider = input.aiAccess.provider;
  if (!provider || !input.platformPolicy) return [];

  const defaultModel = input.aiAccess.defaultModel?.trim() ?? "";
  const requested = normalizeModels(input.aiAccess.allowedModels);
  const userAllowed = requested.length > 0 ? requested : defaultModel ? [defaultModel] : [];
  const enabled = new Set(
    input.platformPolicy.enabledModels
      .filter((entry) => entry.provider === provider)
      .map((entry) => entry.model.trim())
      .filter(Boolean),
  );
  return orderDefaultFirst(userAllowed.filter((model) => enabled.has(model)), defaultModel);
}

function normalizeModels(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const model = value.trim();
    if (model) seen.add(model);
  }
  return Array.from(seen);
}

function orderDefaultFirst(models: string[], defaultModel: string): string[] {
  if (!defaultModel || !models.includes(defaultModel)) return models;
  return [defaultModel, ...models.filter((model) => model !== defaultModel)];
}
