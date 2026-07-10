import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_DEFAULT_MODEL,
  listCodexModelCatalog,
  resolveCodexModelPolicy,
} from "../src/providers/codex-model-catalog.js";

test("managed Codex defaults to GPT-5.6 Sol", () => {
  assert.equal(CODEX_DEFAULT_MODEL, "gpt-5.6-sol");
});

test("Codex model catalog lists GPT-5.6 Sol first", () => {
  assert.equal(listCodexModelCatalog()[0], "gpt-5.6-sol");
});

test("empty Codex model policy resolves only to GPT-5.6 Sol", () => {
  assert.deepEqual(
    resolveCodexModelPolicy({
      defaultModel: null,
      allowedModels: [],
    }),
    {
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol"],
    },
  );
});
