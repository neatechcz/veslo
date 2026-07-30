import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUiStabilitySamples } from "./flicker.mjs";

test("flicker summary separates frame gaps, visibility flaps, and layout shifts", () => {
  const sample = (timestampMs, appRoot) => ({
    timestampMs,
    targets: {
      appRoot,
      composer: { visible: true, x: 10, y: 400, width: 500, height: 80 },
    },
  });
  const summary = summarizeUiStabilitySamples([
    sample(0, { visible: true, x: 0, y: 0, width: 1000, height: 700 }),
    sample(17, { visible: false, x: 0, y: 0, width: 0, height: 0 }),
    sample(92, { visible: true, x: 0, y: 0, width: 1000, height: 700 }),
  ], 4);
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.maxFrameGapMs, 75);
  assert.deepEqual(summary.longFrames, [{ index: 2, frameGapMs: 75 }]);
  assert.deepEqual(summary.visibilityFlaps, [
    { index: 1, target: "appRoot", from: true, to: false },
    { index: 2, target: "appRoot", from: false, to: true },
  ]);
  assert.equal(summary.layoutShifts.length, 0);
  assert.equal(summary.mutationCount, 4);
  assert.equal(summary.possibleFlicker, true);
});
