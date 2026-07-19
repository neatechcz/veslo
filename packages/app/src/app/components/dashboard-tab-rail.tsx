import { createMemo, For } from "solid-js";

import type { DashboardTab, SettingsTab } from "../types";
import { resolveSettingsTabLabel } from "../lib/settings-tab-label";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import { currentLocale, t } from "../../i18n";

export type DashboardTabRailDashboardTab = Extract<DashboardTab, "soul" | "skills" | "mcp" | "plugins">;
export type DashboardTabRailSettingsTab = Extract<SettingsTab, "general" | "archived" | "debug">;

type DashboardTabRailItem =
  | { kind: "settings"; tab: DashboardTabRailSettingsTab }
  | { kind: "dashboard"; tab: DashboardTabRailDashboardTab };

export type DashboardTabRailProps = {
  activeDashboardTab: DashboardTab;
  activeSettingsTab: SettingsTab;
  onOpenSettingsTab: (tab: DashboardTabRailSettingsTab) => void;
  onOpenDashboardTab: (tab: DashboardTabRailDashboardTab) => void;
  showDeveloperSettings?: boolean;
};

const baseItems: DashboardTabRailItem[] = [
  { kind: "settings", tab: "general" },
  { kind: "settings", tab: "archived" },
  { kind: "dashboard", tab: "soul" },
  { kind: "dashboard", tab: "skills" },
  { kind: "dashboard", tab: "mcp" },
  { kind: "dashboard", tab: "plugins" },
];

const developerItems: DashboardTabRailItem[] = [
  { kind: "settings", tab: "debug" },
];

export const shouldShowDashboardTabRail = (tab: DashboardTab) =>
  tab === "scheduled" || tab === "soul" || tab === "skills" || tab === "mcp" || tab === "plugins";

const resolveDashboardTabLabel = (tab: DashboardTabRailDashboardTab) => {
  switch (tab) {
    case "soul":
      return t("nav.soul", currentLocale());
    case "skills":
      return t("nav.skills", currentLocale());
    case "mcp":
      return t("nav.extensions", currentLocale());
    case "plugins":
      return t("nav.plugins", currentLocale());
  }
};

const isDashboardTabActive = (activeTab: DashboardTab, tab: DashboardTabRailDashboardTab) =>
  activeTab === tab;

export default function DashboardTabRail(props: DashboardTabRailProps) {
  const items = createMemo(() => props.showDeveloperSettings ? [...baseItems, ...developerItems] : baseItems);

  const resolveLabel = (item: DashboardTabRailItem) =>
    item.kind === "settings" ? resolveSettingsTabLabel(item.tab) : resolveDashboardTabLabel(item.tab);

  const isActive = (item: DashboardTabRailItem) =>
    item.kind === "settings"
      ? props.activeDashboardTab === "settings" && props.activeSettingsTab === item.tab
      : isDashboardTabActive(props.activeDashboardTab, item.tab);

  const selectItem = (item: DashboardTabRailItem) => {
    if (item.kind === "settings") {
      props.onOpenSettingsTab(item.tab);
      return;
    }
    if (item.tab === "skills") {
      recordSendWorkflowTrace("skills-navigation", "skills-navigation:click", {
        origin: props.activeDashboardTab === "settings" ? "settings-tab-rail" : "dashboard-tab-rail",
        activeDashboardTab: props.activeDashboardTab,
        activeSettingsTab: props.activeSettingsTab,
        destination: "skills",
      });
    }
    props.onOpenDashboardTab(item.tab);
  };

  return (
    <div class="flex flex-wrap gap-2 rounded-2xl border border-gray-6/40 bg-gray-1/40 px-3 py-2">
      <For each={items()}>
        {(item) => (
          <button
            type="button"
            data-settings-nav-kind={item.kind}
            data-settings-nav-tab={item.tab}
            aria-current={isActive(item) ? "page" : undefined}
            class={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
              isActive(item)
                ? "bg-gray-12/10 text-white border-gray-6/30"
                : "text-gray-10 border-gray-6/50 hover:text-gray-12 hover:bg-gray-2/40"
            }`}
            onClick={() => selectItem(item)}
          >
            {resolveLabel(item)}
          </button>
        )}
      </For>
    </div>
  );
}
