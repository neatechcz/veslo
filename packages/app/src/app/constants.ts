import type { ModelRef, SuggestedPlugin } from "./types";

export const MODEL_PREF_KEY = "veslo.defaultModel";
export const SESSION_MODEL_PREF_KEY = "veslo.sessionModels";
export const THINKING_PREF_KEY = "veslo.showThinking";
export const VARIANT_PREF_KEY = "veslo.modelVariant";
export const LANGUAGE_PREF_KEY = "veslo.language";
export const ONBOARDING_COMPLETE_STORAGE_KEY = "veslo.onboardingComplete";
export const HIDE_TITLEBAR_PREF_KEY = "veslo.hideTitlebar";
export const AUTO_COMPACT_CONTEXT_PREF_KEY = "veslo.autoCompactContext";
export const ENGINE_SOURCE_PREF_KEY = "veslo.engineSource";
export const ENGINE_SOURCE_EXPLICIT_PREF_KEY = "veslo.engineSourceExplicit";
export const ENGINE_CUSTOM_BIN_PATH_PREF_KEY = "veslo.engineCustomBinPath";
export const MAX_ENGINES_PREF_KEY = "veslo.maxEngines";
export const IDLE_SUSPEND_MS_PREF_KEY = "veslo.idleSuspendMs";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "big-pickle",
};

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [
  {
    name: "opencode-scheduler",
    packageName: "opencode-scheduler",
    description: "Run scheduled jobs with the OpenCode scheduler plugin.",
    descriptionKey: "plugins.suggested_scheduler_description",
    tags: ["automation", "jobs"],
    tagKeys: ["plugins.tag_automation", "plugins.tag_jobs"],
    installMode: "simple",
  },
];

export type McpDirectoryInfo = {
  id?: string;
  name: string;
  description: string;
  descriptionKey?: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: boolean;
};

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    id: "chrome-devtools",
    name: "Control Chrome",
    description: "Drive Chrome tabs with browser automation.",
    descriptionKey: "mcp.quick_control_chrome_description",
    type: "local",
    command: ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"],
    oauth: false,
  },
];
