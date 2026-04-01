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
