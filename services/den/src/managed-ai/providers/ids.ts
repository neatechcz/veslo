export const CODEX_OAUTH_PROVIDER = "codex_oauth" as const
export const OPENAI_COMPATIBLE_PROVIDER = "openai_compatible" as const
export const MANAGED_AI_PROVIDERS = ["openai", "anthropic", CODEX_OAUTH_PROVIDER, OPENAI_COMPATIBLE_PROVIDER] as const

export type ManagedAiProvider = (typeof MANAGED_AI_PROVIDERS)[number]

export function isManagedAiProvider(value: unknown): value is ManagedAiProvider {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === CODEX_OAUTH_PROVIDER ||
    value === OPENAI_COMPATIBLE_PROVIDER
  )
}

export function isApiKeyCredentialProvider(
  value: unknown,
): value is "openai" | "anthropic" | "openai_compatible" {
  return value === "openai" || value === "anthropic" || value === OPENAI_COMPATIBLE_PROVIDER
}

export function formatManagedAiProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "anthropic") return "Anthropic"
  if (provider === CODEX_OAUTH_PROVIDER) return "Codex OAuth"
  if (provider === OPENAI_COMPATIBLE_PROVIDER) return "OpenAI-compatible"
  return provider
}
