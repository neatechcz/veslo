import { SlidersHorizontal } from "lucide-solid";

import type { DashboardTab } from "../../types";
import { currentLocale, t } from "../../../i18n";

type SidebarAdvancedNavProps = {
  currentTab: DashboardTab;
  onSelect: () => void;
};

const buttonClass = (active: boolean) =>
  `w-full h-9 flex items-center gap-2.5 px-3 rounded-lg text-[13px] font-medium transition-colors ${
    active
      ? "bg-gray-4 text-gray-12"
      : "text-gray-11 hover:text-gray-12 hover:bg-gray-3"
  }`;

export default function SidebarAdvancedNav(props: SidebarAdvancedNavProps) {
  return (
    <button
      type="button"
      class={buttonClass(props.currentTab === "config")}
      onClick={() => props.onSelect()}
    >
      <SlidersHorizontal size={18} />
      {t("nav.advanced", currentLocale())}
    </button>
  );
}
