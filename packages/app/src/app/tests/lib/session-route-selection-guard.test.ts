import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shouldFallbackFromSessionRoute } from "../../lib/session-route-selection-guard.js";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const pendingDraftControllerSource = readFileSync(
  new URL("../../context/pending-session-draft-controller.ts", import.meta.url),
  "utf8",
);
const workspaceSessionSelectionSource = readFileSync(
  new URL("../../context/workspace-session-selection.ts", import.meta.url),
  "utf8",
);

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

test("does not fallback when session id is known only from scoped conversation routing", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "conversation-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
      scopedSessionIds: ["conversation-1", "opencode-1"],
    }),
    false,
  );
});

test("does not fallback from a known scoped route that belongs to another workspace", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: false,
      routeSessionId: "sess-1",
      routeWorkspaceId: "ws-old",
      activeWorkspaceId: "ws-new",
      sessionIdsInStore: ["sess-1"],
      sessionIdsInSidebar: ["sess-1"],
      scopedSessionIds: ["sess-1"],
      selectedSessionId: "sess-1",
      visibleMessageCount: 4,
      selectedSessionStatus: "running",
    }),
    false,
  );
});

test("falls back from an unknown scoped route that belongs to another active workspace", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: false,
      routeSessionId: "sess-1",
      routeWorkspaceId: "ws-old",
      activeWorkspaceId: "ws-new",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
      scopedSessionIds: [],
    }),
    true,
  );
});

test("does not fallback while the routed session is still displayed or running", () => {
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
      selectedSessionId: "sess-1",
      visibleMessageCount: 1,
    }),
    false,
  );
  assert.equal(
    shouldFallbackFromSessionRoute({
      sessionsLoaded: true,
      routeSessionId: "sess-1",
      sessionIdsInStore: [],
      sessionIdsInSidebar: [],
      selectedSessionId: "sess-1",
      selectedSessionStatus: "busy",
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
  const routeStart = appSource.indexOf('      case "session-route": {');
  const routeEnd = appSource.indexOf("  return (", routeStart);
  assert.notStrictEqual(routeStart, -1, "session route block should exist");
  assert.notStrictEqual(routeEnd, -1, "session route block end should exist");
  const routeSource = appSource.slice(routeStart, routeEnd);

  assert.match(
    workspaceSessionSelectionSource,
    /const scopedSessionIds = \(\) => \[[\s\S]*new Set\([\s\S]*Object\.values\(conversationScopeBySessionId\(\)\)\.flatMap\(\(scopes\) =>[\s\S]*scope\.sessionId,[\s\S]*scope\.conversationId \?\? "",[\s\S]*scope\.opencodeSessionId \?\? "",[\s\S]*\.filter\(Boolean\),[\s\S]*\]/s,
    "workspace session selection should expose deduplicated scoped conversation ids for route fallback",
  );
  assert.match(
    routeSource,
    /const routeBrowseScope = id \? resolveSelectedSessionBrowseScope\(id\) : null;[\s\S]*const routeWorkspaceId = routeBrowseScope\?\.workspaceId \?\? null;[\s\S]*shouldFallbackFromSessionRoute\(\{\s*sessionsLoaded: sessionsLoadedForActiveWorkspace\(\),\s*routeSessionId: id,\s*routeWorkspaceId,\s*activeWorkspaceId: workspaceStore\.activeWorkspaceId\(\),\s*sessionIdsInStore,\s*sessionIdsInSidebar,\s*scopedSessionIds: scopedSessionIds\(\),\s*selectedSessionId: selectedSessionId\(\),\s*visibleMessageCount: visibleMessages\(\)\.length,\s*selectedSessionStatus: visibleSelectedSessionStatus\(\),\s*selectedSessionLoadingEarlierMessages: selectedSessionLoadingEarlierMessages\(\),\s*\}\)/s,
    "real session route fallback should use persisted, sidebar, scoped, and currently displayed session state without pending preloader state",
  );
  assert.match(
    appSource,
    /const sessionsLoadedForActiveWorkspace = \(\) => \{[\s\S]*if \(!activeWorkspaceId \|\| !activeWorkspaceIsHydrated\(\) \|\| !ready\) return false;[\s\S]*if \(!workspaceRouting\.entry\(activeWorkspaceId\) && !routedClient\(activeWorkspaceId\)\) return false;[\s\S]*if \(ready\.workspaceId !== activeWorkspaceId\) return false;[\s\S]*ready\.workspaceRoot !== activeWorkspaceRoot/s,
    "route fallback readiness should be scoped to the hydrated active workspace and root",
  );
  assert.doesNotMatch(
    routeSource,
    /pendingRouteSessionId|pendingSessionLoad/,
    "real session route fallback should not depend on pending-session preloader state",
  );
  const fallbackCallStart = routeSource.indexOf("shouldFallbackFromSessionRoute({");
  const fallbackCallEnd = routeSource.indexOf("})", fallbackCallStart);
  assert.notStrictEqual(fallbackCallStart, -1, "session route fallback call should exist");
  assert.notStrictEqual(fallbackCallEnd, -1, "session route fallback call should end");
  const fallbackCallSource = routeSource.slice(fallbackCallStart, fallbackCallEnd);

  assert.doesNotMatch(
    fallbackCallSource,
    /activePendingDraftKey/,
    "pending draft context must not make /session/<real-id> look valid",
  );
});

test("pending draft hydration error paths clear stale active draft state", () => {
  assert.match(
    pendingDraftControllerSource,
    /const hydrationDecision = resolvePendingDraftStartupHydration\(\{[\s\S]*matchingPendingDraft,[\s\S]*loadedPendingDraft,[\s\S]*\}\);[\s\S]*case "clear":[\s\S]*clearActivePendingDraftState\(\);/s,
    "missing or null desktop drafts should clear the active pending draft state through the hydration decision",
  );
  assert.match(
    pendingDraftControllerSource,
    /catch \(error\) \{\s*deps\.reportError\(error, "pendingDrafts\.hydrate"\);\s*clearActivePendingDraftState\(\);\s*\}/s,
    "desktop draft load failures should clear the active pending draft state",
  );
});
