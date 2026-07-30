import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioTimeline } from "./timeline.mjs";

test("timeline records passed and failed measured steps without swallowing errors", async () => {
  let now = 100;
  const timeline = createScenarioTimeline(() => now);
  const value = await timeline.step("select-workspace", async () => {
    now += 14;
    return "selected";
  });
  assert.equal(value, "selected");
  await assert.rejects(
    timeline.step("submit", async () => {
      now += 9;
      throw new Error("submit failed");
    }),
    /submit failed/,
  );
  now += 2;
  assert.deepEqual(timeline.summary(), {
    durationMs: 25,
    steps: [
      { name: "select-workspace", startedOffsetMs: 0, status: "passed", durationMs: 14 },
      { name: "submit", startedOffsetMs: 14, status: "failed", error: "submit failed", durationMs: 9 },
    ],
  });
});
