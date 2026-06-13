export type ManagedAiConfigSyncPreflightDecision =
  | {
    type: "skip";
    reason:
      | "workspace-default-model-not-ready"
      | "non-desktop-runtime"
      | "default-model-not-explicit"
      | "non-local-workspace"
      | "missing-workspace-root";
  }
  | { type: "sync"; workspaceRoot: string };

export function resolveManagedAiConfigSyncPreflight(input: {
  workspaceDefaultModelReady: boolean;
  isDesktopRuntime: boolean;
  defaultModelExplicit: boolean;
  workspaceType: "local" | "remote" | null | undefined;
  workspaceRoot: string | null | undefined;
}): ManagedAiConfigSyncPreflightDecision {
  if (!input.workspaceDefaultModelReady) {
    return { type: "skip", reason: "workspace-default-model-not-ready" };
  }
  if (!input.isDesktopRuntime) {
    return { type: "skip", reason: "non-desktop-runtime" };
  }
  if (!input.defaultModelExplicit) {
    return { type: "skip", reason: "default-model-not-explicit" };
  }
  if (input.workspaceType !== "local") {
    return { type: "skip", reason: "non-local-workspace" };
  }
  const workspaceRoot = input.workspaceRoot?.trim() ?? "";
  if (!workspaceRoot) {
    return { type: "skip", reason: "missing-workspace-root" };
  }
  return { type: "sync", workspaceRoot };
}

export type ManagedAiConfigWriteDecision =
  | {
    type: "skip";
    reason:
      | "provider-routing-not-ready"
      | "managed-config-current"
      | "preserve-managed-config"
      | "default-model-current";
  }
  | { type: "write-managed-config" }
  | { type: "write-default-model" };

export function resolveManagedAiConfigWriteDecision(input: {
  managedProfilePresent: boolean;
  providerRoutingReady: boolean;
  managedConfigAlreadyCurrent: boolean;
  shouldPreserveManagedConfig: boolean;
  defaultModelAlreadyCurrent: boolean;
}): ManagedAiConfigWriteDecision {
  if (input.managedProfilePresent) {
    if (!input.providerRoutingReady) {
      return { type: "skip", reason: "provider-routing-not-ready" };
    }
    if (input.managedConfigAlreadyCurrent) {
      return { type: "skip", reason: "managed-config-current" };
    }
    return { type: "write-managed-config" };
  }

  if (input.shouldPreserveManagedConfig) {
    return { type: "skip", reason: "preserve-managed-config" };
  }
  if (input.defaultModelAlreadyCurrent) {
    return { type: "skip", reason: "default-model-current" };
  }
  return { type: "write-default-model" };
}
