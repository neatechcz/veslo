import assert from "node:assert/strict";
import test from "node:test";

import { shouldFallbackFromSessionRoute } from "./session-route-selection-guard.js";

test("does not fallback while sessions are not loaded yet", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: false,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
    }),
    false,
  );
});

test("does not fallback when session id exists in store", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: ["sess-1"],
      sessionIdsInSidebar: [],
    }),
    false,
  );
});

test("does not fallback when session id is visible in sidebar but not yet in store", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: ["sess-1"],
    }),
    false,
  );
});

test("falls back when loaded and id is in neither store nor sidebar", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
    }),
    true,
  );
});
