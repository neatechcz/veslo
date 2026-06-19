import { For } from "solid-js";

import type { DashboardTab, SettingsTab } from "../types";
import { resolveSettingsTabLabel } from "../lib/settings-tab-label";
import { currentLocale, t } from "../../i18n";

export type DashboardTabRailDashboardTab = Extract<DashboardTab, "skills" | "mcp">;
export type DashboardTabRailSettingsTab = Extract<SettingsTab, "general" | "archived">;

type DashboardTabRailItem =
  | { kind: "settings"; tab: DashboardTabRailSettingsTab }
  | { kind: "dashboard"; tab: DashboardTabRailDashboardTab };

export type DashboardTabRailProps = {
  activeDashboardTab: DashboardTab;
  activeSettingsTab: SettingsTab;
  onOpenSettingsTab: (tab: DashboardTabRailSettingsTab) => void;
  onOpenDashboardTab: (tab: DashboardTabRailDashboardTab) => void;
};

const items: DashboardTabRailItem[] = [
  { kind: "settings", tab: "general" },
  { kind: "settings", tab: "archived" },
  { kind: "dashboard", tab: "skills" },
  { kind: "dashboard", tab: "mcp" },
];

export const shouldShowDashboardTabRail = (tab: DashboardTab) =>
  tab === "scheduled" || tab === "skills" || tab === "mcp" || tab === "plugins";

const resolveDashboardTabLabel = (tab: DashboardTabRailDashboardTab) => {
  switch (tab) {
    case "skills":
      return t("nav.skills", currentLocale());
    case "mcp":
      return t("nav.extensions", currentLocale());
  }
};

const isDashboardTabActive = (activeTab: DashboardTab, tab: DashboardTabRailDashboardTab) =>
  activeTab === tab || (tab === "mcp" && activeTab === "plugins");

export default function DashboardTabRail(props: DashboardTabRailProps) {
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
    props.onOpenDashboardTab(item.tab);
  };

  return (
    <div class="flex flex-wrap gap-2 rounded-2xl border border-gray-6/40 bg-gray-1/40 px-3 py-2">
      <For each={items}>
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
