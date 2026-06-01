import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import type { LocalSkillCard, LocalSkillListScope, WorkspaceInfo } from "../lib/tauri";

const { createExtensionsStore } = await import("./extensions.js");

const workspace: WorkspaceInfo = {
  id: "ws-alpha",
  name: "Alpha Workspace",
  path: "/workspaces/alpha",
  preset: "starter",
  workspaceType: "local",
};

test("registry invalidation forces skill inventory to reload local materialized skills", async () => {
  await createRoot(async (dispose) => {
    let version = 1;
    const localCalls: Array<{ projectDir: string; scope: LocalSkillListScope }> = [];
    const listLocalSkillsScoped = async (
      projectDir: string,
      scope: LocalSkillListScope,
    ): Promise<LocalSkillCard[]> => {
      localCalls.push({ projectDir, scope });
      if (scope === "global") return [];
      return [
        {
          name: `research-${version}`,
          description: `Research ${version}`,
          path: `${projectDir}/.opencode/skills/veslo-managed/research/SKILL.md`,
        },
      ];
    };

    const store = createExtensionsStore({
      client: () => null,
      projectDir: () => "/workspaces/alpha",
      activeWorkspaceId: () => "ws-alpha",
      activeWorkspaceRoot: () => "/workspaces/alpha",
      workspaceType: () => "local",
      workspaces: () => [workspace],
      vesloServerClient: () => null,
      vesloServerStatus: () => "connected",
      vesloServerCapabilities: () => null,
      vesloServerWorkspaceId: () => "ws-alpha",
      listLocalSkillsScoped,
      setBusy: () => undefined,
      setBusyLabel: () => undefined,
      setBusyStartedAt: () => undefined,
      setError: () => undefined,
    });

    assert.equal(typeof store.invalidateSkillRegistryInventory, "function");
    await store.refreshSkillInventory({ force: true });
    assert.equal(store.skillInventory().some((item) => item.name === "research-1"), true);

    version = 2;
    await store.invalidateSkillRegistryInventory();
    assert.equal(store.skillInventory().some((item) => item.name === "research-1"), false);
    assert.equal(store.skillInventory().some((item) => item.name === "research-2"), true);
    assert.deepEqual(localCalls, [
      { projectDir: "", scope: "global" },
      { projectDir: "/workspaces/alpha", scope: "workspace" },
      { projectDir: "", scope: "global" },
      { projectDir: "/workspaces/alpha", scope: "workspace" },
    ]);

    dispose();
  });
});
