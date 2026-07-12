import type { CodexUsageLimitWindow, CodexUsageStatus } from "./codex-status.js";

export type CodexCredentialEligibility =
  | { eligible: true; state: "eligible"; reason: null }
  | { eligible: false; state: "exhausted"; reason: string; resetAt: string | null }
  | { eligible: false; state: "unavailable"; reason: string; resetAt: null };

export function evaluateCodexCredentialEligibility(
  status: CodexUsageStatus,
  now: Date = new Date(),
): CodexCredentialEligibility {
  const statusText = [status.label, status.detail].filter(Boolean).join(" | ");
  if (isCodexPermanentCredentialFailureStatusText(statusText)) {
    return {
      eligible: false,
      state: "unavailable",
      reason: status.detail || status.label || "Codex credential is unavailable.",
      resetAt: null,
    };
  }

  const exhaustedWindow = [status.limits?.fiveHour, status.limits?.weekly]
    .filter((window): window is CodexUsageLimitWindow => window !== null && window !== undefined)
    .find((window) => isWindowCurrentlyExhausted(window, now));

  if (exhaustedWindow) {
    return {
      eligible: false,
      state: "exhausted",
      reason: `${exhaustedWindow.label} Codex limit is exhausted.`,
      resetAt: exhaustedWindow.resetAt,
    };
  }

  if (isCodexUsageLimitFailure(statusText)) {
    return {
      eligible: false,
      state: "exhausted",
      reason: "5h Codex limit is exhausted.",
      resetAt: null,
    };
  }

  if (!status.available && !isHealthyProbeStatus(statusText) && !isGenericProbeFailure(statusText)) {
    return {
      eligible: false,
      state: "unavailable",
      reason: status.detail || status.label || "Codex credential is unavailable.",
      resetAt: null,
    };
  }

  return {
    eligible: true,
    state: "eligible",
    reason: null,
  };
}

export function isCodexPermanentCredentialFailureStatusText(statusText: string): boolean {
  return /invalid[_\s-]?grant|invalid[_\s-]+(?:(?:authentication|access|refresh|id)[_\s-]+)?token|(?:authentication|access|id)[_\s-]?token[_\s-]+(?:is[_\s-]+)?(?:invalid|expired|revoked|reused|missing)|revoked\s+auth|access[_\s-]?token\s+could\s+not\s+be\s+refreshed|refresh[_\s-]?token|HTTP error:\s*401|401\s+Unauthorized|missing field `id_token`|missing Codex auth\.json|please run `?codex login`?|login\s+required|required\s+login|authentication required/i
    .test(statusText);
}

function isHealthyProbeStatus(statusText: string): boolean {
  return /\bcodex\s*\|\s*OK\b/i.test(statusText);
}

function isGenericProbeFailure(statusText: string): boolean {
  return /Codex status probe (?:failed|timed out|exited with code)|Codex probe failed|Codex probe did not return rate limits|Codex rate limit snapshot was not found|ENOTEMPTY: directory not empty|ERROR:/i
    .test(statusText);
}

function isCodexUsageLimitFailure(statusText: string): boolean {
  return /you(?:'|’)?ve hit your usage limit|hit your usage limit/i.test(statusText);
}

function isWindowCurrentlyExhausted(window: CodexUsageLimitWindow, now: Date): boolean {
  if (window.usedPercent === null || window.usedPercent < 100) {
    return false;
  }

  if (!window.resetAt) {
    return true;
  }

  const resetAtMs = Date.parse(window.resetAt);
  if (!Number.isFinite(resetAtMs)) {
    return true;
  }

  return resetAtMs > now.getTime();
}
