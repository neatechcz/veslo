export const CODEX_OAUTH_PROVIDER = "codex_oauth" as const
const CODEX_OAUTH_WORKER_BINDING_ID = "binding_codex_oauth_worker" as const
const OPENAI_COMPATIBLE_PROVIDER = "openai_compatible" as const
export const AI_GATEWAY_PROVIDERS = ["openai", "anthropic", CODEX_OAUTH_PROVIDER, OPENAI_COMPATIBLE_PROVIDER] as const

export type AiGatewayProvider = (typeof AI_GATEWAY_PROVIDERS)[number]

export function isAiGatewayProvider(value: unknown): value is AiGatewayProvider {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === CODEX_OAUTH_PROVIDER ||
    value === OPENAI_COMPATIBLE_PROVIDER
  )
}

function isApiKeyCredentialProvider(value: unknown): value is "openai" | "anthropic" | "openai_compatible" {
  return value === "openai" || value === "anthropic" || value === OPENAI_COMPATIBLE_PROVIDER
}

export function formatAiGatewayProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "anthropic") return "Anthropic"
  if (provider === CODEX_OAUTH_PROVIDER) return "Codex OAuth"
  if (provider === OPENAI_COMPATIBLE_PROVIDER) return "OpenAI-compatible"
  return provider
}
