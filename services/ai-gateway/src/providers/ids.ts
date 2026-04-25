export const CODEX_OAUTH_PROVIDER = "codex_oauth" as const
export const CODEX_OAUTH_WORKER_BINDING_ID = "binding_codex_oauth_worker" as const
export const AI_GATEWAY_PROVIDERS = ["openai", "anthropic", CODEX_OAUTH_PROVIDER] as const

export type AiGatewayProvider = (typeof AI_GATEWAY_PROVIDERS)[number]

export function isAiGatewayProvider(value: unknown): value is AiGatewayProvider {
  return value === "openai" || value === "anthropic" || value === CODEX_OAUTH_PROVIDER
}

export function isApiKeyCredentialProvider(value: unknown): value is "openai" | "anthropic" {
  return value === "openai" || value === "anthropic"
}

export function formatAiGatewayProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "anthropic") return "Anthropic"
  if (provider === CODEX_OAUTH_PROVIDER) return "Codex OAuth"
  return provider
}
