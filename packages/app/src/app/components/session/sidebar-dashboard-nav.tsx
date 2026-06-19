import { Show, createSignal } from "solid-js";
import { Box, ChevronDown, ChevronUp, Zap } from "lucide-solid";

import type { DashboardTab } from "../../types";
import { currentLocale, t } from "../../../i18n";
import {
  readSidebarDashboardNavCollapsed,
  writeSidebarDashboardNavCollapsed,
} from "./sidebar-dashboard-nav-prefs";

type VisibleSidebarDashboardTab = Extract<DashboardTab, "skills" | "mcp">;

type SidebarDashboardNavProps = {
  currentTab: DashboardTab;
  onSelect: (tab: VisibleSidebarDashboardTab) => void;
};

const buttonClass = (active: boolean) =>
  `w-full h-7 flex items-center gap-1.5 px-2.5 rounded-lg font-product text-[12px] font-medium transition-colors ${
    active
      ? "bg-gray-4 text-gray-12"
      : "text-gray-11 hover:text-gray-12 hover:bg-gray-3"
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
            class={buttonClass(isActiveTab(props.currentTab, "skills"))}
            onClick={() => props.onSelect("skills")}
          >
            <Zap size={18} />
            {t("nav.skills", currentLocale())}
          </button>
        </div>
      </Show>
      <div class="relative mt-1.5">
        <div class="border-t border-gray-6/70" />
        <button
          type="button"
          class="absolute left-1/2 top-0 inline-flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-10 shadow-sm transition-colors hover:bg-gray-2 hover:text-gray-11"
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
