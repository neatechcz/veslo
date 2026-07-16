import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import { createDashboardTabRefreshController } from "../../pages/dashboard-tab-refresh-controller.js";
import type { DashboardTab } from "../../types.js";

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function solidRuntimeSupportsEffects(): boolean {
  let observed = 0;
  createRoot((dispose) => {
    const [value, setValue] = createSignal(0);
    createComputed(() => { observed = value(); });
    setValue(1);
    dispose();
  });
  return observed === 1;
}

const behaviorTestOptions = solidRuntimeSupportsEffects()
  ? {}
  : { skip: "Solid's Node server condition does not run effects; use the test:reactivity script." };

test("dashboard refresh runs once per selected tab and stops after disposal", behaviorTestOptions, async () => {
  await createRoot(async (dispose) => {
    const [tab, setTab] = createSignal<DashboardTab>("skills");
    const [developerMode, setDeveloperMode] = createSignal(false);
    const calls = { inventory: 0, hubSkills: 0, skills: 0, plugins: 0, mcp: 0, scheduled: 0, soul: 0 };
    const pluginDebugValues: boolean[] = [];

    try {
      createDashboardTabRefreshController({
        tab,
        developerMode,
        refreshSkillInventory: async () => { calls.inventory += 1; },
        refreshHubSkills: async () => { calls.hubSkills += 1; },
        refreshSkills: async () => { calls.skills += 1; },
        refreshPlugins: async (_scope, options) => {
          calls.plugins += 1;
          pluginDebugValues.push(options?.debug ?? false);
        },
        refreshMcpServers: async () => { calls.mcp += 1; },
        refreshScheduledJobs: async () => { calls.scheduled += 1; },
        refreshSoulData: async () => { calls.soul += 1; },
      });

      await flushEffects();
      assert.deepEqual(calls, { inventory: 1, hubSkills: 1, skills: 1, plugins: 0, mcp: 0, scheduled: 0, soul: 0 });

      setTab("skills");
      await flushEffects();
      assert.equal(calls.skills, 1, "equal tab writes must not start another refresh");

      setDeveloperMode(true);
      await flushEffects();
      assert.equal(calls.skills, 1, "callback reads must not become implicit dependencies");

      setTab("scheduled");
      await flushEffects();
      assert.equal(calls.scheduled, 1);

      setTab("mcp");
      await flushEffects();
      assert.equal(calls.plugins, 1);
      assert.equal(calls.mcp, 1);
      assert.deepEqual(pluginDebugValues, [true]);
    } finally {
      dispose();
    }

    setTab("soul");
    await flushEffects();
    assert.equal(calls.soul, 0, "disposed controller must not refresh after unmount");
  });
});
