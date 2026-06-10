import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shouldFallbackFromSessionRoute } from "../../lib/session-route-selection-guard.js";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

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

test("real session route fallback ignores active pending draft context", () => {
  const routeStart = appSource.indexOf('    if (path.startsWith("/session")) {');
  const routeEnd = appSource.indexOf('    if (path.startsWith("/proto-v1-ux")) {', routeStart);
  assert.notStrictEqual(routeStart, -1, "session route block should exist");
  assert.notStrictEqual(routeEnd, -1, "session route block end should exist");
  const routeSource = appSource.slice(routeStart, routeEnd);

  assert.match(
    routeSource,
    /shouldFallbackFromSessionRoute\(\{\s*sessionsLoaded: sessionsLoaded\(\),\s*routeSessionId: id,\s*sessionIdsInStore,\s*sessionIdsInSidebar,\s*\}\)/s,
    "real session route fallback should use persisted session ids and sidebar ids without pending preloader state",
  );
  assert.doesNotMatch(
    routeSource,
    /pendingRouteSessionId|pendingSessionLoad/,
    "real session route fallback should not depend on pending-session preloader state",
  );
  assert.doesNotMatch(
    routeSource,
    /shouldFallbackFromSessionRoute\(\{[\s\S]*activePendingDraftKey/s,
    "pending draft context must not make /session/<real-id> look valid",
  );
});

test("pending draft hydration error paths clear stale active draft state", () => {
  assert.match(
    appSource,
    /if \(!matchingPendingDraft\) \{\s*clearActivePendingDraftState\(\);/s,
    "missing desktop drafts should clear the active pending draft state",
  );
  assert.match(
    appSource,
    /if \(!loadedPendingDraft\) \{\s*clearActivePendingDraftState\(\);/s,
    "null desktop draft loads should clear the active pending draft state",
  );
  assert.match(
    appSource,
    /catch \(error\) \{\s*reportError\(error, "pendingDrafts\.hydrate"\);\s*clearActivePendingDraftState\(\);\s*\}/s,
    "desktop draft load failures should clear the active pending draft state",
  );
});
