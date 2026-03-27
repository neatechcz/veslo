import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRef } from "../types.js";
import { resolveWorkspaceDefaultModel } from "./model-persistence.js";

const CLAUDE: ModelRef = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
};

const GPT_Codex: ModelRef = {
  providerID: "openai",
  modelID: "gpt-5.3-codex",
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
