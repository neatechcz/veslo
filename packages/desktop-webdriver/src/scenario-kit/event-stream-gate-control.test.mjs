import assert from "node:assert/strict";
import test from "node:test";

import { sameEngineGeneration } from "./event-stream-gate-control.mjs";

test("event-stream gate generation comparison requires the exact pooled owner", () => {
  const engine = {
    workspaceId: "ws-a",
    engineOwnerId: "owner-a",
    directoryInstanceEpoch: 4,
    pid: 1234,
    spawnedAt: 100,
  };
  assert.equal(sameEngineGeneration(engine, { ...engine }), true);
  assert.equal(sameEngineGeneration(engine, { ...engine, engineOwnerId: "owner-b" }), false);
  assert.equal(sameEngineGeneration(engine, { ...engine, directoryInstanceEpoch: 5 }), false);
});
