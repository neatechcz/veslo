export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

const CODEX_MODEL_CATALOG = [
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
] as const;

export function listCodexModelCatalog(): string[] {
  return [...CODEX_MODEL_CATALOG];
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
