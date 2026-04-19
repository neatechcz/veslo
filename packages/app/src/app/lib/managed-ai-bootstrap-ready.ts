export async function waitForManagedAiBootstrapReady(input: {
  hasManagedProfile: boolean;
  isBootstrapBusy: () => boolean;
  isReloadBusy: () => boolean;
  hasClient: () => boolean;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!input.hasManagedProfile) return;

  const timeoutMs = input.timeoutMs ?? 15_000;
  const pollMs = input.pollMs ?? 100;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();

  while (true) {
    if (!input.isBootstrapBusy() && !input.isReloadBusy() && input.hasClient()) {
      return;
    }

    if (now() - startedAt >= timeoutMs) {
      throw new Error("Managed AI setup is still applying. Please wait a moment and try again.");
    }

    await sleep(pollMs);
  }
}
