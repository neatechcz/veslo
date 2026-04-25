export const CODEX_OAUTH_PROVIDER = "codex_oauth" as const
export const MANAGED_AI_PROVIDERS = ["openai", "anthropic", CODEX_OAUTH_PROVIDER] as const

export type ManagedAiProvider = (typeof MANAGED_AI_PROVIDERS)[number]

export function isManagedAiProvider(value: unknown): value is ManagedAiProvider {
  return value === "openai" || value === "anthropic" || value === CODEX_OAUTH_PROVIDER
}

export function isApiKeyCredentialProvider(value: unknown): value is "openai" | "anthropic" {
  return value === "openai" || value === "anthropic"
}

export function formatManagedAiProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "anthropic") return "Anthropic"
  if (provider === CODEX_OAUTH_PROVIDER) return "Codex OAuth"
  return provider
}
