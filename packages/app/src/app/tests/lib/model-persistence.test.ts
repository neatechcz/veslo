import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRef } from "../../types.js";
import {
  clearLegacySessionModelPersistence,
  collectLegacySessionModelStorageKeys,
  parseSessionModelOverrides,
  resolveWorkspaceDefaultModel,
} from "../../lib/model-persistence.js";

const CLAUDE: ModelRef = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
};

const GPT_Codex: ModelRef = {
  providerID: "openai",
  modelID: "gpt-5.3-codex",
};

const createStorage = (initialKeys: string[]) => {
  const keys = initialKeys.slice();
  return {
    get length() {
      return keys.length;
    },
    key(index: number) {
      return keys[index] ?? null;
    },
    removeItem(target: string) {
      const index = keys.indexOf(target);
      if (index !== -1) keys.splice(index, 1);
    },
    snapshot() {
      return keys.slice();
    },
  };
};

test("keeps current default when workspace config has no model", () => {
  const next = resolveWorkspaceDefaultModel({
    configDefault: null,
    currentDefault: GPT_Codex,
    legacyDefault: CLAUDE,
  });

  assert.deepEqual(next, GPT_Codex);
});

test("prefers workspace config model when present", () => {
  const next = resolveWorkspaceDefaultModel({
    configDefault: CLAUDE,
    currentDefault: GPT_Codex,
    legacyDefault: GPT_Codex,
  });

  assert.deepEqual(next, CLAUDE);
});

test("falls back to legacy default when current is missing", () => {
  const next = resolveWorkspaceDefaultModel({
    configDefault: null,
    currentDefault: null,
    legacyDefault: CLAUDE,
  });

  assert.deepEqual(next, CLAUDE);
});

test("ignores a non-object persisted session-model payload", () => {
  assert.deepEqual(parseSessionModelOverrides('"legacy"'), {});
});

test("collects every legacy user model authority key from storage", () => {
  const storage = createStorage([
    "veslo.defaultModel",
    "veslo.sessionModels.workspace-a",
    "veslo.sessionModels.workspace-b",
    "veslo.sessionDirectories.workspace-a",
    "veslo.sessionModels",
  ]);

  assert.deepEqual(collectLegacySessionModelStorageKeys(storage), [
    "veslo.defaultModel",
    "veslo.sessionModels.workspace-a",
    "veslo.sessionModels.workspace-b",
    "veslo.sessionModels",
  ]);
});

test("clears legacy global and per-session model keys without touching other preferences", () => {
  const storage = createStorage([
    "veslo.defaultModel",
    "veslo.sessionModels",
    "veslo.sessionModels.workspace-a",
    "veslo.language",
    "veslo.sessionModels.workspace-b",
  ]);

  const removed = clearLegacySessionModelPersistence(storage);

  assert.deepEqual(removed, [
    "veslo.defaultModel",
    "veslo.sessionModels",
    "veslo.sessionModels.workspace-a",
    "veslo.sessionModels.workspace-b",
  ]);
  assert.deepEqual(storage.snapshot(), ["veslo.language"]);
});
