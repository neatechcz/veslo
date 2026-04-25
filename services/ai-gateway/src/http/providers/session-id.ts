import { createHash } from "node:crypto"

import type { LeaseProvider } from "../../leases/repository.js"

export function normalizeGatewaySessionId(
  sessionId: string,
  ownerUserId: string,
  provider: LeaseProvider,
): string {
  const normalized = sessionId.trim()
  if (!normalized) {
    return normalized
  }

  if (!containsUnresolvedOpencodeSessionId(normalized)) {
    return normalized
  }

  const digest = createHash("sha256")
    .update(ownerUserId)
    .update("\0")
    .update(provider)
    .digest("hex")
    .slice(0, 16)

  return `veslo_fallback_${provider}_${digest}`
}

function containsUnresolvedOpencodeSessionId(value: string): boolean {
  return value.includes("OPENCODE_SESSION_ID")
}
