import assert from "node:assert/strict";
import test from "node:test";

import type { UserAiAccessPolicyRecord } from "../src/access/repository.js";
import { applyAiAccessPolicy } from "../src/http/providers/access-policy.js";

function createAiAccess(
  overrides: Partial<UserAiAccessPolicyRecord> = {},
): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_gateway",
    userId: "user_gateway",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_codex_1",
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
    createdAt: new Date("2026-04-18T08:00:00.000Z"),
    updatedAt: new Date("2026-04-18T08:00:00.000Z"),
    ...overrides,
  };
}

test("applyAiAccessPolicy accepts provider-qualified model refs for codex_oauth routes", () => {
  const result = applyAiAccessPolicy({
    routeProvider: "codex_oauth",
    aiAccess: createAiAccess(),
    body: {
      model: "codex_oauth/gpt-5.4",
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
