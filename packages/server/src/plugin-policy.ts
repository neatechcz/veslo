export type PluginOwnerKind = "platform" | "organization" | "user" | "project";
export type PluginVisibility = "visible" | "hidden-debug-only";
export type PluginEnabledPolicy = "locked-on" | "user-toggleable" | "admin-toggleable";
export type PluginRemovalPolicy = "locked" | "admin-removable" | "user-removable";
export type PluginLifecycle = "active" | "disabled" | "removed" | "conflict";

export type PluginPolicy = {
  id: string;
  spec: string;
  displayName: string;
  description?: string;
  owner: { kind: PluginOwnerKind; id: string; label?: string };
  target: "user" | "project";
  visibility: PluginVisibility;
  autoInstall: boolean;
  enabledPolicy: PluginEnabledPolicy;
  removalPolicy: PluginRemovalPolicy;
  source:
    | "policy.platform"
    | "policy.organization"
    | "policy.user"
    | "policy.project"
    | "config.unmanaged";
};

export type PluginPolicyResolutionInput = {
  platform: PluginPolicy[];
  organization: PluginPolicy[];
  user: PluginPolicy[];
  project: PluginPolicy[];
  overrides: unknown[];
};

export type VisiblePluginPolicyOptions = {
  debug: boolean;
};

export function resolveEffectivePluginPolicies(input: PluginPolicyResolutionInput): PluginPolicy[] {
  if (input.overrides.length > 0) {
    throw new Error("Plugin policy overrides are not implemented yet");
  }
  return [...input.platform, ...input.organization, ...input.user, ...input.project];
}

export function visiblePluginPolicies(
  policies: PluginPolicy[],
  options: VisiblePluginPolicyOptions,
): PluginPolicy[] {
  if (options.debug) return policies;
  return policies.filter((policy) => policy.visibility === "visible");
}
