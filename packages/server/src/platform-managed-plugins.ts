import type { PluginPolicy } from "./plugin-policy.js";

export const OPENCODE_SCHEDULER_PLATFORM_PLUGIN: PluginPolicy = {
  id: "platform.opencode-scheduler",
  spec: "opencode-scheduler",
  displayName: "OpenCode Scheduler",
  owner: { kind: "platform", id: "veslo-platform", label: "Veslo" },
  target: "user",
  visibility: "hidden-debug-only",
  autoInstall: true,
  enabledPolicy: "locked-on",
  removalPolicy: "locked",
  source: "policy.platform",
};

export const SUPERPOWERS_PLATFORM_PLUGIN: PluginPolicy = {
  id: "platform.superpowers",
  spec: "superpowers@git+https://github.com/obra/superpowers.git",
  displayName: "Superpowers",
  owner: { kind: "platform", id: "veslo-platform", label: "Veslo" },
  target: "user",
  visibility: "visible",
  autoInstall: true,
  enabledPolicy: "user-toggleable",
  removalPolicy: "user-removable",
  source: "policy.platform",
};
