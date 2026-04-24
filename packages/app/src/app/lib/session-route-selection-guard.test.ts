import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shouldFallbackFromSessionRoute } from "./session-route-selection-guard.js";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

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

test("still falls back for a real route id when a pending-draft-shaped key leaks through", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
      pendingRouteSessionId: "__pending-draft__:directory:workspace-1:/Users/demo/project",
    }),
    true,
  );
});

test("real session route fallback ignores active pending draft context", () => {
  const routeStart = appSource.indexOf('    if (path.startsWith("/session")) {');
  const routeEnd = appSource.indexOf('    if (path.startsWith("/proto-v1-ux")) {', routeStart);
  assert.notStrictEqual(routeStart, -1, "session route block should exist");
  assert.notStrictEqual(routeEnd, -1, "session route block end should exist");
  const routeSource = appSource.slice(routeStart, routeEnd);

  assert.match(
    routeSource,
    /shouldFallbackFromSessionRoute\(\{\s*sessionsLoaded: sessionsLoaded\(\),\s*routeSessionId: id,\s*sessionIdsInStore,\s*sessionIdsInSidebar,\s*pendingRouteSessionId: pendingSessionLoad\(\)\?\.sessionId \?\? null,\s*\}\)/s,
    "real session route fallback should keep using only real session ids plus the in-flight route session id",
  );
  assert.doesNotMatch(
    routeSource,
    /shouldFallbackFromSessionRoute\(\{[\s\S]*activePendingDraftKey/s,
    "pending draft context must not make /session/<real-id> look valid",
  );
});
