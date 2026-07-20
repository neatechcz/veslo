import { listGatewayModelCapabilityDescriptors } from "./model-capability-registry.js";

export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

export function listCodexModelCatalog(): string[] {
  return listGatewayModelCapabilityDescriptors("codex_oauth").map((entry) => entry.model);
}

export function resolveCodexModelPolicy(input: {
  defaultModel: string | null;
  allowedModels: string[];
}): { defaultModel: string; allowedModels: string[] } {
  const allowedModels = normalizeModelList(input.allowedModels);
  const defaultModel = normalizeModel(input.defaultModel) || allowedModels[0] || CODEX_DEFAULT_MODEL;

  return {
    defaultModel,
    allowedModels: allowedModels.length > 0 ? allowedModels : [defaultModel],
  };
}

function normalizeModel(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeModelList(values: unknown[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const model = normalizeModel(value);
    if (model) {
      unique.add(model);
    }
  }
  return Array.from(unique);
}
