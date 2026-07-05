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
      scope: "user",
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

  test("applies plugin policy overrides to lifecycle and effective enabled state", () => {
    const policies = resolveEffectivePluginPolicies({
      scope: "user",
      platform: [SUPERPOWERS_PLATFORM_PLUGIN],
      organization: [],
      user: [],
      project: [],
      overrides: [
        {
          id: "override_1",
          pluginId: SUPERPOWERS_PLATFORM_PLUGIN.id,
          action: "disabled",
          scope: "user",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(policies[0]).toMatchObject({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      lifecycle: "disabled",
      effectiveEnabled: false,
    });
  });

  test("removed plugin policy overrides win over disabled overrides", () => {
    const policies = resolveEffectivePluginPolicies({
      scope: "user",
      platform: [SUPERPOWERS_PLATFORM_PLUGIN],
      organization: [],
      user: [],
      project: [],
      overrides: [
        {
          id: "override_1",
          pluginId: SUPERPOWERS_PLATFORM_PLUGIN.id,
          action: "disabled",
          scope: "user",
          createdAt: new Date().toISOString(),
        },
        {
          id: "override_2",
          pluginId: SUPERPOWERS_PLATFORM_PLUGIN.id,
          action: "removed",
          scope: "user",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(policies[0]).toMatchObject({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      lifecycle: "removed",
      effectiveEnabled: false,
    });
  });

  test("ignores project plugin policy overrides for other workspaces", () => {
    const policies = resolveEffectivePluginPolicies({
      scope: "project",
      workspaceId: "ws_current",
      platform: [SUPERPOWERS_PLATFORM_PLUGIN],
      organization: [],
      user: [],
      project: [],
      overrides: [
        {
          id: "override_other_workspace",
          pluginId: SUPERPOWERS_PLATFORM_PLUGIN.id,
          action: "removed",
          scope: "project",
          workspaceId: "ws_other",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(policies[0]).toMatchObject({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      lifecycle: "active",
      effectiveEnabled: true,
    });
  });

  test("ignores organization plugin policy overrides for other organizations", () => {
    const policies = resolveEffectivePluginPolicies({
      scope: "organization",
      orgId: "org_current",
      platform: [SUPERPOWERS_PLATFORM_PLUGIN],
      organization: [],
      user: [],
      project: [],
      overrides: [
        {
          id: "override_other_org",
          pluginId: SUPERPOWERS_PLATFORM_PLUGIN.id,
          action: "disabled",
          scope: "organization",
          orgId: "org_other",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(policies[0]).toMatchObject({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      lifecycle: "active",
      effectiveEnabled: true,
    });
  });
});
