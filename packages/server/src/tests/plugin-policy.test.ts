import { describe, expect, test } from "bun:test";
import {
  resolveEffectivePluginPolicies,
  visiblePluginPolicies,
} from "../plugin-policy.js";
import {
  OPENCODE_SCHEDULER_PLATFORM_PLUGIN,
  SUPERPOWERS_PLATFORM_PLUGIN,
} from "../platform-managed-plugins.js";

describe("plugin policy model", () => {
  test("scheduler is hidden locked platform policy", () => {
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN).toEqual({
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
    });
  });

  test("superpowers is visible user-removable platform policy", () => {
    expect(SUPERPOWERS_PLATFORM_PLUGIN).toEqual({
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
    });
  });

  test("normal inventory hides hidden platform policies", () => {
    const policies = resolveEffectivePluginPolicies({
      platform: [OPENCODE_SCHEDULER_PLATFORM_PLUGIN, SUPERPOWERS_PLATFORM_PLUGIN],
      organization: [],
      user: [],
      project: [],
      overrides: [],
    });
    expect(visiblePluginPolicies(policies, { debug: false }).map((item) => item.id)).toEqual([
      SUPERPOWERS_PLATFORM_PLUGIN.id,
    ]);
    expect(visiblePluginPolicies(policies, { debug: true }).map((item) => item.id)).toContain(
      OPENCODE_SCHEDULER_PLATFORM_PLUGIN.id,
    );
  });
});
