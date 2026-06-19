import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const pendingDraftControllerSource = readFileSync(
  new URL("../context/pending-session-draft-controller.ts", import.meta.url),
  "utf8",
);

test("hydrates active pending draft state from the desktop draft store and prefers real session composer keys", () => {
  assert.match(
    pendingDraftControllerSource,
    /const \[activePendingDraftKey, setActivePendingDraftKey\] = createSignal<string \| null>\(null\);/,
    "pending draft controller should track the active pending draft key",
  );
  assert.match(
    pendingDraftControllerSource,
    /const \[activePendingDraftMeta, setActivePendingDraftMeta\] = createSignal<PendingSessionDraftSummary \| null>\(null\);/,
    "pending draft controller should track the active pending draft metadata",
  );
  assert.match(
    source,
    /const \{[\s\S]*activePendingDraftKey,[\s\S]*activePendingDraftMeta,[\s\S]*\} = pendingSessionDraftController;/,
    "app should consume pending draft state from the controller",
  );
  assert.match(
    source,
    /const currentComposerStorageKey = createMemo\(\(\) => \{\s*const sessionId = selectedSessionId\(\);\s*if \(sessionId\) \{\s*return resolveComposerStorageKey\(\{ sessionId \}\);\s*\}\s*return resolveComposerStorageKey\(\{ pendingDraftKey: activePendingDraftKey\(\) \}\);\s*\}\);/s,
    "real sessions should keep their own composer key even when a pending draft remains active in the background",
  );
  assert.doesNotMatch(
    pendingDraftControllerSource,
    /const storedPendingDraftKey = readActivePendingDraftKey\(\);[\s\S]*setActivePendingDraftKey\(storedPendingDraftKey\);[\s\S]*const pendingDrafts = await deps\.pendingSessionDraftsList\(\);/s,
    "startup should not mark a pending draft active before the desktop draft has been validated and loaded",
  );
  assert.match(
    pendingDraftControllerSource,
    /const storedPendingDraftKey = readActivePendingDraftKey\(\);[\s\S]*const pendingDrafts = \(await deps\.pendingSessionDraftsList\(\)\)\.filter\(\(draft\) => !isConsumedPendingDraftId\(draft\.id\)\);[\s\S]*const matchingPendingDraft = findStoredPendingDraftSummary\(\{[\s\S]*storedPendingDraftKey,[\s\S]*pendingDrafts,[\s\S]*\}\);[\s\S]*const loadedPendingDraft = matchingPendingDraft[\s\S]*await deps\.pendingSessionDraftsGet\(matchingPendingDraft\.id\)[\s\S]*const hydrationDecision = resolvePendingDraftStartupHydration\(\{[\s\S]*storedPendingDraftKey,[\s\S]*matchingPendingDraft,[\s\S]*loadedPendingDraft,[\s\S]*restoreError,[\s\S]*\}\);[\s\S]*case "hydrate":[\s\S]*setActivePendingDraftKey\(hydrationDecision\.storageKey\);[\s\S]*setActivePendingDraftMeta\(hydrationDecision\.summary\);[\s\S]*restorePendingDraftComposer\(hydrationDecision\.storageKey, hydrationDecision\.loadedDraft\.draft\.composer\);/s,
    "startup should hydrate the active pending draft from durable desktop storage",
  );
});

test("pending draft hydration failures clear the active draft key in memory and local storage", () => {
  assert.match(
    pendingDraftControllerSource,
    /const clearActivePendingDraftState = \(\) => \{\s*setActivePendingDraftKey\(null\);\s*setActivePendingDraftMeta\(null\);\s*writeActivePendingDraftKey\(null\);\s*\};/s,
    "pending draft controller should define one explicit cleanup path for stale pending draft state",
  );
  assert.match(
    pendingDraftControllerSource,
    /const CONSUMED_PENDING_DRAFT_IDS_KEY = "veslo\.consumed-pending-draft-ids\.v1";[\s\S]*const isConsumedPendingDraftId = \(value: string \| null \| undefined\) => \{[\s\S]*return readConsumedPendingDraftIds\(\)\.has\(trimmed\);[\s\S]*\};/s,
    "pending draft controller should keep an explicit consumed-draft id set so cleanup failures cannot resurrect a draft on restart",
  );
});

test("session route re-selects once when a client becomes available after bootstrap", () => {
  const routeStart = source.indexOf('let lastRouteClientResumeKey = "";');
  const routeEnd = source.indexOf("  createEffect(() => {\r\n    const active = workspaceStore.activeWorkspaceDisplay();", routeStart);
  assert.notStrictEqual(routeStart, -1, "route resume block should exist");
  assert.notStrictEqual(routeEnd, -1, "route resume block end should exist");
  const routeSource = source.slice(routeStart, routeEnd);

  assert.match(routeSource, /let lastRouteClientResumeKey = "";/);
  assert.doesNotMatch(
    routeSource,
    /if \(!client\(\)\) return;/,
    "route selection should keep working when the app has to fall back to the offline transcript loader",
  );
  assert.match(
    routeSource,
    /const routeBrowseScope = resolveSelectedSessionBrowseScope\(id\);[\s\S]*const routeWorkspaceId = routeBrowseScope\?\.workspaceId\?\.trim\(\) \|\| undefined;[\s\S]*const routeWorkspaceRoot =\s*routeBrowseScope\?\.workspaceRoot\?\.trim\(\) \|\|\s*clientDirectory\(\) \|\|\s*workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\);[\s\S]*const connectionKey = \[\s*id,\s*routedClient\(routeWorkspaceId\) \? "live" : "offline",\s*routeWorkspaceId \?\? "",\s*routeWorkspaceRoot,\s*routeBrowseScope\?\.directory\?\.trim\(\) \|\| "",\s*routeBrowseScope\?\.conversationId\?\.trim\(\) \|\| "",\s*routeBrowseScope\?\.opencodeSessionId\?\.trim\(\) \|\| "",\s*connectedVersion\(\) \?\? "",\s*\]\.join\("::"\);/s,
    "route resume key should distinguish live vs offline selection, workspace scope, and workspace root availability",
  );
  assert.match(
    routeSource,
    /const routeResumeDecision = resolveRouteResumeDecision\(\{[\s\S]*routeWorkspaceId,[\s\S]*activeWorkspaceId: workspaceStore\.activeWorkspaceId\(\)\.trim\(\),[\s\S]*\}\);[\s\S]*case "ignore":[\s\S]*if \(routeResumeDecision\.reason === "foreign-workspace"\) \{[\s\S]*lastRouteClientResumeKey = "";[\s\S]*\}/s,
    "route resume should not reselect an old workspace session after the active workspace changes",
  );
  assert.match(
    routeSource,
    /lastConnectionKey: lastRouteClientResumeKey,/,
    "route resume should pass the previous connection key to the controller for duplicate suppression",
  );
  assert.match(
    routeSource,
    /hasBrowseScope: Boolean\(routeBrowseScope\),[\s\S]*visibleMessageCount: visibleMessages\(\)\.length,/s,
    "route resume guard should not skip explicit browse-scope reselection just because another transcript is visible",
  );
  assert.match(
    routeSource,
    /ownNavigationSessionId: routeResumeSelectionAlreadyHandledForSession,[\s\S]*case "consume-own-navigation":[\s\S]*routeResumeSelectionAlreadyHandledForSession = "";[\s\S]*lastRouteClientResumeKey = routeResumeDecision\.connectionKey;[\s\S]*return;/s,
    "route resume should consume createSessionAndOpen's own navigation without re-loading or clearing the new session",
  );
  assert.doesNotMatch(
    routeSource,
    /routeResumeSelectionAlreadyHandledForSession === id[\s\S]*setSelectedSessionId\(id\);/s,
    "route resume guard must not write selectedSessionId; selectSession owns selection state",
  );
  assert.match(
    routeSource,
    /case "select-session":[\s\S]*lastRouteClientResumeKey = routeResumeDecision\.connectionKey;[\s\S]*void selectSession\(routeResumeDecision\.sessionId\);/s,
    "route session should be re-selected once after the client reconnects so deep links survive bootstrap/startHost races",
  );
});

test("createSessionAndOpen injects the new session before selecting it", () => {
  const createStart = source.indexOf("  async function createSessionAndOpen(");
  const createEnd = source.indexOf("  const chooseFolderForCurrentSession = async () =>", createStart);
  assert.notStrictEqual(createStart, -1, "createSessionAndOpen should exist");
  assert.notStrictEqual(createEnd, -1, "createSessionAndOpen block end should exist");
  const createSource = source.slice(createStart, createEnd);
  const handoffIndex = createSource.indexOf("options.onMaterializedSessionId?.({");
  const setSessionsIndex = createSource.indexOf("setSessions([session, ...currentStoreSessions]);");
  const sidebarIndex = createSource.indexOf("materializePendingSessionInWorkspaceSidebar({");
  const ownNavigationIndex = createSource.indexOf("routeResumeSelectionAlreadyHandledForSession = session.id;");
  const selectIndex = createSource.indexOf('mark("session:select:start", { sessionID: session.id });');
  assert.ok(handoffIndex >= 0, "createSessionAndOpen should publish the materialized scoped handoff");
  assert.ok(setSessionsIndex > handoffIndex, "pending-to-real handoff should happen before session store injection");
  assert.ok(sidebarIndex > setSessionsIndex, "sidebar materialization should happen after session store injection");
  assert.ok(ownNavigationIndex > sidebarIndex, "own navigation guard should be set after sidebar materialization");
  assert.ok(selectIndex > ownNavigationIndex, "selectSession should run only after the route guard is armed");

  assert.match(
    createSource,
    /const displaySession = applyPendingInitialSessionTitle\(session\);[\s\S]*options\.onMaterializedSessionId\?\.\(\{[\s\S]*setSessions\(\[session, \.\.\.currentStoreSessions\]\);[\s\S]*materializePendingSessionInWorkspaceSidebar\(\{[\s\S]*const shouldRouteCreatedSession = shouldRouteCreatedSessionAfterSelect\(\{[\s\S]*routeResumeSelectionAlreadyHandledForSession = session\.id;[\s\S]*mark\("session:select:start", \{ sessionID: session\.id \}\);[\s\S]*"createSessionAndOpen:select-session"[\s\S]*mark\("session:select:ok", \{ sessionID: session\.id \}\);[\s\S]*goToSession\(session\.id\);/s,
    "newly created sessions should hand off pending UI, enter session/sidebar state, arm route guard, select, then route",
  );
});

test("bare /session keeps the active pending draft context while clearing real session transcript state", () => {
  const routeStart = source.indexOf('      case "session-route": {');
  const routeEnd = source.indexOf("  return (", routeStart);
  assert.notStrictEqual(routeStart, -1, "session route block should exist");
  assert.notStrictEqual(routeEnd, -1, "session route block end should exist");
  const routeSource = source.slice(routeStart, routeEnd);

  assert.match(
    routeSource,
    /const sessionPathDecision = resolveSessionPathDecision\(\{[\s\S]*path: rawPath,[\s\S]*routeSessionId: id,[\s\S]*activePendingDraftKey: activePendingDraftKey\(\),[\s\S]*\}\);[\s\S]*case "clear-session-view":[\s\S]*if \(sessionPathDecision\.preservePendingDraft\) \{[\s\S]*void activePendingDraftMeta\(\);[\s\S]*\}[\s\S]*if \(selectedSessionId\(\)\) \{[\s\S]*clearDisplayedSessionForBareRoute\(\);[\s\S]*\}/s,
    "switching from a real session to bare /session should use the explicit route clear helper and keep pending draft context",
  );
  assert.doesNotMatch(
    routeSource,
    /if \(activePendingDraftKey\(\)\) \{[\s\S]*setActivePendingDraftKey\(null\)/s,
    "bare /session should not auto-clear the active pending draft",
  );
});
