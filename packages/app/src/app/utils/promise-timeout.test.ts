import assert from "node:assert/strict";
import test from "node:test";

import { withTimeoutOrThrow } from "./promise-timeout.js";

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
