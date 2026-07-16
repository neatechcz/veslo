import { parse } from "jsonc-parser";
import { MODEL_PREF_KEY, SESSION_MODEL_PREF_KEY } from "../constants";
import type { ModelRef } from "../types";
import { formatModelRef, parseModelRef } from "../utils";

type StorageKeyReader = {
  length: number;
  key(index: number): string | null;
};

type StorageKeyStore = StorageKeyReader & {
  removeItem(key: string): void;
};

const LEGACY_SESSION_MODEL_STORAGE_PREFIX = `${SESSION_MODEL_PREF_KEY}.`;

export const collectLegacySessionModelStorageKeys = (storage: StorageKeyReader) => {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (
      key !== MODEL_PREF_KEY
      && key !== SESSION_MODEL_PREF_KEY
      && !key?.startsWith(LEGACY_SESSION_MODEL_STORAGE_PREFIX)
    ) continue;
    keys.push(key);
  }
  return keys;
};

export const clearLegacySessionModelPersistence = (storage: StorageKeyStore) => {
  const keys = collectLegacySessionModelStorageKeys(storage);
  for (const key of keys) {
    storage.removeItem(key);
  }
  return keys;
};

export const parseSessionModelOverrides = (raw: string | null) => {
  if (!raw) return {} as Record<string, ModelRef>;
  try {
    const parsed: unknown = JSON.parse(raw);
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
