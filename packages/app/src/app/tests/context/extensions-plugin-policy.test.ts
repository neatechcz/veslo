import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import type { PluginInventoryCard } from "../../types";

const { createExtensionsStore } = await import("../../context/extensions.js");

const SCHEDULER_PLUGIN: PluginInventoryCard = {
  id: "platform.opencode-scheduler",
  spec: "opencode-scheduler",
  displayName: "OpenCode Scheduler",
  scope: "platform",
  enabled: true,
  lifecycle: "active",
  managed: true,
  visibility: "hidden-debug-only",
  removalPolicy: "locked",
  enabledPolicy: "locked-on",
  activationPhase: "background-runtime",
  coldStartCritical: false,
  requiresEngineRestart: true,
  debugOnly: true,
};

const SUPERPOWERS_PLUGIN: PluginInventoryCard = {
  id: "platform.superpowers",
  spec: "superpowers@git+https://github.com/obra/superpowers.git",
  displayName: "Superpowers",
  scope: "platform",
  enabled: true,
  lifecycle: "active",
  managed: true,
  visibility: "visible",
  removalPolicy: "user-removable",
  enabledPolicy: "user-toggleable",
  activationPhase: "startup",
  coldStartCritical: true,
  requiresEngineRestart: true,
};

const PROJECT_PLUGIN: PluginInventoryCard = {
  id: "config.project.opencode-wakatime",
  spec: "opencode-wakatime",
  displayName: "opencode-wakatime",
  scope: "project",
  enabled: true,
  lifecycle: "active",
  managed: false,
  visibility: "visible",
  removalPolicy: "user-removable",
  enabledPolicy: "user-toggleable",
};

type PluginCalls = {
  list: Array<{ workspaceId: string; options: { includeGlobal?: boolean; debug?: boolean } | undefined }>;
  setEnabled: Array<{ workspaceId: string; pluginId: string; enabled: boolean }>;
  removeManaged: Array<{ workspaceId: string; pluginId: string }>;
  restore: Array<{ workspaceId: string; pluginId: string }>;
  add: Array<{ workspaceId: string; spec: string }>;
  remove: Array<{ workspaceId: string; name: string }>;
};

function clonePlugin(plugin: PluginInventoryCard): PluginInventoryCard {
  return { ...plugin };
}

function makePluginClient(
  calls: PluginCalls,
  options: { initialInventory?: PluginInventoryCard[]; beforeList?: (callIndex: number) => Promise<void> } = {},
) {
  let inventory = (options.initialInventory ?? [SCHEDULER_PLUGIN, SUPERPOWERS_PLUGIN, PROJECT_PLUGIN]).map(clonePlugin);

  const beforeList = options.beforeList;
  const listResponse = (listOptions?: { includeGlobal?: boolean; debug?: boolean }) => {
    const visibleInventory = inventory.filter(
      (item) => listOptions?.debug || item.visibility !== "hidden-debug-only",
    );
    return {
      items: inventory
        .filter((item) => !item.managed && item.scope === "project")
        .map((item) => ({ spec: item.spec, source: "config", scope: "project" })),
      inventory: visibleInventory.map(clonePlugin),
      loadOrder: inventory.filter((item) => item.lifecycle === "active").map((item) => item.spec),
    };
  };

  return {
    plugins: {
      async list(workspaceId: string, listOptions?: { includeGlobal?: boolean; debug?: boolean }) {
        calls.list.push({ workspaceId, options: listOptions });
        await beforeList?.(calls.list.length);
        return listResponse(listOptions);
      },
      async setEnabled(workspaceId: string, pluginId: string, enabled: boolean) {
        calls.setEnabled.push({ workspaceId, pluginId, enabled });
        inventory = inventory.map((item) =>
          item.id === pluginId
            ? {
                ...item,
                enabled,
                lifecycle: enabled ? "active" : "disabled",
              }
            : item,
        );
        return { item: clonePlugin(inventory.find((item) => item.id === pluginId) ?? SUPERPOWERS_PLUGIN) };
      },
      async removeManaged(workspaceId: string, pluginId: string) {
        calls.removeManaged.push({ workspaceId, pluginId });
        inventory = inventory.map((item) =>
          item.id === pluginId
            ? {
                ...item,
                enabled: false,
                lifecycle: "removed",
              }
            : item,
        );
        return { item: clonePlugin(inventory.find((item) => item.id === pluginId) ?? SUPERPOWERS_PLUGIN) };
      },
      async restore(workspaceId: string, pluginId: string) {
        calls.restore.push({ workspaceId, pluginId });
        inventory = inventory.map((item) =>
          item.id === pluginId
            ? {
                ...item,
                enabled: true,
                lifecycle: "active",
              }
            : item,
        );
        return { item: clonePlugin(inventory.find((item) => item.id === pluginId) ?? SUPERPOWERS_PLUGIN) };
      },
      async add(workspaceId: string, spec: string) {
        calls.add.push({ workspaceId, spec });
        return listResponse();
      },
      async remove(workspaceId: string, name: string) {
        calls.remove.push({ workspaceId, name });
        return listResponse();
      },
    },
  };
}

async function withPluginStore(
  run: (input: { store: ReturnType<typeof createExtensionsStore>; calls: PluginCalls }) => Promise<void>,
  options: {
    initialInventory?: PluginInventoryCard[];
    vesloServerWorkspaceId?: string | null;
    beforeList?: (callIndex: number) => Promise<void>;
  } = {},
) {
  const calls: PluginCalls = {
    list: [],
    setEnabled: [],
    removeManaged: [],
    restore: [],
    add: [],
    remove: [],
  };
  const vesloServerClient = makePluginClient(calls, {
    initialInventory: options.initialInventory,
    beforeList: options.beforeList,
  });

  await createRoot(async (dispose) => {
    const store = createExtensionsStore({
      client: () => null,
      projectDir: () => "/workspaces/alpha",
      activeWorkspaceId: () => "ws-alpha",
      activeWorkspaceRoot: () => "/workspaces/alpha",
      workspaceType: () => "local",
      vesloServerClient: () => vesloServerClient as never,
      vesloServerStatus: () => "connected",
      vesloServerCapabilities: () => ({ plugins: { read: true, write: true } }) as never,
      vesloServerWorkspaceId: () => options.vesloServerWorkspaceId ?? "ws-alpha",
      setBusy: () => undefined,
      setBusyLabel: () => undefined,
      setBusyStartedAt: () => undefined,
      setError: () => undefined,
    });

    try {
      await run({ store, calls });
    } finally {
      dispose();
    }
  });
}

test("normal refresh hides hidden platform scheduler", async () => {
  await withPluginStore(async ({ store, calls }) => {
    await store.refreshPlugins("project");

    assert.deepEqual(
      store.pluginInventory().map((item) => item.id),
      ["platform.superpowers", "config.project.opencode-wakatime"],
    );
    assert.equal(calls.list[0]?.options?.debug, undefined);
  });
});

test("debug refresh includes hidden platform scheduler", async () => {
  await withPluginStore(async ({ store, calls }) => {
    await store.refreshPlugins("project", { debug: true });

    const scheduler = store.pluginInventory().find((item) => item.id === "platform.opencode-scheduler");
    assert.ok(scheduler);
    assert.equal(scheduler.activationPhase, "background-runtime");
    assert.equal(scheduler.coldStartCritical, false);
    assert.equal(scheduler.requiresEngineRestart, true);
    assert.deepEqual(store.pluginList(), [
      "superpowers@git+https://github.com/obra/superpowers.git",
      "opencode-wakatime",
    ]);
    assert.deepEqual(store.sidebarPluginList(), [
      "superpowers@git+https://github.com/obra/superpowers.git",
      "opencode-wakatime",
    ]);
    assert.equal(store.isPluginInstalledByName("opencode-scheduler"), false);
    assert.equal(calls.list[0]?.options?.debug, true);
  });
});

test("plugin refresh queues latest request while another plugin refresh is in flight", async () => {
  let firstListStarted!: () => void;
  let releaseFirstList!: () => void;
  const firstListStartedPromise = new Promise<void>((resolve) => {
    firstListStarted = resolve;
  });
  const releaseFirstListPromise = new Promise<void>((resolve) => {
    releaseFirstList = resolve;
  });

  await withPluginStore(
    async ({ store, calls }) => {
      const firstRefresh = store.refreshPlugins("project");
      await firstListStartedPromise;

      let queuedRefreshResolved = false;
      const queuedDebugRefresh = store.refreshPlugins("project", { debug: true }).then(() => {
        queuedRefreshResolved = true;
      });

      await Promise.resolve();
      assert.equal(queuedRefreshResolved, false);

      releaseFirstList();
      await queuedDebugRefresh;
      await firstRefresh;

      assert.equal(calls.list.length, 2);
      assert.equal(calls.list[0]?.options?.debug, undefined);
      assert.equal(calls.list[1]?.options?.debug, true);
      assert.ok(store.pluginInventory().some((item) => item.id === "platform.opencode-scheduler"));
    },
    {
      beforeList: async (callIndex) => {
        if (callIndex !== 1) return;
        firstListStarted();
        await releaseFirstListPromise;
      },
    },
  );
});

test("plugin refresh falls back to active workspace id while server workspace id is resolving", async () => {
  await withPluginStore(
    async ({ store, calls }) => {
      await store.refreshPlugins("project");

      assert.equal(calls.list[0]?.workspaceId, "ws-alpha");
      assert.ok(store.pluginInventory().some((item) => item.id === "platform.superpowers"));
    },
    { vesloServerWorkspaceId: null },
  );
});

test("normal refresh after debug clears hidden scheduler from normal active surfaces", async () => {
  await withPluginStore(async ({ store }) => {
    await store.refreshPlugins("project", { debug: true });
    await store.refreshPlugins("project");

    assert.equal(store.pluginInventory().some((item) => item.id === "platform.opencode-scheduler"), false);
    assert.deepEqual(store.pluginList(), [
      "superpowers@git+https://github.com/obra/superpowers.git",
      "opencode-wakatime",
    ]);
    assert.deepEqual(store.sidebarPluginList(), [
      "superpowers@git+https://github.com/obra/superpowers.git",
      "opencode-wakatime",
    ]);
    assert.equal(store.isPluginInstalledByName("opencode-scheduler"), false);
  });
});

test("Superpowers appears as a visible platform plugin", async () => {
  await withPluginStore(async ({ store }) => {
    await store.refreshPlugins("project");

    const superpowers = store.pluginInventory().find((item) => item.id === "platform.superpowers");
    assert.ok(superpowers);
    assert.equal(superpowers.scope, "platform");
    assert.equal(superpowers.visibility, "visible");
    assert.equal(superpowers.managed, true);
    assert.equal(superpowers.lifecycle, "active");
    assert.equal(superpowers.enabled, true);
  });
});

test("disable/remove calls managed policy endpoints for managed plugins", async () => {
  await withPluginStore(async ({ store, calls }) => {
    await store.refreshPlugins("project");

    await store.setPluginEnabled("platform.superpowers", false);
    await store.removeManagedPlugin("platform.superpowers");
    await store.restoreManagedPlugin("platform.superpowers");

    assert.deepEqual(calls.setEnabled, [
      { workspaceId: "ws-alpha", pluginId: "platform.superpowers", enabled: false },
    ]);
    assert.deepEqual(calls.removeManaged, [{ workspaceId: "ws-alpha", pluginId: "platform.superpowers" }]);
    assert.deepEqual(calls.restore, [{ workspaceId: "ws-alpha", pluginId: "platform.superpowers" }]);
    assert.deepEqual(calls.remove, []);
  });
});

test("unmanaged project plugin add/remove still uses legacy spec endpoints", async () => {
  await withPluginStore(async ({ store, calls }) => {
    await store.refreshPlugins("project");

    await store.addPlugin("opencode-wakatime");
    await store.removePlugin("opencode-wakatime");

    assert.deepEqual(calls.add, [{ workspaceId: "ws-alpha", spec: "opencode-wakatime" }]);
    assert.deepEqual(calls.remove, [{ workspaceId: "ws-alpha", name: "opencode-wakatime" }]);
    assert.deepEqual(calls.removeManaged, []);
  });
});

test("isPluginInstalledByName treats policy-managed active plugins as installed", async () => {
  await withPluginStore(async ({ store }) => {
    await store.refreshPlugins("project");

    assert.equal(store.isPluginInstalledByName("superpowers"), true);
  });
});

test("isPluginInstalledByName ignores disabled removed and conflict inventory rows", async () => {
  await withPluginStore(
    async ({ store }) => {
      await store.refreshPlugins("project");

      assert.equal(store.isPluginInstalledByName("disabled-plugin"), false);
      assert.equal(store.isPluginInstalledByName("removed-plugin"), false);
      assert.equal(store.isPluginInstalledByName("conflict-plugin"), false);
    },
    {
      initialInventory: [
        { ...PROJECT_PLUGIN, id: "config.project.disabled-plugin", spec: "disabled-plugin", enabled: false, lifecycle: "disabled" },
        { ...PROJECT_PLUGIN, id: "config.project.removed-plugin", spec: "removed-plugin", enabled: false, lifecycle: "removed" },
        { ...PROJECT_PLUGIN, id: "config.project.conflict-plugin", spec: "conflict-plugin", lifecycle: "conflict" },
      ],
    },
  );
});
