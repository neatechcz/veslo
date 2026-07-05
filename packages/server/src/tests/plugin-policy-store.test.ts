import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { ApiError } from "../errors.js";
import {
  listPluginPolicyOverrides,
  pluginPolicyOverrideMatches,
  setPluginEnabledState,
  setPluginRemovedState,
} from "../plugin-policy-store.js";
import {
  OPENCODE_SCHEDULER_PLATFORM_PLUGIN,
  SUPERPOWERS_PLATFORM_PLUGIN,
} from "../platform-managed-plugins.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("plugin policy override store", () => {
  test("disabled Superpowers records persist to the plugin override file", async () => {
    const dataDir = await tempDir();

    const result = await setPluginEnabledState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "user",
      enabled: false,
      actor: { type: "remote", tokenHash: "secret-token-hash", clientId: "client_1", scope: "owner" },
    });

    const records = await listPluginPolicyOverrides({ dataDir });
    const persisted = await readFile(join(dataDir, "plugin-policy-overrides.json"), "utf8");
    const parsed = JSON.parse(persisted);

    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.record).toMatchObject({
      pluginId: "platform.superpowers",
      action: "disabled",
      scope: "user",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      pluginId: "platform.superpowers",
      action: "disabled",
      scope: "user",
    });
    expect(parsed.overrides).toHaveLength(1);
    expect(persisted).not.toContain("tokenHash");
    expect(persisted).not.toContain("secret-token-hash");
  });

  test("removed Superpowers records persist and restoring removes only removed state", async () => {
    const dataDir = await tempDir();

    await setPluginEnabledState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "user",
      enabled: false,
      actor: { type: "host" },
    });
    const removed = await setPluginRemovedState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "user",
      removed: true,
      actor: { type: "host" },
    });

    expect(removed.ok).toBe(true);
    expect(removed.removed).toBe(true);
    expect(removed.record).toMatchObject({
      pluginId: "platform.superpowers",
      action: "removed",
      scope: "user",
    });

    await setPluginRemovedState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "user",
      removed: false,
      actor: { type: "host" },
    });

    expect(await listPluginPolicyOverrides({ dataDir })).toMatchObject([
      {
        pluginId: "platform.superpowers",
        action: "disabled",
        scope: "user",
      },
    ]);
  });

  test("locked scheduler cannot be disabled or removed", async () => {
    const dataDir = await tempDir();

    await expect(setPluginEnabledState({
      dataDir,
      policy: OPENCODE_SCHEDULER_PLATFORM_PLUGIN,
      scope: "user",
      enabled: false,
      actor: { type: "host" },
    })).rejects.toMatchObject({
      status: 409,
      code: "plugin_policy_locked",
    });

    await expect(setPluginRemovedState({
      dataDir,
      policy: OPENCODE_SCHEDULER_PLATFORM_PLUGIN,
      scope: "user",
      removed: true,
      actor: { type: "host" },
    })).rejects.toMatchObject({
      status: 409,
      code: "plugin_policy_locked",
    });
  });

  test("store validates plugin ids and scopes", async () => {
    const dataDir = await tempDir();

    await expect(setPluginEnabledState({
      dataDir,
      policy: { ...SUPERPOWERS_PLATFORM_PLUGIN, id: "../superpowers" },
      scope: "user",
      enabled: false,
    })).rejects.toBeInstanceOf(ApiError);

    await expect(setPluginEnabledState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "project",
      enabled: false,
    })).rejects.toThrow("workspace id");

    await expect(setPluginRemovedState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "organization",
      removed: true,
    })).rejects.toThrow("organization id");

    await expect(setPluginEnabledState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "platform" as never,
      enabled: false,
    })).rejects.toThrow("scope");
  });

  test("listPluginPolicyOverrides filters project records and includes global records by default", async () => {
    const dataDir = await tempDir();

    await setPluginEnabledState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "user",
      enabled: false,
      actor: { type: "host" },
    });
    await setPluginRemovedState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "project",
      workspaceId: "ws_1",
      removed: true,
      actor: { type: "host" },
    });
    await setPluginRemovedState({
      dataDir,
      policy: SUPERPOWERS_PLATFORM_PLUGIN,
      scope: "project",
      workspaceId: "ws_2",
      removed: true,
      actor: { type: "host" },
    });

    expect(await listPluginPolicyOverrides({ dataDir, workspaceId: "ws_1" })).toMatchObject([
      { pluginId: "platform.superpowers", action: "disabled", scope: "user" },
      { pluginId: "platform.superpowers", action: "removed", scope: "project", workspaceId: "ws_1" },
    ]);
    expect(await listPluginPolicyOverrides({ dataDir, workspaceId: "ws_1", includeGlobal: false })).toMatchObject([
      { pluginId: "platform.superpowers", action: "removed", scope: "project", workspaceId: "ws_1" },
    ]);
  });

  test("pluginPolicyOverrideMatches normalizes ids and scope targets", () => {
    expect(pluginPolicyOverrideMatches(
      {
        id: "override_1",
        pluginId: " platform.superpowers ",
        action: "disabled",
        scope: "project",
        workspaceId: " ws_1 ",
        createdAt: new Date().toISOString(),
      },
      { pluginId: "platform.superpowers", scope: "project", workspaceId: "ws_1" },
    )).toBe(true);
  });
});

async function tempDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-plugin-policy-"));
  tempDirs.push(dataDir);
  return dataDir;
}
