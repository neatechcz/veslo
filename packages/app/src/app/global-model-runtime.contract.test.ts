import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRef } from "./types.js";
import { resolveGlobalRuntimeModel } from "./lib/global-model-runtime.js";

const GPT_Codex: ModelRef = {
  providerID: "openai",
  modelID: "gpt-5.3-codex",
};

test("global runtime model always resolves to the configured app model", () => {
  const resolved = resolveGlobalRuntimeModel(GPT_Codex);
  assert.strictEqual(resolved, GPT_Codex);
});
