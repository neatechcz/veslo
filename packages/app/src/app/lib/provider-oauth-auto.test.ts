import assert from "node:assert/strict";
import test from "node:test";

import {
  extractProviderOAuthCallbackProbeUrl,
  settleAsyncResult,
  waitForProviderOAuthCallbackListener,
} from "./provider-oauth-auto.js";

test("extractProviderOAuthCallbackProbeUrl derives the localhost probe URL from redirect_uri", () => {
  const probeUrl = extractProviderOAuthCallbackProbeUrl(
    "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=demo",
  );

  assert.equal(probeUrl, "http://localhost:1455/");
});

test("extractProviderOAuthCallbackProbeUrl returns null when redirect_uri is missing", () => {
  const probeUrl = extractProviderOAuthCallbackProbeUrl("https://auth.openai.com/oauth/authorize?state=demo");

  assert.equal(probeUrl, null);
});

test("waitForProviderOAuthCallbackListener retries until the callback listener responds", async () => {
  const calls: string[] = [];
  let attempts = 0;

  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    attempts += 1;
    if (attempts < 3) {
      throw new Error("connect ECONNREFUSED");
    }
    return new Response("Not found", { status: 404 });
  };

  const ready = await waitForProviderOAuthCallbackListener(
    "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=demo",
    { fetchImpl, timeoutMs: 500, pollMs: 1, requestTimeoutMs: 50 },
  );

  assert.equal(ready, true);
  assert.deepEqual(calls, [
    "http://localhost:1455/",
    "http://localhost:1455/",
    "http://localhost:1455/",
  ]);
});

test("settleAsyncResult prevents early OAuth callback failures from surfacing as unhandled rejections", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  process.on("unhandledRejection", onUnhandled);

  try {
    const settled = settleAsyncResult(Promise.reject(new Error("OAuth callback failed early")));

    await new Promise((resolve) => setImmediate(resolve));

    const result = await settled;
    assert.equal(result.ok, false);
    assert.match(String(result.error), /OAuth callback failed early/);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
