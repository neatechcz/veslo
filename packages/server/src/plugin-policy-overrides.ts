export type PluginPolicyOverrideAction = "disabled" | "removed";

export type PluginPolicyOverrideScope = "user" | "project" | "organization";

export type PluginPolicyOverride = {
  id: string;
  pluginId: string;
  action: PluginPolicyOverrideAction;
  scope: PluginPolicyOverrideScope;
  workspaceId?: string;
  orgId?: string;
  actor?: string;
  createdAt: string;
};

export type PluginPolicyOverridesDocument = {
  schemaVersion: 1;
  overrides: PluginPolicyOverride[];
};
