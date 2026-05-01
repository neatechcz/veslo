import assert from "node:assert/strict";
import test from "node:test";

import { readAnthropicUsage, readOpenAiCompatibleUsage } from "../src/usage/token-accounting.js";

test("reads OpenAI compatible prompt, completion, cached, and total tokens", () => {
  assert.deepEqual(
    readOpenAiCompatibleUsage({
      usage: {
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
        prompt_tokens_details: { cached_tokens: 12 },
      },
    }),
    {
      inputTokens: 20,
      outputTokens: 5,
      cachedTokens: 12,
      totalTokens: 25,
    },
  );
});

test("reads OpenAI compatible input and output token fields", () => {
  assert.deepEqual(
    readOpenAiCompatibleUsage({
      usage: {
        input_tokens: 8,
        output_tokens: 3,
      },
    }),
    {
      inputTokens: 8,
      outputTokens: 3,
      cachedTokens: 0,
      totalTokens: 11,
    },
  );
});

test("returns null when usage is missing", () => {
  assert.equal(readOpenAiCompatibleUsage({ id: "response_1" }), null);
  assert.equal(readAnthropicUsage({ id: "msg_1" }), null);
});

test("reads Anthropic input and output token fields", () => {
  assert.deepEqual(
    readAnthropicUsage({
      usage: {
        input_tokens: 14,
        output_tokens: 9,
      },
    }),
    {
      inputTokens: 14,
      outputTokens: 9,
      cachedTokens: 0,
      totalTokens: 23,
    },
  );
});

test("reads Anthropic cache fields as cached tokens and adds them to total because input_tokens is uncached-only", () => {
  assert.deepEqual(
    readAnthropicUsage({
      usage: {
        input_tokens: 14,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 25,
        output_tokens: 9,
      },
    }),
    {
      inputTokens: 14,
      outputTokens: 9,
      cachedTokens: 125,
      totalTokens: 148,
    },
  );
});

test("ignores non-finite and non-numeric Anthropic cache token fields", () => {
  assert.deepEqual(
    readAnthropicUsage({
      usage: {
        input_tokens: 14,
        cache_creation_input_tokens: "100",
        cache_read_input_tokens: Number.POSITIVE_INFINITY,
        output_tokens: 9,
      },
    }),
    {
      inputTokens: 14,
      outputTokens: 9,
      cachedTokens: 0,
      totalTokens: 23,
    },
  );
});
