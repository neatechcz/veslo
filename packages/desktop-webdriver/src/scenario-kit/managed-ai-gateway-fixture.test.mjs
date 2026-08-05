import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURE_MODEL,
  FIXTURE_TOKEN,
  startControlledManagedAiGatewayFixture,
} from "./managed-ai-gateway-fixture.mjs";

test("controlled managed-AI fixture holds one recorded provider response until its scenario releases it", async () => {
  const fixture = await startControlledManagedAiGatewayFixture({ holdResponses: true });
  try {
    const access = await fetch(`${fixture.baseUrl}/api/me/ai-access`, {
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
    });
    assert.equal(access.status, 200);

    const request = fetch(`${fixture.baseUrl}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${FIXTURE_TOKEN}`,
        "content-type": "application/json",
        "x-veslo-session-id": "session-webdriver-test",
      },
      body: JSON.stringify({
        model: FIXTURE_MODEL,
        stream: true,
        messages: [{ role: "user", content: "hold-this-request" }],
      }),
    });
    const attempts = await fixture.waitForAttempts(1, { timeoutMs: 1_000 });
    assert.equal(attempts[0]?.prompt, "hold-this-request");
    assert.equal(attempts[0]?.sessionId, "session-webdriver-test");

    fixture.releaseHeldResponses();
    const response = await request;
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data: \[DONE\]/);

    fixture.setDenyAccessReads(true);
    const denied = await fetch(`${fixture.baseUrl}/api/me/ai-access`, {
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
    });
    assert.equal(denied.status, 401);
  } finally {
    await fixture.close();
  }
});
