import type { SettingsTab } from "../types";
import { currentLocale, t } from "../../i18n";

const settingsTabLabelKeyByTab: Record<SettingsTab, string> = {
  general: "settings.general",
  model: "settings.model",
  advanced: "settings.advanced",
  debug: "settings.debug",
};

const visibleSettingsTabs: SettingsTab[] = ["general", "model", "advanced"];

export const resolveVisibleSettingsTab = (settingsTab: SettingsTab, developerMode: boolean) => {
  const tabs = developerMode ? [...visibleSettingsTabs, "debug"] : visibleSettingsTabs;
  return tabs.includes(settingsTab) ? settingsTab : "general";
};

export const resolveSettingsTabLabel = (tab: SettingsTab) => {
  const key = settingsTabLabelKeyByTab[tab] ?? settingsTabLabelKeyByTab.general;
  return t(key, currentLocale());
};
