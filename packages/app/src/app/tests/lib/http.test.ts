import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithTimeout } from "../../lib/http.js";

test("fetchWithTimeout clears browser timer ID zero", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let clearedTimerId: number | undefined;

  globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timerId: number) => {
    clearedTimerId = timerId;
  }) as unknown as typeof clearTimeout;

  try {
    await fetchWithTimeout(async () => new Response("ok"), "https://example.test", undefined, 50);
    assert.equal(clearedTimerId, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
