import type { HubMcpItem, HubMcpOAuthConfig, ModelRef, SuggestedPlugin } from "./types";

export const MODEL_PREF_KEY = "veslo.defaultModel";
export const SESSION_MODEL_PREF_KEY = "veslo.sessionModels";
export const SESSION_MODEL_SELECTOR_PREF_KEY = "veslo.sessionModelSelectorEnabled";
export const THINKING_PREF_KEY = "veslo.showThinking";
export const VARIANT_PREF_KEY = "veslo.modelVariant";
export const LANGUAGE_PREF_KEY = "veslo.language";
export const ONBOARDING_COMPLETE_STORAGE_KEY = "veslo.onboardingComplete";
export const HIDE_TITLEBAR_PREF_KEY = "veslo.hideTitlebar";
export const ENGINE_SOURCE_PREF_KEY = "veslo.engineSource";
export const ENGINE_SOURCE_EXPLICIT_PREF_KEY = "veslo.engineSourceExplicit";
export const ENGINE_CUSTOM_BIN_PATH_PREF_KEY = "veslo.engineCustomBinPath";
export const MAX_ENGINES_PREF_KEY = "veslo.maxEngines";
export const IDLE_SUSPEND_MS_PREF_KEY = "veslo.idleSuspendMs";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "big-pickle",
};

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [];

export type McpDirectoryInfo = {
  id?: string;
  aliases?: string[];
  name: string;
  description: string;
  descriptionKey?: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: HubMcpOAuthConfig;
  headers?: Record<string, string>;
  authorization?: HubMcpItem["authorization"];
  connection?: HubMcpItem["connection"];
  provider?: {
    id: string;
    group?: string;
  };
  source?: HubMcpItem["source"];
};

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    id: "chrome-devtools",
    aliases: ["control-chrome"],
    name: "Control Chrome",
    description: "Drive Chrome tabs with browser automation.",
    descriptionKey: "mcp.quick_control_chrome_description",
    type: "local",
    command: ["chrome-devtools-mcp", "--isolated"],
    oauth: false,
  },
];
