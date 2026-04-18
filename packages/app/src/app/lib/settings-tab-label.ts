import type { SettingsTab } from "../types";
import { currentLocale, t } from "../../i18n";

const settingsTabLabelKeyByTab: Partial<Record<SettingsTab, string>> = {
  general: "settings.general",
  archived: "settings.archived",
  model: "settings.model",
  advanced: "settings.advanced",
  debug: "settings.debug",
};

const visibleSettingsTabs: SettingsTab[] = ["general", "archived"];

export const resolveVisibleSettingsTab = (settingsTab: SettingsTab, developerMode: boolean) => {
  const tabs = developerMode ? [...visibleSettingsTabs, "model", "advanced", "debug"] : visibleSettingsTabs;
  return tabs.includes(settingsTab) ? settingsTab : "general";
};

export const resolveSettingsTabLabel = (tab: SettingsTab) => {
  const key = settingsTabLabelKeyByTab[tab] ?? settingsTabLabelKeyByTab.general ?? "settings.general";
  return t(key, currentLocale());
};
