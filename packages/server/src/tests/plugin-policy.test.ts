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
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.owner.kind).toBe("platform");
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.visibility).toBe("hidden-debug-only");
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.enabledPolicy).toBe("locked-on");
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.removalPolicy).toBe("locked");
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.autoInstall).toBe(true);
  });

  test("superpowers is visible user-removable platform policy", () => {
    expect(SUPERPOWERS_PLATFORM_PLUGIN.owner.kind).toBe("platform");
    expect(SUPERPOWERS_PLATFORM_PLUGIN.visibility).toBe("visible");
    expect(SUPERPOWERS_PLATFORM_PLUGIN.enabledPolicy).toBe("user-toggleable");
    expect(SUPERPOWERS_PLATFORM_PLUGIN.removalPolicy).toBe("user-removable");
    expect(SUPERPOWERS_PLATFORM_PLUGIN.autoInstall).toBe(true);
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
