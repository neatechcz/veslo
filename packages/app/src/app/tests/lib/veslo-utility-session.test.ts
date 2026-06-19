import assert from "node:assert/strict";
import test from "node:test";

import {
  isVesloUtilitySessionTitle,
  partitionVesloUtilitySessions,
} from "../../lib/veslo-utility-session.js";

test("detects leaked internal classifier sessions by title", () => {
  assert.equal(isVesloUtilitySessionTitle("[Veslo] Subagent role classifier"), true);
  assert.equal(isVesloUtilitySessionTitle("[Veslo] Connection test · openai"), true);
  assert.equal(isVesloUtilitySessionTitle("Normal user session"), false);
});

test("partitions internal utility sessions away from visible sidebar rows", () => {
  const { visible, utility } = partitionVesloUtilitySessions([
    { id: "a", title: "[Veslo] Subagent role classifier" },
    { id: "b", title: "Customer follow-up" },
    { id: "c", title: "[Veslo] Connection test · anthropic" },
  ]);

  assert.deepEqual(visible.map((item) => item.id), ["b"]);
  assert.deepEqual(utility.map((item) => item.id), ["a", "c"]);
});
