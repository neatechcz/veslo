import assert from "node:assert/strict";
import test from "node:test";

import { createSingleFlight } from "./single-flight.js";

test("deduplicates concurrent work for the same key and clears after success", async () => {
  const run = createSingleFlight<number>();
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const task = async () => {
    calls += 1;
    await gate;
    return calls;
  };

  const first = run("ws-1", task);
  const second = run("ws-1", task);

  assert.equal(calls, 1);

  assert.ok(release);
  release();

  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(
    await run("ws-1", async () => {
      calls += 1;
      return calls;
    }),
    2,
  );
});

test("does not deduplicate different keys and clears after failure", async () => {
  const run = createSingleFlight<string>();
  let calls = 0;

  const failing = run("ws-1", async () => {
    calls += 1;
    throw new Error("boom");
  });
  const parallel = run("ws-2", async () => {
    calls += 1;
    return "ok";
  });

  await assert.rejects(failing, /boom/);
  assert.equal(await parallel, "ok");
  assert.equal(calls, 2);

  assert.equal(
    await run("ws-1", async () => {
      calls += 1;
      return "recovered";
    }),
    "recovered",
  );
  assert.equal(calls, 3);
});
