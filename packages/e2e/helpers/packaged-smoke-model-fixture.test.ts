import assert from "node:assert/strict";
import test from "node:test";

import {
  PACKAGED_SMOKE_MODEL_ID,
  PACKAGED_SMOKE_RESPONSE,
  startPackagedSmokeModelFixture,
} from "./packaged-smoke-model-fixture.js";

test("packaged smoke model fixture serves a local OpenAI-compatible streaming response", async () => {
  const fixture = await startPackagedSmokeModelFixture();
  try {
    const models = await fetch(fixture.baseUrl + "/models");
    assert.equal(models.ok, true);
    assert.deepEqual(await models.json(), {
      object: "list",
      data: [
        { id: PACKAGED_SMOKE_MODEL_ID, object: "model", owned_by: "veslo-e2e" },
      ],
    });

    const completion = await fetch(fixture.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: PACKAGED_SMOKE_MODEL_ID,
        stream: true,
        messages: [{ role: "user", content: "deterministic smoke" }],
      }),
    });
    assert.equal(completion.ok, true);
    assert.match(
      completion.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    const text = await completion.text();
    assert.match(text, new RegExp(PACKAGED_SMOKE_RESPONSE));
    assert.match(text, /data: \[DONE\]/);
    assert.equal(fixture.requestCount(), 1);
  } finally {
    await fixture.stop();
  }
});
