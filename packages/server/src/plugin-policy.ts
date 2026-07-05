import type { PluginPolicyOverride, PluginPolicyOverrideScope } from "./types.js";

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
  scope: PluginPolicyOverrideScope;
  workspaceId?: string;
  orgId?: string;
  platform: PluginPolicy[];
  organization: PluginPolicy[];
  user: PluginPolicy[];
  project: PluginPolicy[];
  overrides: PluginPolicyOverride[];
};

export type EffectivePluginPolicy = PluginPolicy & {
  lifecycle: PluginLifecycle;
  effectiveEnabled: boolean;
};

export type VisiblePluginPolicyOptions = {
  debug: boolean;
};

export function resolveEffectivePluginPolicies(input: PluginPolicyResolutionInput): EffectivePluginPolicy[] {
  const overrides = input.overrides.filter(isSupportedOverride);
  return [...input.platform, ...input.organization, ...input.user, ...input.project].map((policy) => {
    const matchingOverrides = overrides.filter((override) => overrideMatchesResolutionTarget(override, policy.id, input));
    const lifecycle: PluginLifecycle = matchingOverrides.some((override) => override.action === "removed")
      ? "removed"
      : matchingOverrides.some((override) => override.action === "disabled")
        ? "disabled"
        : "active";
    return {
      ...policy,
      lifecycle,
      effectiveEnabled: lifecycle === "active",
    };
  });
}

export function visiblePluginPolicies(
  policies: PluginPolicy[],
  options: VisiblePluginPolicyOptions,
): PluginPolicy[] {
  if (options.debug) return policies;
  return policies.filter((policy) => policy.visibility === "visible");
}

function isSupportedOverride(value: PluginPolicyOverride): boolean {
  return typeof value.pluginId === "string" && (value.action === "disabled" || value.action === "removed");
}

function overrideMatchesResolutionTarget(
  override: PluginPolicyOverride,
  policyId: string,
  target: Pick<PluginPolicyResolutionInput, "scope" | "workspaceId" | "orgId">,
): boolean {
  if (override.pluginId.trim() !== policyId) return false;
  if (override.scope !== target.scope) return false;

  if (target.scope === "project") {
    const workspaceId = target.workspaceId?.trim();
    return Boolean(workspaceId) && override.workspaceId?.trim() === workspaceId;
  }

  if (target.scope === "organization") {
    const orgId = target.orgId?.trim();
    return Boolean(orgId) && override.orgId?.trim() === orgId;
  }

  return true;
}
