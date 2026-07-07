const MANAGED_AI_ACCESS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const;

export function shouldRetryManagedAiAccessRefresh(input: {
  hasGatewayClient: boolean;
  userToken: string | null | undefined;
  profilePresent: boolean;
}): boolean {
  if (!input.hasGatewayClient) return false;
  if (input.profilePresent) return false;
  return Boolean(input.userToken?.trim());
}

export function resolveManagedAiAccessRetryDelayMs(attempt: number): number {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const delayIndex = Math.min(normalizedAttempt, MANAGED_AI_ACCESS_RETRY_DELAYS_MS.length - 1);
  return MANAGED_AI_ACCESS_RETRY_DELAYS_MS[delayIndex] ?? 60_000;
}
