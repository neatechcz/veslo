import { parse } from "jsonc-parser";
import type { ModelRef } from "../types";
import { formatModelRef, parseModelRef } from "../utils";

export const parseSessionModelOverrides = (raw: string | null) => {
  if (!raw) return {} as Record<string, ModelRef>;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {} as Record<string, ModelRef>;
    }
    const next: Record<string, ModelRef> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const model = parseModelRef(value);
        if (model) next[sessionId] = model;
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (typeof record.providerID === "string" && typeof record.modelID === "string") {
        next[sessionId] = {
          providerID: record.providerID,
          modelID: record.modelID,
        };
      }
    }
    return next;
  } catch {
    return {} as Record<string, ModelRef>;
  }
};

export const serializeSessionModelOverrides = (overrides: Record<string, ModelRef>) => {
  const entries = Object.entries(overrides);
  if (!entries.length) return null;
  const payload: Record<string, string> = {};
  for (const [sessionId, model] of entries) {
    payload[sessionId] = formatModelRef(model);
  }
  return JSON.stringify(payload);
};

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
