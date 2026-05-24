import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import type { LocalSkillCard, LocalSkillListScope, WorkspaceInfo } from "../lib/tauri";

const { registerHooks } = (await import("node:module")) as unknown as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      nextResolve: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }) => void;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".md?raw")) {
      return { url: "data:text/javascript,export%20default%20%22%22%3B", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { createExtensionsStore } = await import("./extensions.js");

const denAuthJson = JSON.stringify({
  denApiBase: "https://api.veslo.test",
  token: "den-token",
  orgId: "org-1",
  user: { id: "user-1" },
  org: { id: "org-1" },
});

function createMemoryStorage(seed: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(seed));
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
  };
}

async function withDenAuthStorage(run: () => Promise<void>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createMemoryStorage(),
      sessionStorage: createMemoryStorage({ "veslo.den.auth": denAuthJson }),
    },
  });

  try {
    await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

const workspaces: WorkspaceInfo[] = [
  {
    id: "ws-alpha",
    name: "Alpha Workspace",
    displayName: "Alpha Label",
    path: "/workspaces/alpha",
    preset: "starter",
    workspaceType: "local",
  },
  {
    id: "ws-beta",
    name: "Beta Workspace",
    path: "/workspaces/beta",
    preset: "automation",
    workspaceType: "local",
  },
];

test("extensions store exposes an app-wide skill inventory from global, workspace, and hub sources", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      const localCalls: Array<{ projectDir: string; scope: LocalSkillListScope }> = [];
      const listLocalSkillsScoped = async (
        projectDir: string,
        scope: LocalSkillListScope,
      ): Promise<LocalSkillCard[]> => {
        localCalls.push({ projectDir, scope });
        if (scope === "global") {
          return [
            {
              name: "research",
              description: "Global research",
              path: "/Users/example/.opencode/skills/research/SKILL.md",
            },
          ];
        }
        if (projectDir === "/workspaces/alpha") {
          return [
            {
              name: "deploy",
              description: "Alpha deploy",
              path: "/workspaces/alpha/.opencode/skills/deploy/SKILL.md",
            },
          ];
        }
        return [];
      };

      const vesloServerClient = {
        async listHubSkills(input: { denToken: string; denOrgId: string }) {
          assert.deepEqual(input, { denToken: "den-token", denOrgId: "org-1" });
          return {
            items: [
              {
                name: "planning",
                description: "Planning from hub",
                trigger: "plan work",
                source: {
                  owner: "neatech",
                  repo: "veslo-skills",
                  ref: "main",
                  path: "skills/planning",
                },
              },
            ],
          };
        },
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => workspaces,
          vesloServerClient: () => vesloServerClient as never,
          vesloServerStatus: () => "connected",
          vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
          vesloServerWorkspaceId: () => "ws-alpha",
          listLocalSkillsScoped,
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        assert.equal(typeof store.skillInventory, "function");
        assert.equal(typeof store.skillInventoryStatus, "function");
        assert.equal(typeof store.refreshSkillInventory, "function");

        await store.refreshSkillInventory({ force: true });

        assert.deepEqual(localCalls, [
          { projectDir: "", scope: "global" },
          { projectDir: "/workspaces/alpha", scope: "workspace" },
          { projectDir: "/workspaces/beta", scope: "workspace" },
        ]);

        const inventory = store.skillInventory();
        assert.equal(inventory.filter((item) => item.name === "research").length, 1);

        const globalSkill = inventory.find((item) => item.name === "research");
        assert.equal(globalSkill?.status, "global");
        assert.equal(globalSkill?.globalInstance?.path, "/Users/example/.opencode/skills/research/SKILL.md");
        assert.equal(globalSkill?.workspaceInstances.length, 0);

        const workspaceSkill = inventory.find((item) => item.name === "deploy");
        assert.equal(workspaceSkill?.status, "workspace-only");
        assert.equal(workspaceSkill?.workspaceInstances.length, 1);
        assert.equal(workspaceSkill?.workspaceInstances[0]?.workspaceId, "ws-alpha");
        assert.equal(workspaceSkill?.workspaceInstances[0]?.workspaceLabel, "Alpha Label");
        assert.equal(workspaceSkill?.workspaceInstances[0]?.path, "/workspaces/alpha/.opencode/skills/deploy/SKILL.md");

        const hubSkill = inventory.find((item) => item.name === "planning");
        assert.equal(hubSkill?.status, "hub-only");
        assert.equal(hubSkill?.hubItem?.description, "Planning from hub");
        assert.equal(hubSkill?.hubItem?.source.path, "skills/planning");
        assert.equal(store.skillInventoryStatus(), null);
      } finally {
        dispose();
      }
    });
  });
});
