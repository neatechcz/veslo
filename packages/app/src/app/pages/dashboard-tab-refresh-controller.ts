import { createEffect, on, type Accessor } from "solid-js";

import type { DashboardTab, PluginScope } from "../types";

type DashboardTabRefreshControllerOptions = {
  tab: Accessor<DashboardTab>;
  developerMode: Accessor<boolean>;
  refreshSkillInventory: (options?: { force?: boolean }) => Promise<void>;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshPlugins: (scopeOverride?: PluginScope, optionsOverride?: { debug?: boolean }) => Promise<void>;
  refreshMcpServers: () => Promise<void>;
  refreshScheduledJobs: (options?: { force?: boolean }) => Promise<void>;
  refreshSoulData: (options?: { force?: boolean }) => Promise<void>;
};

async function refreshTab(options: DashboardTabRefreshControllerOptions, tab: DashboardTab): Promise<void> {
  switch (tab) {
    case "skills":
      // The inventory refresh owns the hub refresh. Starting it separately here
      // races the inventory snapshot and needlessly invalidates it on navigation.
      await Promise.all([options.refreshSkillInventory(), options.refreshSkills()]);
      return;
    case "plugins":
    case "mcp":
      await Promise.all([
        options.refreshPlugins(undefined, { debug: options.developerMode() }),
        options.refreshMcpServers(),
      ]);
      return;
    case "scheduled":
      await options.refreshScheduledJobs();
      return;
    case "soul":
      await options.refreshSoulData();
      return;
    default:
      return;
  }
}

/**
 * Owns dashboard data refreshes. `on` makes the selected tab the only
 * dependency, so request callbacks cannot accidentally re-run this effect.
 */
export function createDashboardTabRefreshController(options: DashboardTabRefreshControllerOptions): void {
  createEffect(
    on(options.tab, (tab) => {
      void refreshTab(options, tab).catch(() => {
        // Individual refresh owners expose their own status; navigation must stay usable on failure.
      });
    }),
  );
}
