import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import type { LocalSkillCard, LocalSkillListScope, WorkspaceInfo } from "../lib/tauri";

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
