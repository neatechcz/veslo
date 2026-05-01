export type TokenUsageAccounting = {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
}

export function readOpenAiCompatibleUsage(body: unknown): TokenUsageAccounting | null {
  const usage = getRecord(getRecord(body)?.usage)
  if (!usage) {
    return null
  }

  const inputTokens = readFiniteNumber(usage.prompt_tokens) ?? readFiniteNumber(usage.input_tokens) ?? 0
  const outputTokens = readFiniteNumber(usage.completion_tokens) ?? readFiniteNumber(usage.output_tokens) ?? 0
  const cachedTokens =
    readFiniteNumber(getRecord(usage.prompt_tokens_details)?.cached_tokens) ??
    readFiniteNumber(getRecord(usage.input_tokens_details)?.cached_tokens) ??
    0
  const totalTokens = readFiniteNumber(usage.total_tokens) ?? inputTokens + outputTokens

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
  }
}

export function readAnthropicUsage(body: unknown): TokenUsageAccounting | null {
  const usage = getRecord(getRecord(body)?.usage)
  if (!usage) {
    return null
  }

  const inputTokens = readFiniteNumber(usage.input_tokens) ?? 0
  const outputTokens = readFiniteNumber(usage.output_tokens) ?? 0
  const cachedTokens =
    (readFiniteNumber(usage.cache_creation_input_tokens) ?? 0) +
    (readFiniteNumber(usage.cache_read_input_tokens) ?? 0)

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens + cachedTokens,
  }
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null
  }

  return value as Record<string, unknown>
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
