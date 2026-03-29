import { Box, HeartPulse, History, Zap } from "lucide-solid";

import type { DashboardTab } from "../../types";
import { currentLocale, t } from "../../../i18n";

type SidebarDashboardNavProps = {
  currentTab: DashboardTab;
  onSelect: (tab: DashboardTab) => void;
  soulIconClass?: string;
};

const buttonClass = (active: boolean) =>
  `w-full h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-[13px] font-medium transition-colors ${
    active
      ? "bg-gray-4 text-gray-12"
      : "text-gray-11 hover:text-gray-12 hover:bg-gray-3"
  }`;

const isActiveTab = (currentTab: DashboardTab, tab: DashboardTab) =>
  currentTab === tab || (tab === "mcp" && currentTab === "plugins");

export default function SidebarDashboardNav(props: SidebarDashboardNavProps) {
  return (
    <div class="mt-1.5 space-y-0 border-t border-gray-6/70 pt-1.5">
      <button
        type="button"
        class={buttonClass(isActiveTab(props.currentTab, "scheduled"))}
        onClick={() => props.onSelect("scheduled")}
      >
        <History size={18} />
        {t("nav.automations", currentLocale())}
      </button>
      <button
        type="button"
        class={buttonClass(isActiveTab(props.currentTab, "soul"))}
        onClick={() => props.onSelect("soul")}
      >
        <HeartPulse size={18} class={props.soulIconClass} />
        {t("nav.soul", currentLocale())}
      </button>
      <button
        type="button"
        class={buttonClass(isActiveTab(props.currentTab, "skills"))}
        onClick={() => props.onSelect("skills")}
      >
        <Zap size={18} />
        {t("nav.skills", currentLocale())}
      </button>
      <button
        type="button"
        class={buttonClass(isActiveTab(props.currentTab, "mcp"))}
        onClick={() => props.onSelect("mcp")}
      >
        <Box size={18} />
        {t("nav.extensions", currentLocale())}
      </button>
    </div>
  );
}
