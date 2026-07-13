import assert from "node:assert/strict";
import test from "node:test";

import { shouldDeferToolErrorToLifecycle } from "../../context/session.js";

test("tool errors defer only to the exact lifecycle scope", () => {
  const observations: Array<{ sessionId: string; workspaceId: string }> = [];

  assert.equal(
    shouldDeferToolErrorToLifecycle(" sess-a ", " ws-a ", (sessionId, workspaceId) => {
      observations.push({ sessionId, workspaceId });
      return true;
    }),
    true,
  );
  assert.deepEqual(observations, [{ sessionId: "sess-a", workspaceId: "ws-a" }]);
});

test("tool errors retain the local fallback without a complete lifecycle scope", () => {
  let observed = false;
  const observe = () => {
    observed = true;
    return true;
  };

  assert.equal(shouldDeferToolErrorToLifecycle("sess-a", "", observe), false);
  assert.equal(shouldDeferToolErrorToLifecycle("", "ws-a", observe), false);
  assert.equal(observed, false);
});
