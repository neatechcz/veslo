import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import type { LocalSkillCard, LocalSkillListScope, WorkspaceInfo } from "../lib/tauri";
import { buildSkillInventory } from "../lib/skill-inventory.js";
import { filterSkillInventoryItems } from "../lib/skill-inventory-filters.js";

const { createExtensionsStore } = await import("./extensions.js");

const createDenAuthJson = (
  input: {
    denApiBase?: string;
    token?: string;
    orgId?: string;
    userId?: string;
  } = {},
) => {
  const token = input.token ?? "den-token";
  const orgId = input.orgId ?? "org-1";
  const userId = input.userId ?? "user-1";
  return JSON.stringify({
    denApiBase: input.denApiBase ?? "https://api.veslo.test",
    token,
    orgId,
    user: { id: userId },
    org: { id: orgId },
  });
};

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

async function withDenAuthStorage(run: (storage: { localStorage: Storage; sessionStorage: Storage }) => Promise<void>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const localStorage = createMemoryStorage();
  const sessionStorage = createMemoryStorage({ "veslo.den.auth": createDenAuthJson() });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      sessionStorage,
    },
  });

  try {
    await run({ localStorage, sessionStorage });
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

const remoteWorkspace: WorkspaceInfo = {
  id: "ws-remote",
  name: "Remote Workspace",
  displayName: "Remote Label",
  path: "/workspaces/remote",
  preset: "server",
  workspaceType: "remote",
};

const hubSkill = (name: string) => ({
  name,
  description: `${name} from hub`,
  trigger: `${name} trigger`,
  source: {
    owner: "neatech",
    repo: "veslo-skills",
    ref: "main",
    path: `skills/${name}`,
  },
});

test("skill inventory preserves removed lifecycle metadata and filters removed rows by default", () => {
  const items = buildSkillInventory({
    globalSkills: [
      {
        name: "legacy-review",
        path: "/Users/example/.opencode/skills/legacy-review/SKILL.md",
        scope: "organization",
        lifecycle: "removed",
        removedAt: "2026-05-31T10:00:00.000Z",
        removedBy: "user-1",
        removeReason: "cleanup",
        registry: {
          skillId: "skill_1",
          installationId: "install_1",
          policyId: "policy_1",
          versionId: "version_1",
          packageSha256: "sha_1",
          source: "organization",
          removalPolicy: "admin_removable",
        },
        restoreTarget: {
          scope: "organization",
          orgId: "org-1",
        },
      },
    ],
    workspaceSkillsByWorkspaceId: {},
    hubSkills: [],
  });

  const [item] = items;
  assert.equal(item?.globalInstance?.scope, "organization");
  assert.equal(item?.globalInstance?.lifecycle, "removed");
  assert.equal(item?.globalInstance?.removedAt, "2026-05-31T10:00:00.000Z");
  assert.equal(item?.globalInstance?.removedBy, "user-1");
  assert.equal(item?.globalInstance?.removeReason, "cleanup");
  assert.equal(item?.globalInstance?.registry?.installationId, "install_1");
  assert.equal(item?.globalInstance?.registry?.policyId, "policy_1");
  assert.equal(item?.globalInstance?.registry?.source, "organization");
  assert.deepEqual(item?.globalInstance?.restoreTarget, {
    scope: "organization",
    orgId: "org-1",
  });
  assert.equal(item?.globalInstance?.writable, false);

  assert.equal(filterSkillInventoryItems(items, { includeDeleted: false }).length, 0);
  assert.equal(filterSkillInventoryItems(items, { includeDeleted: true }).length, 1);
});

test("skill inventory does not report removed installs as installed when hub entries remain visible", () => {
  const items = buildSkillInventory({
    globalSkills: [
      {
        name: "legacy-global",
        path: "/Users/example/.opencode/skills/legacy-global/SKILL.md",
        scope: "user-global",
        lifecycle: "removed",
      },
    ],
    workspaceSkillsByWorkspaceId: {
      "ws-alpha": {
        workspace: { id: "ws-alpha", label: "Alpha", kind: "local" },
        skills: [
          {
            name: "legacy-workspace",
            path: "/workspaces/alpha/.opencode/skills/legacy-workspace/SKILL.md",
            scope: "workspace",
            lifecycle: "removed",
          },
        ],
      },
    },
    hubSkills: [hubSkill("legacy-global"), hubSkill("legacy-workspace")],
  });

  const filtered = filterSkillInventoryItems(items, { includeDeleted: false });

  assert.deepEqual(
    filtered.map((item) => ({
      name: item.name,
      status: item.status,
      hasGlobal: Boolean(item.globalInstance),
      workspaceCount: item.workspaceInstances.length,
      hasHub: Boolean(item.hubItem),
    })),
    [
      {
        name: "legacy-global",
        status: "hub-only",
        hasGlobal: false,
        workspaceCount: 0,
        hasHub: true,
      },
      {
        name: "legacy-workspace",
        status: "hub-only",
        hasGlobal: false,
        workspaceCount: 0,
        hasHub: true,
      },
    ],
  );
});

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
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [...workspaces, remoteWorkspace],
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

test("skill inventory includes extra selected-session workspace directories", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      const localCalls: Array<{ projectDir: string; scope: LocalSkillListScope }> = [];
      const listLocalSkillsScoped = async (
        projectDir: string,
        scope: LocalSkillListScope,
      ): Promise<LocalSkillCard[]> => {
        localCalls.push({ projectDir, scope });
        if (scope === "global") {
          return [{ name: "global-helper", path: "/Users/example/.opencode/skills/global-helper/SKILL.md" }];
        }
        if (projectDir === "/workspaces/session-only") {
          return [{
            name: "session-workspace-helper",
            path: "/workspaces/session-only/.opencode/skills/session-workspace-helper/SKILL.md",
          }];
        }
        return [];
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [workspaces[0]],
          extraSkillInventoryWorkspaces: () => [{
            id: "session:/workspaces/session-only",
            label: "Session Only",
            path: "/workspaces/session-only",
          }],
          vesloServerClient: () => null,
          vesloServerStatus: () => "disconnected",
          vesloServerCapabilities: () => null,
          vesloServerWorkspaceId: () => null,
          listLocalSkillsScoped,
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });

        assert.deepEqual(localCalls, [
          { projectDir: "", scope: "global" },
          { projectDir: "/workspaces/alpha", scope: "workspace" },
          { projectDir: "/workspaces/session-only", scope: "workspace" },
        ]);
        const item = store.skillInventory().find((entry) => entry.name === "session-workspace-helper");
        assert.equal(item?.workspaceInstances[0]?.workspaceId, "session:/workspaces/session-only");
        assert.equal(item?.workspaceInstances[0]?.workspaceLabel, "Session Only");
      } finally {
        dispose();
      }
    });
  });
});

test("skill inventory refreshes hub entries when the Veslo server client changes", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      const hubCalls: string[] = [];
      const clientA = {
        async listHubSkills() {
          hubCalls.push("client-a");
          return { items: [hubSkill("planning-client-a")] };
        },
      };
      const clientB = {
        async listHubSkills() {
          hubCalls.push("client-b");
          return { items: [hubSkill("planning-client-b")] };
        },
      };
      let activeClient: typeof clientA | typeof clientB = clientA;

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [],
          vesloServerClient: () => activeClient as never,
          vesloServerStatus: () => "connected",
          vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
          vesloServerWorkspaceId: () => "ws-alpha",
          listLocalSkillsScoped: async () => [],
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });
        assert.equal(store.skillInventory().some((item) => item.name === "planning-client-a"), true);

        activeClient = clientB;
        await store.refreshSkillInventory();

        assert.deepEqual(hubCalls, ["client-a", "client-b"]);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-client-a"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-client-b"), true);
      } finally {
        dispose();
      }
    });
  });
});

test("skill inventory retries after a failed forced refresh", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      let failGlobalRead = false;
      const listLocalSkillsScoped = async (
        projectDir: string,
        scope: LocalSkillListScope,
      ): Promise<LocalSkillCard[]> => {
        if (scope === "global") {
          if (failGlobalRead) throw new Error("global read failed");
          return [{ name: "research", path: "/Users/example/.opencode/skills/research/SKILL.md" }];
        }
        return projectDir ? [] : [];
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [],
          vesloServerClient: () => null,
          vesloServerStatus: () => "disconnected",
          vesloServerCapabilities: () => null,
          vesloServerWorkspaceId: () => null,
          listLocalSkillsScoped,
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });
        assert.equal(store.skillInventory().some((item) => item.name === "research"), true);

        failGlobalRead = true;
        await store.refreshSkillInventory({ force: true });
        assert.deepEqual(store.skillInventory(), []);
        assert.equal(store.skillInventoryStatus(), "global read failed");

        failGlobalRead = false;
        await store.refreshSkillInventory();

        assert.equal(store.skillInventoryStatus(), null);
        assert.equal(store.skillInventory().some((item) => item.name === "research"), true);
      } finally {
        dispose();
      }
    });
  });
});

test("skill inventory settles with local-only inventory when hub refresh fails", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      let hubCallCount = 0;
      const vesloServerClient = {
        async listHubSkills() {
          hubCallCount += 1;
          await new Promise((resolveTick) => setTimeout(resolveTick, 0));
          throw new Error("Hub unavailable");
        },
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [],
        vesloServerClient: () => vesloServerClient as never,
        vesloServerStatus: () => "connected",
        vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
        vesloServerWorkspaceId: () => "ws-alpha",
        listLocalSkillsScoped: async (_projectDir, scope) =>
          scope === "global"
            ? [{ name: "research", path: "/Users/example/.opencode/skills/research/SKILL.md" }]
            : [],
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      const refresh = store.refreshSkillInventory({ force: true });
      try {
        const result = await Promise.race([
          refresh.then(() => "settled" as const),
          new Promise<"timeout">((resolve) => setTimeout(resolve, 100, "timeout")),
        ]);

        if (result === "timeout") {
          store.abortRefreshes();
          await refresh.catch(() => undefined);
          assert.fail(`skill inventory refresh did not settle after ${hubCallCount} hub calls`);
        }

        assert.equal(hubCallCount, 1);
        assert.equal(store.skillInventory().some((item) => item.name === "research"), true);
        assert.match(store.skillInventoryStatus() ?? "", /Hub unavailable/);
      } finally {
        store.abortRefreshes();
        await refresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory settles when hub and local inventory reads both fail", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      let hubCallCount = 0;
      let localCallCount = 0;
      let allowCleanupSuccess = false;
      const vesloServerClient = {
        async listHubSkills() {
          hubCallCount += 1;
          await new Promise((resolveTick) => setTimeout(resolveTick, 0));
          if (allowCleanupSuccess) return { items: [] };
          throw new Error("Hub unavailable");
        },
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [],
        vesloServerClient: () => vesloServerClient as never,
        vesloServerStatus: () => "connected",
        vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
        vesloServerWorkspaceId: () => "ws-alpha",
        listLocalSkillsScoped: async () => {
          localCallCount += 1;
          await new Promise((resolveTick) => setTimeout(resolveTick, 0));
          if (allowCleanupSuccess) return [];
          throw new Error("global read failed");
        },
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      const refresh = store.refreshSkillInventory({ force: true });
      try {
        const result = await Promise.race([
          refresh.then(() => "settled" as const),
          new Promise<"timeout">((resolve) => setTimeout(resolve, 100, "timeout")),
        ]);

        if (result === "timeout") {
          allowCleanupSuccess = true;
          store.abortRefreshes();
          await refresh.catch(() => undefined);
          assert.fail(
            `skill inventory refresh did not settle after ${hubCallCount} hub calls and ${localCallCount} local calls`,
          );
        }

        assert.equal(hubCallCount, 1);
        assert.equal(localCallCount, 1);
        assert.deepEqual(store.skillInventory(), []);
        assert.equal(store.skillInventoryStatus(), "global read failed");
      } finally {
        store.abortRefreshes();
        await refresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory waits for an in-flight hub skill refresh before caching", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      const hubSkillsRelease: { current?: () => void } = {};
      let markHubSkillsStarted: (() => void) | null = null;
      const hubSkillsStarted = new Promise<void>((resolve) => {
        markHubSkillsStarted = resolve;
      });
      const vesloServerClient = {
        async listHubSkills() {
          assert.ok(markHubSkillsStarted);
          markHubSkillsStarted();
          await new Promise<void>((release) => {
            hubSkillsRelease.current = release;
          });
          return { items: [hubSkill("planning")] };
        },
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [],
        vesloServerClient: () => vesloServerClient as never,
        vesloServerStatus: () => "connected",
        vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
        vesloServerWorkspaceId: () => "ws-alpha",
        listLocalSkillsScoped: async () => [],
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      const hubRefresh = store.refreshHubSkills({ force: true });
      try {
        await hubSkillsStarted;
        let inventoryResolved = false;
        const inventoryRefresh = store.refreshSkillInventory({ force: true }).then(() => {
          inventoryResolved = true;
        });

        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        assert.equal(inventoryResolved, false, "inventory refresh should wait for in-flight hub skills");

        const releaseHubSkills = hubSkillsRelease.current;
        assert.ok(releaseHubSkills);
        releaseHubSkills();
        await Promise.all([hubRefresh, inventoryRefresh]);

        assert.equal(store.skillInventory().some((item) => item.name === "planning"), true);
      } finally {
        hubSkillsRelease.current?.();
        await hubRefresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory refresh waits for a same-context hub reload before returning cached inventory", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      const hubSkillsRelease: { current?: () => void } = {};
      let hubCallCount = 0;
      let markSecondHubSkillsStarted: (() => void) | null = null;
      const secondHubSkillsStarted = new Promise<void>((resolve) => {
        markSecondHubSkillsStarted = resolve;
      });
      const vesloServerClient = {
        async listHubSkills() {
          hubCallCount += 1;
          const callId = hubCallCount;
          if (callId === 2) {
            assert.ok(markSecondHubSkillsStarted);
            markSecondHubSkillsStarted();
            await new Promise<void>((release) => {
              hubSkillsRelease.current = release;
            });
          }
          return { items: [hubSkill(`planning-${callId}`)] };
        },
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [],
        vesloServerClient: () => vesloServerClient as never,
        vesloServerStatus: () => "connected",
        vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
        vesloServerWorkspaceId: () => "ws-alpha",
        listLocalSkillsScoped: async () => [],
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      await store.refreshSkillInventory({ force: true });
      assert.equal(store.skillInventory().some((item) => item.name === "planning-1"), true);

      const hubRefresh = store.refreshHubSkills({ force: true });
      try {
        await secondHubSkillsStarted;
        let inventoryResolved = false;
        const inventoryRefresh = store.refreshSkillInventory().then(() => {
          inventoryResolved = true;
        });

        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        assert.equal(inventoryResolved, false, "cached inventory refresh should wait for in-flight hub reload");

        const releaseHubSkills = hubSkillsRelease.current;
        assert.ok(releaseHubSkills);
        releaseHubSkills();
        await Promise.all([hubRefresh, inventoryRefresh]);

        assert.equal(hubCallCount, 2);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-2"), true);
      } finally {
        hubSkillsRelease.current?.();
        await hubRefresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory rebuilds after a completed same-context hub reload", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      let hubCallCount = 0;
      const vesloServerClient = {
        async listHubSkills() {
          hubCallCount += 1;
          return { items: [hubSkill(`planning-${hubCallCount}`)] };
        },
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [],
          vesloServerClient: () => vesloServerClient as never,
          vesloServerStatus: () => "connected",
          vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
          vesloServerWorkspaceId: () => "ws-alpha",
          listLocalSkillsScoped: async () => [],
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });
        assert.equal(store.skillInventory().some((item) => item.name === "planning-1"), true);

        await store.refreshHubSkills({ force: true });
        await store.refreshSkillInventory();

        assert.equal(hubCallCount, 2);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-2"), true);
      } finally {
        dispose();
      }
    });
  });
});

test("skill inventory rebuilds after active local skills refresh changes local source data", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      let globalSkillVersion = 1;
      const listLocalSkillsScoped = async (
        projectDir: string,
        scope: LocalSkillListScope,
      ): Promise<LocalSkillCard[]> => {
        if (scope === "global") {
          return [
            {
              name: `research-${globalSkillVersion}`,
              path: `/Users/example/.opencode/skills/research-${globalSkillVersion}/SKILL.md`,
            },
          ];
        }
        return projectDir ? [] : [];
      };
      const vesloServerClient = {
        async listSkills() {
          return { items: [] };
        },
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [],
          vesloServerClient: () => vesloServerClient as never,
          vesloServerStatus: () => "connected",
          vesloServerCapabilities: () =>
            ({
              skills: { read: true },
              hub: { skills: { read: false } },
            }) as never,
          vesloServerWorkspaceId: () => "ws-alpha",
          listLocalSkillsScoped,
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });
        assert.equal(store.skillInventory().some((item) => item.name === "research-1"), true);

        globalSkillVersion = 2;
        await store.refreshSkills({ force: true });
        await store.refreshSkillInventory();

        assert.equal(store.skillInventory().some((item) => item.name === "research-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "research-2"), true);
      } finally {
        dispose();
      }
    });
  });
});

test("concurrent skill inventory refresh callers await the in-flight refresh", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      const globalSkillsRelease: { current?: () => void } = {};
      let markGlobalSkillsStarted: (() => void) | null = null;
      const globalSkillsStarted = new Promise<void>((resolve) => {
        markGlobalSkillsStarted = resolve;
      });
      const listLocalSkillsScoped = async (
        projectDir: string,
        scope: LocalSkillListScope,
      ): Promise<LocalSkillCard[]> => {
        if (scope === "global") {
          assert.ok(markGlobalSkillsStarted);
          markGlobalSkillsStarted();
          await new Promise<void>((release) => {
            globalSkillsRelease.current = release;
          });
          return [{ name: "research", path: "/Users/example/.opencode/skills/research/SKILL.md" }];
        }
        return projectDir ? [] : [];
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [],
        vesloServerClient: () => null,
        vesloServerStatus: () => "disconnected",
        vesloServerCapabilities: () => null,
        vesloServerWorkspaceId: () => null,
        listLocalSkillsScoped,
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      const firstRefresh = store.refreshSkillInventory({ force: true });
      try {
        await globalSkillsStarted;

        let secondResolved = false;
        const secondRefresh = store.refreshSkillInventory().then(() => {
          secondResolved = true;
        });

        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        assert.equal(secondResolved, false, "second inventory refresh should await the first refresh");

        const releaseGlobalSkills = globalSkillsRelease.current;
        assert.ok(releaseGlobalSkills);
        releaseGlobalSkills();
        await Promise.all([firstRefresh, secondRefresh]);

        assert.equal(secondResolved, true);
        assert.equal(store.skillInventory().some((item) => item.name === "research"), true);
      } finally {
        globalSkillsRelease.current?.();
        await firstRefresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory reruns after Den auth changes while an inventory refresh is in flight", async () => {
  await withDenAuthStorage(async ({ localStorage, sessionStorage }) => {
    await createRoot(async (dispose) => {
      const initialAuth = createDenAuthJson({ orgId: "org-1", token: "token-a" });
      localStorage.setItem("veslo.den.auth", initialAuth);
      sessionStorage.setItem("veslo.den.auth", initialAuth);

      const hubCalls: Array<{ orgId: string; token: string }> = [];
      const globalSkillsRelease: { current?: () => void } = {};
      let globalReadCount = 0;
      let markGlobalSkillsStarted: (() => void) | null = null;
      const globalSkillsStarted = new Promise<void>((resolve) => {
        markGlobalSkillsStarted = resolve;
      });
      const vesloServerClient = {
        async listHubSkills(input: { denToken: string; denOrgId: string }) {
          hubCalls.push({ orgId: input.denOrgId, token: input.denToken });
          return { items: [hubSkill(`planning-${input.denOrgId}`)] };
        },
      };
      const listLocalSkillsScoped = async (
        projectDir: string,
        scope: LocalSkillListScope,
      ): Promise<LocalSkillCard[]> => {
        if (scope === "global") {
          globalReadCount += 1;
          if (globalReadCount === 1) {
            assert.ok(markGlobalSkillsStarted);
            markGlobalSkillsStarted();
            await new Promise<void>((release) => {
              globalSkillsRelease.current = release;
            });
          }
          return [];
        }
        return projectDir ? [] : [];
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [],
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

      const firstRefresh = store.refreshSkillInventory({ force: true });
      try {
        await globalSkillsStarted;

        const nextAuth = createDenAuthJson({ orgId: "org-2", token: "token-b" });
        localStorage.setItem("veslo.den.auth", nextAuth);
        sessionStorage.setItem("veslo.den.auth", nextAuth);

        let secondResolved = false;
        const secondRefresh = store.refreshSkillInventory().then(() => {
          secondResolved = true;
        });

        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        assert.equal(secondResolved, false, "second inventory refresh should wait for current context");

        const releaseGlobalSkills = globalSkillsRelease.current;
        assert.ok(releaseGlobalSkills);
        releaseGlobalSkills();
        await Promise.all([firstRefresh, secondRefresh]);

        assert.deepEqual(hubCalls, [
          { orgId: "org-1", token: "token-a" },
          { orgId: "org-2", token: "token-b" },
        ]);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-org-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-org-2"), true);
      } finally {
        globalSkillsRelease.current?.();
        await firstRefresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory reruns after local source revision changes while an inventory refresh is in flight", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      let globalSkillVersion = 1;
      const inventoryReads: string[] = [];
      const workspaceSkillsRelease: { current?: () => void } = {};
      let markWorkspaceSkillsStarted: (() => void) | null = null;
      const workspaceSkillsStarted = new Promise<void>((resolve) => {
        markWorkspaceSkillsStarted = resolve;
      });
      const listLocalSkillsScoped = async (
        projectDir: string,
        scope: LocalSkillListScope,
      ): Promise<LocalSkillCard[]> => {
        if (scope === "global") {
          inventoryReads.push(`global-${globalSkillVersion}`);
          return [
            {
              name: `research-${globalSkillVersion}`,
              path: `/Users/example/.opencode/skills/research-${globalSkillVersion}/SKILL.md`,
            },
          ];
        }
        if (projectDir === "/workspaces/alpha") {
          inventoryReads.push(`workspace-${globalSkillVersion}`);
          if (inventoryReads.filter((entry) => entry.startsWith("workspace-")).length === 1) {
            assert.ok(markWorkspaceSkillsStarted);
            markWorkspaceSkillsStarted();
            await new Promise<void>((release) => {
              workspaceSkillsRelease.current = release;
            });
          }
        }
        return [];
      };
      const vesloServerClient = {
        async listSkills() {
          return { items: [] };
        },
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [workspaces[0] as WorkspaceInfo],
        vesloServerClient: () => vesloServerClient as never,
        vesloServerStatus: () => "connected",
        vesloServerCapabilities: () =>
          ({
            skills: { read: true },
            hub: { skills: { read: false } },
          }) as never,
        vesloServerWorkspaceId: () => "ws-alpha",
        listLocalSkillsScoped,
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      const firstRefresh = store.refreshSkillInventory({ force: true });
      try {
        await workspaceSkillsStarted;

        globalSkillVersion = 2;
        await store.refreshSkills({ force: true });

        let secondResolved = false;
        const secondRefresh = store.refreshSkillInventory().then(() => {
          secondResolved = true;
        });

        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        assert.equal(secondResolved, false, "second inventory refresh should wait for the new local source revision");

        const releaseWorkspaceSkills = workspaceSkillsRelease.current;
        assert.ok(releaseWorkspaceSkills);
        releaseWorkspaceSkills();
        await Promise.all([firstRefresh, secondRefresh]);

        assert.deepEqual(inventoryReads, ["global-1", "workspace-1", "global-2", "workspace-2"]);
        assert.equal(store.skillInventory().some((item) => item.name === "research-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "research-2"), true);
      } finally {
        workspaceSkillsRelease.current?.();
        await firstRefresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory reruns after a failed in-flight refresh when workspace context changes", async () => {
  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      let activeWorkspaces: WorkspaceInfo[] = [workspaces[0] as WorkspaceInfo];
      const reads: string[] = [];
      const alphaWorkspaceRelease: { current?: () => void } = {};
      let markAlphaWorkspaceStarted: (() => void) | null = null;
      const alphaWorkspaceStarted = new Promise<void>((resolve) => {
        markAlphaWorkspaceStarted = resolve;
      });
      const listLocalSkillsScoped = async (
        projectDir: string,
        scope: LocalSkillListScope,
      ): Promise<LocalSkillCard[]> => {
        reads.push(`${scope}:${projectDir}`);
        if (scope === "global") {
          return [];
        }
        if (projectDir === "/workspaces/alpha") {
          assert.ok(markAlphaWorkspaceStarted);
          markAlphaWorkspaceStarted();
          await new Promise<void>((release) => {
            alphaWorkspaceRelease.current = release;
          });
          throw new Error("alpha workspace read failed");
        }
        if (projectDir === "/workspaces/beta") {
          return [{ name: "beta-skill", path: "/workspaces/beta/.opencode/skills/beta-skill/SKILL.md" }];
        }
        return [];
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => activeWorkspaces,
        vesloServerClient: () => null,
        vesloServerStatus: () => "disconnected",
        vesloServerCapabilities: () => null,
        vesloServerWorkspaceId: () => null,
        listLocalSkillsScoped,
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      const firstRefresh = store.refreshSkillInventory({ force: true });
      try {
        await alphaWorkspaceStarted;

        activeWorkspaces = [workspaces[1] as WorkspaceInfo];
        const secondRefresh = store.refreshSkillInventory();

        const releaseAlphaWorkspace = alphaWorkspaceRelease.current;
        assert.ok(releaseAlphaWorkspace);
        releaseAlphaWorkspace();
        await Promise.all([firstRefresh, secondRefresh]);

        assert.deepEqual(reads, [
          "global:",
          "workspace:/workspaces/alpha",
          "global:",
          "workspace:/workspaces/beta",
        ]);
        assert.equal(store.skillInventoryStatus(), null);
        assert.equal(store.skillInventory().some((item) => item.name === "beta-skill"), true);
      } finally {
        alphaWorkspaceRelease.current?.();
        await firstRefresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory does not cache hub skills from an in-flight refresh after Den auth changes", async () => {
  await withDenAuthStorage(async ({ localStorage, sessionStorage }) => {
    await createRoot(async (dispose) => {
      const hubCalls: string[] = [];
      const hubSkillsRelease: { current?: () => void } = {};
      let markHubSkillsStarted: (() => void) | null = null;
      const hubSkillsStarted = new Promise<void>((resolve) => {
        markHubSkillsStarted = resolve;
      });
      const vesloServerClient = {
        async listHubSkills(input: { denOrgId: string }) {
          hubCalls.push(input.denOrgId);
          if (input.denOrgId === "org-1") {
            assert.ok(markHubSkillsStarted);
            markHubSkillsStarted();
            await new Promise<void>((release) => {
              hubSkillsRelease.current = release;
            });
          }
          return { items: [hubSkill(`planning-${input.denOrgId}`)] };
        },
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [],
        vesloServerClient: () => vesloServerClient as never,
        vesloServerStatus: () => "connected",
        vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
        vesloServerWorkspaceId: () => "ws-alpha",
        listLocalSkillsScoped: async () => [],
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      const hubRefresh = store.refreshHubSkills({ force: true });
      try {
        await hubSkillsStarted;

        const nextAuth = createDenAuthJson({ orgId: "org-2" });
        localStorage.setItem("veslo.den.auth", nextAuth);
        sessionStorage.setItem("veslo.den.auth", nextAuth);

        const inventoryRefresh = store.refreshSkillInventory();
        await new Promise((resolveTick) => setTimeout(resolveTick, 0));

        const releaseHubSkills = hubSkillsRelease.current;
        assert.ok(releaseHubSkills);
        releaseHubSkills();
        await Promise.all([hubRefresh, inventoryRefresh]);

        assert.deepEqual(hubCalls, ["org-1", "org-2"]);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-org-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-org-2"), true);
      } finally {
        hubSkillsRelease.current?.();
        await hubRefresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory invalidates cached hub entries when Den auth context changes", async () => {
  await withDenAuthStorage(async ({ localStorage, sessionStorage }) => {
    await createRoot(async (dispose) => {
      const hubCalls: string[] = [];
      const vesloServerClient = {
        async listHubSkills(input: { denOrgId: string }) {
          hubCalls.push(input.denOrgId);
          return { items: [hubSkill(`planning-${input.denOrgId}`)] };
        },
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [],
          vesloServerClient: () => vesloServerClient as never,
          vesloServerStatus: () => "connected",
          vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
          vesloServerWorkspaceId: () => "ws-alpha",
          listLocalSkillsScoped: async () => [],
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });
        assert.equal(store.skillInventory().some((item) => item.name === "planning-org-1"), true);

        const nextAuth = createDenAuthJson({ orgId: "org-2" });
        localStorage.setItem("veslo.den.auth", nextAuth);
        sessionStorage.setItem("veslo.den.auth", nextAuth);
        await store.refreshSkillInventory();

        assert.deepEqual(hubCalls, ["org-1", "org-2"]);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-org-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-org-2"), true);
      } finally {
        dispose();
      }
    });
  });
});

test("skill inventory invalidates cached hub entries when the Den token changes for the same org", async () => {
  await withDenAuthStorage(async ({ localStorage, sessionStorage }) => {
    await createRoot(async (dispose) => {
      const initialAuth = createDenAuthJson({ token: "token-a" });
      localStorage.setItem("veslo.den.auth", initialAuth);
      sessionStorage.setItem("veslo.den.auth", initialAuth);

      const hubCalls: string[] = [];
      const vesloServerClient = {
        async listHubSkills(input: { denToken: string; denOrgId: string }) {
          assert.equal(input.denOrgId, "org-1");
          hubCalls.push(input.denToken);
          return { items: [hubSkill(`planning-${input.denToken}`)] };
        },
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [],
          vesloServerClient: () => vesloServerClient as never,
          vesloServerStatus: () => "connected",
          vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
          vesloServerWorkspaceId: () => "ws-alpha",
          listLocalSkillsScoped: async () => [],
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });
        assert.equal(store.skillInventory().some((item) => item.name === "planning-token-a"), true);

        const nextAuth = createDenAuthJson({ token: "token-b" });
        localStorage.setItem("veslo.den.auth", nextAuth);
        sessionStorage.setItem("veslo.den.auth", nextAuth);
        await store.refreshSkillInventory();

        assert.deepEqual(hubCalls, ["token-a", "token-b"]);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-token-a"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-token-b"), true);
      } finally {
        dispose();
      }
    });
  });
});

test("skill inventory does not cache hub skills from an in-flight refresh after the Den token changes", async () => {
  await withDenAuthStorage(async ({ localStorage, sessionStorage }) => {
    await createRoot(async (dispose) => {
      const initialAuth = createDenAuthJson({ token: "token-a" });
      localStorage.setItem("veslo.den.auth", initialAuth);
      sessionStorage.setItem("veslo.den.auth", initialAuth);

      const hubCalls: string[] = [];
      const hubSkillsRelease: { current?: () => void } = {};
      let markHubSkillsStarted: (() => void) | null = null;
      const hubSkillsStarted = new Promise<void>((resolve) => {
        markHubSkillsStarted = resolve;
      });
      const vesloServerClient = {
        async listHubSkills(input: { denToken: string; denOrgId: string }) {
          assert.equal(input.denOrgId, "org-1");
          hubCalls.push(input.denToken);
          if (input.denToken === "token-a") {
            assert.ok(markHubSkillsStarted);
            markHubSkillsStarted();
            await new Promise<void>((release) => {
              hubSkillsRelease.current = release;
            });
          }
          return { items: [hubSkill(`planning-${input.denToken}`)] };
        },
      };

      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        workspaces: () => [],
        vesloServerClient: () => vesloServerClient as never,
        vesloServerStatus: () => "connected",
        vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
        vesloServerWorkspaceId: () => "ws-alpha",
        listLocalSkillsScoped: async () => [],
        setBusy: () => undefined,
        setBusyLabel: () => undefined,
        setBusyStartedAt: () => undefined,
        setError: () => undefined,
      });

      const hubRefresh = store.refreshHubSkills({ force: true });
      try {
        await hubSkillsStarted;

        const nextAuth = createDenAuthJson({ token: "token-b" });
        localStorage.setItem("veslo.den.auth", nextAuth);
        sessionStorage.setItem("veslo.den.auth", nextAuth);

        const inventoryRefresh = store.refreshSkillInventory();
        await new Promise((resolveTick) => setTimeout(resolveTick, 0));

        const releaseHubSkills = hubSkillsRelease.current;
        assert.ok(releaseHubSkills);
        releaseHubSkills();
        await Promise.all([hubRefresh, inventoryRefresh]);

        assert.deepEqual(hubCalls, ["token-a", "token-b"]);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-token-a"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-token-b"), true);
      } finally {
        hubSkillsRelease.current?.();
        await hubRefresh.catch(() => undefined);
        dispose();
      }
    });
  });
});

test("skill inventory invalidates cached hub entries when the Den API base changes", async () => {
  await withDenAuthStorage(async ({ localStorage, sessionStorage }) => {
    await createRoot(async (dispose) => {
      const initialAuth = createDenAuthJson({
        denApiBase: "https://api-a.veslo.test",
        token: "token-a",
      });
      localStorage.setItem("veslo.den.auth", initialAuth);
      sessionStorage.setItem("veslo.den.auth", initialAuth);

      const hubCalls: string[] = [];
      const vesloServerClient = {
        async listHubSkills() {
          const callId = `call-${hubCalls.length + 1}`;
          hubCalls.push(callId);
          return { items: [hubSkill(`planning-${callId}`)] };
        },
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [],
          vesloServerClient: () => vesloServerClient as never,
          vesloServerStatus: () => "connected",
          vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
          vesloServerWorkspaceId: () => "ws-alpha",
          listLocalSkillsScoped: async () => [],
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });
        assert.equal(store.skillInventory().some((item) => item.name === "planning-call-1"), true);

        const nextAuth = createDenAuthJson({
          denApiBase: "https://api-b.veslo.test",
          token: "token-a",
        });
        localStorage.setItem("veslo.den.auth", nextAuth);
        sessionStorage.setItem("veslo.den.auth", nextAuth);
        await store.refreshSkillInventory();

        assert.deepEqual(hubCalls, ["call-1", "call-2"]);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-call-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-call-2"), true);
      } finally {
        dispose();
      }
    });
  });
});

test("skill inventory invalidates cached hub entries when the Den user changes for the same org and token", async () => {
  await withDenAuthStorage(async ({ localStorage, sessionStorage }) => {
    await createRoot(async (dispose) => {
      const initialAuth = createDenAuthJson({
        token: "token-a",
        userId: "user-a",
      });
      localStorage.setItem("veslo.den.auth", initialAuth);
      sessionStorage.setItem("veslo.den.auth", initialAuth);

      const hubCalls: string[] = [];
      const vesloServerClient = {
        async listHubSkills(input: { denToken: string; denOrgId: string }) {
          assert.deepEqual(input, { denToken: "token-a", denOrgId: "org-1" });
          const callId = `call-${hubCalls.length + 1}`;
          hubCalls.push(callId);
          return { items: [hubSkill(`planning-${callId}`)] };
        },
      };

      try {
        const store = createExtensionsStore({
          client: () => null,
          projectDir: () => "/workspaces/alpha",
          activeWorkspaceId: () => "ws-alpha",
          activeWorkspaceRoot: () => "/workspaces/alpha",
          workspaceType: () => "local",
          workspaces: () => [],
          vesloServerClient: () => vesloServerClient as never,
          vesloServerStatus: () => "connected",
          vesloServerCapabilities: () => ({ hub: { skills: { read: true } } }) as never,
          vesloServerWorkspaceId: () => "ws-alpha",
          listLocalSkillsScoped: async () => [],
          setBusy: () => undefined,
          setBusyLabel: () => undefined,
          setBusyStartedAt: () => undefined,
          setError: () => undefined,
        });

        await store.refreshSkillInventory({ force: true });
        assert.equal(store.skillInventory().some((item) => item.name === "planning-call-1"), true);

        const nextAuth = createDenAuthJson({
          token: "token-a",
          userId: "user-b",
        });
        localStorage.setItem("veslo.den.auth", nextAuth);
        sessionStorage.setItem("veslo.den.auth", nextAuth);
        await store.refreshSkillInventory();

        assert.deepEqual(hubCalls, ["call-1", "call-2"]);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-call-1"), false);
        assert.equal(store.skillInventory().some((item) => item.name === "planning-call-2"), true);
      } finally {
        dispose();
      }
    });
  });
});
