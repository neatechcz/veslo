import assert from "node:assert/strict";
import test from "node:test";

import {
  extractOpenAiCompatibleModelIds,
  isApiCredentialRequired,
  resolveLmStudioBaseUrl,
  resolveEffectiveConnectedProviderIds,
} from "./providers.js";

test("adds no-auth providers to the connected set", () => {
  const next = resolveEffectiveConnectedProviderIds(
    [
      { id: "openai", env: ["OPENAI_API_KEY"] },
      { id: "lmstudio", env: [] },
      { id: "opencode", env: [] },
    ],
    ["openai"],
  );

  assert.deepEqual(next.sort(), ["lmstudio", "opencode", "openai"].sort());
});

test("ignores empty ids and trims connected ids", () => {
  const next = resolveEffectiveConnectedProviderIds(
    [{ id: "lmstudio", env: [] }],
    ["", "  ", " lmstudio "],
  );

  assert.deepEqual(next, ["lmstudio"]);
});

test("extracts unique model ids from OpenAI-compatible model list payloads", () => {
  const ids = extractOpenAiCompatibleModelIds({
    data: [
      { id: "qwen3.5-27b" },
      { id: "llama-3.3-70b-instruct" },
      { id: "qwen3.5-27b" },
      { id: "   " },
      {},
    ],
  });

  assert.deepEqual(ids, ["qwen3.5-27b", "llama-3.3-70b-instruct"]);
});

test("returns an empty list when model payload is malformed", () => {
  assert.deepEqual(extractOpenAiCompatibleModelIds(null), []);
  assert.deepEqual(extractOpenAiCompatibleModelIds({}), []);
  assert.deepEqual(extractOpenAiCompatibleModelIds({ data: "invalid" }), []);
});

test("prefers explicit LM Studio URL input when provided", () => {
  const resolved = resolveLmStudioBaseUrl(
    "http://10.0.0.5:1234/v1",
    "http://127.0.0.1:1234/v1",
  );

  assert.equal(resolved, "http://10.0.0.5:1234/v1");
});

test("falls back to configured LM Studio URL when explicit input is empty", () => {
  const resolved = resolveLmStudioBaseUrl(
    " ",
    "http://localhost:1234/v1/",
  );

  assert.equal(resolved, "http://localhost:1234/v1");
});

test("falls back to the default local URL when nothing else is provided", () => {
  const resolved = resolveLmStudioBaseUrl("", "");
  assert.equal(resolved, "http://127.0.0.1:1234/v1");
});

test("does not require API key credential for LM Studio provider", () => {
  assert.equal(isApiCredentialRequired("lmstudio"), false);
});

test("requires API key credential for non-LM Studio providers", () => {
  assert.equal(isApiCredentialRequired("openai"), true);
  assert.equal(isApiCredentialRequired("anthropic"), true);
});
