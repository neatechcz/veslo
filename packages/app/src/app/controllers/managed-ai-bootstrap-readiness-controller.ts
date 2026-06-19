export type ManagedAiBootstrapCurrentConfigCheckDecision =
  | { type: "check-current-config" }
  | {
    type: "skip-current-config-check";
    reason: "access-not-busy" | "bootstrap-pending" | "reload-busy";
  };

export function resolveManagedAiBootstrapCurrentConfigCheck(input: {
  accessBusy: boolean;
  bootstrapPendingCount: number;
  reloadBusy: boolean;
}): ManagedAiBootstrapCurrentConfigCheckDecision {
  if (!input.accessBusy) {
    return { type: "skip-current-config-check", reason: "access-not-busy" };
  }
  if (input.bootstrapPendingCount > 0) {
    return { type: "skip-current-config-check", reason: "bootstrap-pending" };
  }
  if (input.reloadBusy) {
    return { type: "skip-current-config-check", reason: "reload-busy" };
  }
  return { type: "check-current-config" };
}

export function resolveManagedAiBootstrapWaitDecision(input: {
  managedProfilePresent: boolean;
  bootstrapBusy: boolean;
  canUseCurrentManagedConfig: boolean;
}): { hasManagedProfile: boolean } {
  return {
    hasManagedProfile:
      (input.managedProfilePresent || input.bootstrapBusy) &&
      !input.canUseCurrentManagedConfig,
  };
}
