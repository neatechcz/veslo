import type { SettingsTab } from "../types";
import { currentLocale, t } from "../../i18n";

const settingsTabLabelKeyByTab: Partial<Record<SettingsTab, string>> = {
  general: "settings.general",
  archived: "settings.archived",
  advanced: "settings.advanced",
  debug: "settings.debug",
};

const visibleSettingsTabs: SettingsTab[] = ["general", "extensions", "archived", "advanced"];

export const resolveVisibleSettingsTab = (settingsTab: SettingsTab, _developerMode: boolean) => {
  return visibleSettingsTabs.includes(settingsTab) ? settingsTab : "general";
};

export const resolveSettingsTabLabel = (tab: SettingsTab) => {
  const key = settingsTabLabelKeyByTab[tab] ?? settingsTabLabelKeyByTab.general ?? "settings.general";
  return t(key, currentLocale());
};
