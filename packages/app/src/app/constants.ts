import type { ModelRef, SuggestedPlugin } from "./types";

export const MODEL_PREF_KEY = "veslo.defaultModel";
export const THINKING_PREF_KEY = "veslo.showThinking";
export const VARIANT_PREF_KEY = "veslo.modelVariant";
export const LANGUAGE_PREF_KEY = "veslo.language";
export const ONBOARDING_COMPLETE_STORAGE_KEY = "veslo.onboardingComplete";
export const HIDE_TITLEBAR_PREF_KEY = "veslo.hideTitlebar";
export const AUTO_COMPACT_CONTEXT_PREF_KEY = "veslo.autoCompactContext";
export const ENGINE_SOURCE_PREF_KEY = "veslo.engineSource";
export const ENGINE_SOURCE_EXPLICIT_PREF_KEY = "veslo.engineSourceExplicit";
export const ENGINE_CUSTOM_BIN_PATH_PREF_KEY = "veslo.engineCustomBinPath";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "big-pickle",
};

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [
  {
    name: "opencode-scheduler",
    packageName: "opencode-scheduler",
    description: "Run scheduled jobs with the OpenCode scheduler plugin.",
    tags: ["automation", "jobs"],
    installMode: "simple",
  },
];

export type McpDirectoryInfo = {
  id?: string;
  name: string;
  description: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: boolean;
};

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    name: "Notion",
    description: "Pages, databases, and project docs in sync.",
    url: "https://mcp.notion.com/mcp",
    type: "remote",
    oauth: true,
  },
  {
    name: "Linear",
    description: "Plan sprints and ship tickets faster.",
    url: "https://mcp.linear.app/mcp",
    type: "remote",
    oauth: true,
  },
  {
    name: "Sentry",
    description: "Track releases and resolve production errors.",
    url: "https://mcp.sentry.dev/mcp",
    type: "remote",
    oauth: true,
  },
  {
    name: "Stripe",
    description: "Inspect payments, invoices, and subscriptions.",
    url: "https://mcp.stripe.com",
    type: "remote",
    oauth: true,
  },
  {
    name: "Context7",
    description: "Search product docs with richer context.",
    url: "https://mcp.context7.com/mcp",
    type: "remote",
    oauth: false,
  },
  {
    id: "chrome-devtools",
    name: "Control Chrome",
    description: "Drive Chrome tabs with browser automation.",
    type: "local",
    command: ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"],
    oauth: false,
  },
];
