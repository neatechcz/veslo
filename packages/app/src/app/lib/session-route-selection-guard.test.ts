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
      pendingRouteSessionId: null,
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
      pendingRouteSessionId: null,
    }),
    false,
  );
});

test("does not fallback while the same session is still pending load", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
      pendingRouteSessionId: "sess-1",
    }),
    false,
  );
});

test("still falls back when a different session is pending load", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
      pendingRouteSessionId: "sess-2",
    }),
    true,
  );
});

test("does not fallback when session id is visible in sidebar but not yet in store", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: ["sess-1"],
      pendingRouteSessionId: null,
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
      pendingRouteSessionId: null,
    }),
    true,
  );
});
