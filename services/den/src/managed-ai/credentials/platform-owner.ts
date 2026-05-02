import type { LeaseProvider } from "../leases/repository.js"

export const PLATFORM_CREDENTIAL_OWNER_BY_PROVIDER: Record<LeaseProvider, string> = {
  openai: "platform:openai",
  anthropic: "platform:anthropic",
  codex_oauth: "platform:codex_oauth",
  openai_compatible: "platform:openai_compatible",
}

export function getPlatformCredentialOwnerUserId(provider: LeaseProvider): string {
  return PLATFORM_CREDENTIAL_OWNER_BY_PROVIDER[provider]
}
