import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { withTimeoutOrThrow } from "../../utils/promise-timeout.js";

test("resolves when promise completes before timeout", async () => {
  const value = await withTimeoutOrThrow(Promise.resolve("ok"), {
    timeoutMs: 50,
    label: "fast-operation",
  });

  assert.equal(value, "ok");
});

test("rejects when promise does not complete before timeout", async () => {
  const never = new Promise<string>(() => {});

  await assert.rejects(
    withTimeoutOrThrow(never, {
      timeoutMs: 20,
      label: "stalled-operation",
    }),
    /Timed out waiting for stalled-operation after 20ms/,
  );
});

test("opencode waitForHealthy aborts bounded SDK health requests", () => {
  const source = readFileSync(new URL("../../lib/opencode.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function waitForHealthy(");
  assert.notEqual(start, -1, "waitForHealthy source should be present");
  const block = source.slice(start, source.indexOf("function normalizeConfigKey", start));

  assert.match(block, /const controller = new AbortController\(\);/);
  assert.match(block, /setTimeout\(\(\) => controller\.abort\(\), requestTimeoutMs\)/);
  assert.match(block, /client\.global\.health\(\{ signal: controller\.signal \}\)/);
  assert.match(block, /clearTimeout\(timer\)/);
});
