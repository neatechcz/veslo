import type { ModelRef, ProviderListItem, MessageWithParts } from "../types";

/** Fraction of context window that triggers auto-compaction. */
export const COMPACTION_THRESHOLD_RATIO = 0.90;

/**
 * Model-specific overrides for the compaction context limit.
 * GPT-5.4 has a 1M+ context window but degrades in quality at high usage;
 * compact early at 127K instead.
 * Uses prefix matching: "gpt-5.4" also covers "gpt-5.4-2026-03-05".
 */
const COMPACTION_TOKEN_OVERRIDES: Array<{ prefix: string; limit: number }> = [
  { prefix: "gpt-5.4", limit: 128_000 },
];

export function resolveCompactionThreshold(
  model: ModelRef,
  allProviders: ProviderListItem[],
): number | null {
  const override = COMPACTION_TOKEN_OVERRIDES.find(
    (entry) => model.modelID === entry.prefix || model.modelID.startsWith(entry.prefix + "-"),
  );
  if (override) return override.limit;

  const provider = allProviders.find((p) => p.id === model.providerID);
  if (!provider) return null;
  const modelData = provider.models[model.modelID];
  if (!modelData?.limit?.context) return null;

  return modelData.limit.context;
}

export function shouldAutoCompact(
  sessionMessages: MessageWithParts[],
  model: ModelRef,
  allProviders: ProviderListItem[],
): boolean {
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    const info = sessionMessages[i].info;
    if (info.role !== "assistant") continue;

    const inputTokens = info.tokens?.input;
    if (typeof inputTokens !== "number" || inputTokens <= 0) continue;

    const contextLimit = resolveCompactionThreshold(model, allProviders);
    if (!contextLimit || contextLimit <= 0) return false;

    return inputTokens / contextLimit >= COMPACTION_THRESHOLD_RATIO;
  }

  return false;
}
