import assert from "node:assert/strict";
import test from "node:test";

import { createKeyedSingleFlight } from "../../lib/keyed-single-flight.js";

test("keyed single-flight joins only concurrent work for the same key", async () => {
  const flight = createKeyedSingleFlight<string, string>();
  let starts = 0;
  let resolveFirst: ((value: string) => void) | undefined;
  const first = flight.run("workspace-a", () => {
    starts += 1;
    return new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
  });
  const second = flight.run("workspace-a", async () => {
    starts += 1;
    return "unexpected";
  });

  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(starts, 1);
  resolveFirst?.("first");
  assert.equal(await first, "first");

  assert.equal(
    await flight.run("workspace-a", async () => {
      starts += 1;
      return "second";
    }),
    "second",
  );
  assert.equal(starts, 2, "completed values must not remain cached");
});

test("keyed single-flight keeps independent keys independent", async () => {
  const flight = createKeyedSingleFlight<string, string>();
  const values = await Promise.all([
    flight.run("workspace-a", async () => "a"),
    flight.run("workspace-b", async () => "b"),
  ]);

  assert.deepEqual(values, ["a", "b"]);
});
