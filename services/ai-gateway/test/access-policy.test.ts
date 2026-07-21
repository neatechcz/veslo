import assert from "node:assert/strict";
import test from "node:test";

import { applyPlatformModelPolicy } from "../src/http/providers/access-policy.js";

test("applyPlatformModelPolicy applies the active model when the request omits model", () => {
  const result = applyPlatformModelPolicy({
    routeProvider: "openai",
    activeModel: { provider: "openai", model: "gpt-5.4" },
    body: {
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.deepEqual(result, {
    ok: true,
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
    },
  });
});

test("applyPlatformModelPolicy accepts an explicit request for the active model", () => {
  const result = applyPlatformModelPolicy({
    routeProvider: "codex_oauth",
    activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
    body: {
      model: "gpt-5.4",
      messages: [],
    },
  });

  assert.deepEqual(result, {
    ok: true,
    body: {
      model: "gpt-5.4",
      messages: [],
    },
  });
});

test("applyPlatformModelPolicy normalizes the active provider prefix", () => {
  const result = applyPlatformModelPolicy({
    routeProvider: "codex_oauth",
    activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
    body: {
      model: " codex_oauth/gpt-5.4 ",
      messages: [],
    },
  });

  assert.deepEqual(result, {
    ok: true,
    body: {
      model: "gpt-5.4",
      messages: [],
    },
  });
});

test("applyPlatformModelPolicy rejects a client model override", () => {
  const result = applyPlatformModelPolicy({
    routeProvider: "openai",
    activeModel: { provider: "openai", model: "gpt-5.4" },
    body: {
      model: "gpt-4.1",
      messages: [],
    },
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: "model_override_not_allowed",
  });
});

test("applyPlatformModelPolicy rejects a route for a different provider", () => {
  const result = applyPlatformModelPolicy({
    routeProvider: "anthropic",
    activeModel: { provider: "openai", model: "gpt-5.4" },
    body: {
      messages: [],
    },
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: "active_model_provider_mismatch",
  });
});

test("applyPlatformModelPolicy rejects non-object request bodies", () => {
  const result = applyPlatformModelPolicy({
    routeProvider: "openai",
    activeModel: { provider: "openai", model: "gpt-5.4" },
    body: [],
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: "invalid_request_body",
  });
});
