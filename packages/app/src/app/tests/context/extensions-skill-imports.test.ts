import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

const { createExtensionsStore } = await import("../../context/extensions.js");

const candidate = {
  id: "candidate-1",
  name: "codex-helper",
  description: "Codex helper",
  sourceAgent: "codex",
  sourceLocation: "user-global",
  sourcePath: "/Users/example/.codex/skills/codex-helper",
  sourceRoot: "/Users/example/.codex/skills",
  target: { scope: "user-global" },
  status: "ready",
  warnings: [],
  fileCount: 1,
};

test("extensions store loads and imports skill candidates through Veslo server", async () => {
  await createRoot(async (dispose) => {
    const calls = {
      listImportCandidates: 0,
      importCandidates: [] as string[][],
      listSkills: 0,
      listUserGlobalSkillStore: 0,
      listSkillRemovals: 0,
      syncUserGlobalSkillStore: 0,
      reloads: [] as unknown[],
    };
    const client = {
      async listSkillImportCandidates() {
        calls.listImportCandidates += 1;
        return { items: [candidate] };
      },
      async importSkillCandidates(candidateIds: string[]) {
        calls.importCandidates.push(candidateIds);
        return {
          ok: true,
          reloadRequired: true,
          results: [{ candidateId: "candidate-1", name: "codex-helper", ok: true, target: { scope: "user-global" } }],
        };
      },
      async listSkills() {
        calls.listSkills += 1;
        return { items: [] };
      },
      async listUserGlobalSkillStore() {
        calls.listUserGlobalSkillStore += 1;
        return { items: [] };
      },
      async listSkillRemovals() {
        calls.listSkillRemovals += 1;
        return { items: [] };
      },
      async syncUserGlobalSkillStore() {
        calls.syncUserGlobalSkillStore += 1;
        return { reloadRequired: true };
      },
    };

    const store = createExtensionsStore({
      client: () => null,
      projectDir: () => "/workspaces/alpha",
      activeWorkspaceId: () => "ws-alpha",
      activeWorkspaceRoot: () => "/workspaces/alpha",
      workspaceType: () => "local",
      workspaces: () => [{
        id: "ws-alpha",
        name: "Alpha",
        path: "/workspaces/alpha",
        preset: "starter",
        workspaceType: "local",
      }],
      vesloServerClient: () => client as never,
      vesloServerStatus: () => "connected",
      vesloServerCapabilities: () => ({
        skills: { read: true, write: true, source: "veslo" },
        plugins: { read: false, write: false },
        mcp: { read: false, write: false },
        commands: { read: false, write: false },
        config: { read: false, write: false },
      }) as never,
      vesloServerWorkspaceId: () => "ws-alpha",
      listLocalSkillsScoped: async () => [],
      setBusy: () => undefined,
      setBusyLabel: () => undefined,
      setBusyStartedAt: () => undefined,
      setError: () => undefined,
      markReloadRequired: (...args) => {
        calls.reloads.push(args);
      },
    });

    try {
      await store.refreshSkillImportCandidates({ force: true });
      assert.deepEqual(store.skillImportCandidates(), [candidate]);
      assert.equal(calls.listImportCandidates, 1);

      const result = await store.importSkillCandidates(["candidate-1"]);

      assert.equal(result.ok, true);
      assert.deepEqual(calls.importCandidates, [["candidate-1"]]);
      assert.equal(calls.syncUserGlobalSkillStore, 1);
      assert.ok(calls.listSkills >= 1);
      assert.ok(calls.listImportCandidates >= 2);
      assert.ok(calls.reloads.length >= 1);
    } finally {
      dispose();
    }
  });
});
