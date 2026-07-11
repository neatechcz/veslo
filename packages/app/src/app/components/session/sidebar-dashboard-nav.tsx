import { Show, createSignal } from "solid-js";
import { ChevronDown, ChevronUp, History, Zap } from "lucide-solid";

import type { DashboardTab } from "../../types";
import { currentLocale, t } from "../../../i18n";
import {
  readSidebarDashboardNavCollapsed,
  writeSidebarDashboardNavCollapsed,
} from "./sidebar-dashboard-nav-prefs";

type VisibleSidebarDashboardTab = Extract<DashboardTab, "scheduled" | "skills">;

type SidebarDashboardNavProps = {
  currentTab: DashboardTab;
  onSelect: (tab: VisibleSidebarDashboardTab) => void;
};

const buttonClass = (active: boolean) =>
  `w-full h-7 flex items-center gap-1.5 px-2.5 rounded-md font-product text-[12px] font-medium transition-colors ${
    active
      ? "bg-cyan-a3 text-dls-text font-medium"
      : "text-gray-11 hover:bg-cyan-a3 hover:text-dls-text"
  }`;

const isActiveTab = (currentTab: DashboardTab, tab: DashboardTab) =>
  currentTab === tab;

export default function SidebarDashboardNav(props: SidebarDashboardNavProps) {
  const [collapsed, setCollapsed] = createSignal(readSidebarDashboardNavCollapsed());
  const collapseLabel = () =>
    collapsed()
      ? t("nav.expand_dashboard_nav", currentLocale())
      : t("nav.collapse_dashboard_nav", currentLocale());

  const toggleCollapsed = () =>
    setCollapsed((current) => {
      const nextCollapsed = !current;
      writeSidebarDashboardNavCollapsed(nextCollapsed);
      return nextCollapsed;
    });

  return (
    <div class="mt-1.5">
      <Show when={!collapsed()}>
        <div class="space-y-0 border-t border-gray-6/70 pt-1.5">
          <button
            type="button"
            class={buttonClass(isActiveTab(props.currentTab, "scheduled"))}
            onClick={() => props.onSelect("scheduled")}
          >
            <History
              size={18}
              class={isActiveTab(props.currentTab, "scheduled") ? "text-dls-accent" : "text-gray-a8"}
            />
            {t("nav.automations", currentLocale())}
          </button>
          <button
            type="button"
            class={buttonClass(isActiveTab(props.currentTab, "skills"))}
            onClick={() => props.onSelect("skills")}
          >
            <Zap
              size={18}
              class={isActiveTab(props.currentTab, "skills") ? "text-dls-accent" : "text-gray-a8"}
            />
            {t("nav.skills", currentLocale())}
          </button>
        </div>
      </Show>
      <div class="relative mt-1.5">
        <div class="border-t border-gray-6/70" />
        <button
          type="button"
          class="absolute left-1/2 top-0 inline-flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border-0 bg-transparent text-gray-a8 transition-colors hover:bg-cyan-a3 hover:text-dls-accent"
          onClick={toggleCollapsed}
          title={collapseLabel()}
          aria-label={collapseLabel()}
          aria-expanded={!collapsed()}
        >
          <Show when={collapsed()} fallback={<ChevronDown size={11} />}>
            <ChevronUp size={11} />
          </Show>
        </button>
      </div>
    </div>
  );
}
