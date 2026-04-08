import { parse } from "jsonc-parser";
import type { ModelRef } from "../types";
import { formatModelRef, parseModelRef } from "../utils";

export const parseDefaultModelFromConfig = (content: string | null) => {
  if (!content) return null;
  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    const rawModel = typeof parsed?.model === "string" ? parsed.model : null;
    return parseModelRef(rawModel);
  } catch {
    return null;
  }
};

export const formatConfigWithDefaultModel = (content: string | null, model: ModelRef) => {
  let config: Record<string, unknown> = {};
  if (content?.trim()) {
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = { ...parsed };
      }
    } catch {
      config = {};
    }
  }

  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }

  config.model = formatModelRef(model);
  return `${JSON.stringify(config, null, 2)}\n`;
};

type WorkspaceDefaultModelResolutionInput = {
  configDefault: ModelRef | null;
  currentDefault: ModelRef | null;
  legacyDefault: ModelRef;
};

export const resolveWorkspaceDefaultModel = ({
  configDefault,
  currentDefault,
  legacyDefault,
}: WorkspaceDefaultModelResolutionInput): ModelRef => configDefault ?? currentDefault ?? legacyDefault;
