import type { ModelRef, ProviderListItem } from "../types";

const FRIENDLY_PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
};

const humanizeModelLabel = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (normalized && FRIENDLY_PROVIDER_LABELS[normalized]) {
    return FRIENDLY_PROVIDER_LABELS[normalized];
  }

  const cleaned = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return value;

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/\d/.test(word) || word.length <= 3) {
        return word.toUpperCase();
      }
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
};

export function formatModelRef(model: ModelRef) {
  return `${model.providerID}/${model.modelID}`;
}

export function parseModelRef(raw: string | null): ModelRef | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [providerID, ...rest] = trimmed.split("/");
  if (!providerID || rest.length === 0) return null;
  return { providerID, modelID: rest.join("/") };
}

export function modelEquals(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

export function formatModelLabel(model: ModelRef, providers: ProviderListItem[] = []) {
  const provider = providers.find((p) => p.id === model.providerID);
  const modelInfo = provider?.models?.[model.modelID];

  const providerLabel = provider?.name ?? humanizeModelLabel(model.providerID);
  const modelLabel = modelInfo?.name ?? humanizeModelLabel(model.modelID);

  return `${providerLabel} · ${modelLabel}`;
}
