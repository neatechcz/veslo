import assert from "node:assert/strict";
import test from "node:test";

import { parseEnv } from "../src/env.js";

test("parseEnv prefers Render PORT over AI_GATEWAY_PORT", () => {
  const parsed = parseEnv({
    PORT: "10000",
    AI_GATEWAY_PORT: "4034",
    AI_GATEWAY_HOST: "127.0.0.1",
  });

  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 10000);
});

test("parseEnv falls back to AI_GATEWAY_PORT when PORT is unset", () => {
  const parsed = parseEnv({
    AI_GATEWAY_PORT: "4034",
  });

  assert.equal(parsed.host, "0.0.0.0");
  assert.equal(parsed.port, 4034);
});

test("parseEnv resolves gateway database, secret key, and OpenAI OAuth settings", () => {
  const parsed = parseEnv({
    AI_GATEWAY_PORT: "4034",
    AI_GATEWAY_DATABASE_URL: "mysql://gateway:gateway@127.0.0.1:3306/veslo_ai_gateway",
    AI_GATEWAY_SECRET_KEY: "test_secret_key_32_bytes_minimum____",
    AI_GATEWAY_OPENAI_CLIENT_ID: "client_id",
    AI_GATEWAY_OPENAI_CLIENT_SECRET: "client_secret",
    AI_GATEWAY_OPENAI_REDIRECT_BASE: "https://veslo.example.test/auth/openai/",
    AI_GATEWAY_DEN_API_BASE: "http://127.0.0.1:8788/",
  });

  assert.equal(parsed.databaseUrl, "mysql://gateway:gateway@127.0.0.1:3306/veslo_ai_gateway");
  assert.equal(parsed.secretKey, "test_secret_key_32_bytes_minimum____");
  assert.deepEqual(parsed.openAiOAuth, {
    clientId: "client_id",
    clientSecret: "client_secret",
    redirectBase: "https://veslo.example.test/auth/openai",
  });
  assert.equal(parsed.denApiBase, "http://127.0.0.1:8788");
});

test("parseEnv production fallback uses the owned Den API base", () => {
  const parsed = parseEnv({
    NODE_ENV: "production",
  });

  assert.equal(parsed.denApiBase, "https://api.veslo.work");
});
