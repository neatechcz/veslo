import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const routeSyncSource = readFileSync(new URL("../context/session-route-sync.ts", import.meta.url), "utf8");
const createWorkflowSource = readFileSync(new URL("../pages/session-creation-workflow.ts", import.meta.url), "utf8");
const pendingDraftControllerSource = readFileSync(
  new URL("../context/pending-session-draft-controller.ts", import.meta.url),
  "utf8",
);
const composerDraftSource = readFileSync(new URL("../pages/session-composer-drafts.ts", import.meta.url), "utf8");

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
    /const currentComposerStorageKey = createMemo\(\(\)\s*=>\s*resolveActiveComposerDraftStorageKey\(\{\s*selectedSessionId: selectedSessionId\(\),\s*pendingDraftKey: activePendingDraftKey\(\),\s*materializingSessionId: materializingComposerDraftSessionId\(\),\s*\}\),\s*\);/s,
    "real sessions should keep their own composer key even when a pending draft remains active in the background",
  );
  assert.match(
    composerDraftSource,
    /const selected = selectedSessionId\?\.trim\(\) \?\? "";\s*if \(selected\) return resolveComposerStorageKey\(\{ sessionId: selected \}\);[\s\S]*const materializing = materializingSessionId\?\.trim\(\) \?\? "";\s*if \(materializing\) return resolveComposerStorageKey\(\{ sessionId: materializing \}\);[\s\S]*return resolveComposerStorageKey\(\{ pendingDraftKey \}\);/s,
    "the composer draft helper should prefer selected and materializing real sessions over pending draft keys",
  );
  assert.doesNotMatch(
    pendingDraftControllerSource,
    /const storedPendingDraftKey = readActivePendingDraftKey\(\);[\s\S]*setActivePendingDraftKey\(storedPendingDraftKey\);[\s\S]*const pendingDrafts = await deps\.pendingSessionDraftsList\(\);/s,
    "startup should not mark a pending draft active before the desktop draft has been validated and loaded",
  );
  assert.match(
    pendingDraftControllerSource,
    /const listGlobalPendingDraftSummaries = async \(\) =>[\s\S]*\(await deps\.pendingSessionDraftsList\(\)\)\.filter\([\s\S]*\(draft\) => isGlobalUnpublishedPendingDraftSummary\(draft\) && !isConsumedPendingDraftId\(draft\.id\),[\s\S]*\);[\s\S]*const storedPendingDraftKey = readActivePendingDraftKey\(\);[\s\S]*const pendingDrafts = await listGlobalPendingDraftSummaries\(\);[\s\S]*const matchingPendingDraft = findStoredPendingDraftSummary\(\{[\s\S]*storedPendingDraftKey,[\s\S]*pendingDrafts,[\s\S]*\}\);[\s\S]*const loadedPendingDraft = matchingPendingDraft[\s\S]*await deps\.pendingSessionDraftsGet\(matchingPendingDraft\.id\)[\s\S]*const hydrationDecision = resolvePendingDraftStartupHydration\(\{[\s\S]*storedPendingDraftKey,[\s\S]*matchingPendingDraft,[\s\S]*loadedPendingDraft,[\s\S]*restoreError,[\s\S]*\}\);[\s\S]*case "hydrate":[\s\S]*setActivePendingDraftKey\(hydrationDecision\.storageKey\);[\s\S]*setActivePendingDraftMeta\(hydrationDecision\.summary\);[\s\S]*restorePendingDraftComposer\(hydrationDecision\.storageKey, hydrationDecision\.loadedDraft\.draft\.composer\);/s,
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
  const routeStart = routeSyncSource.indexOf("  const handleRouteResume = async () => {");
  const routeEnd = routeSyncSource.indexOf("  const handleSessionRoute = async", routeStart);
  assert.notStrictEqual(routeStart, -1, "route resume block should exist");
  assert.notStrictEqual(routeEnd, -1, "route resume block end should exist");
  const routeSource = routeSyncSource.slice(routeStart, routeEnd);

  assert.match(routeSyncSource, /let lastRouteClientResumeKey = "";/);
  assert.doesNotMatch(
    routeSource,
    /if \(!client\(\)\) return;/,
    "route selection should keep working when the app has to fall back to the offline transcript loader",
  );
  assert.match(
    routeSource,
    /const routeBrowseScope = deps\.resolveSelectedSessionBrowseScope\(id\);[\s\S]*const routeWorkspaceId = routeBrowseScope\?\.workspaceId\?\.trim\(\) \|\| undefined;[\s\S]*const routeWorkspaceRoot =\s*routeBrowseScope\?\.workspaceRoot\?\.trim\(\) \|\|\s*deps\.clientDirectory\(\) \|\|\s*deps\.activeWorkspaceRoot\(\)\.trim\(\);[\s\S]*const connectionKey = \[\s*id,\s*deps\.routedClient\(routeWorkspaceId\) \? "live" : "offline",\s*routeWorkspaceId \?\? "",\s*routeWorkspaceRoot,\s*routeBrowseScope\?\.directory\?\.trim\(\) \|\| "",\s*routeBrowseScope\?\.conversationId\?\.trim\(\) \|\| "",\s*routeBrowseScope\?\.opencodeSessionId\?\.trim\(\) \|\| "",\s*deps\.connectedVersion\(\) \?\? "",\s*\]\.join\("::"\);/s,
    "route resume key should distinguish live vs offline selection, workspace scope, and workspace root availability",
  );
  assert.match(
    routeSource,
    /const routeResumeDecision = resolveRouteResumeDecision\(\{[\s\S]*routeWorkspaceId,[\s\S]*activeWorkspaceId: deps\.activeWorkspaceId\(\)\.trim\(\),[\s\S]*\}\);[\s\S]*case "ignore":[\s\S]*if \(routeResumeDecision\.reason === "foreign-workspace"\) \{[\s\S]*lastRouteClientResumeKey = "";[\s\S]*\}/s,
    "route resume should not reselect an old workspace session after the active workspace changes",
  );
  assert.match(
    routeSource,
    /lastConnectionKey: lastRouteClientResumeKey,/,
    "route resume should pass the previous connection key to the controller for duplicate suppression",
  );
  assert.match(
    routeSource,
    /hasBrowseScope: Boolean\(routeBrowseScope\),[\s\S]*visibleMessageCount: deps\.visibleMessages\(\)\.length,/s,
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
    /case "select-session":[\s\S]*lastRouteClientResumeKey = routeResumeDecision\.connectionKey;[\s\S]*await deps\.selectSession\(routeResumeDecision\.sessionId\);/s,
    "route session should be re-selected once after the client reconnects so deep links survive bootstrap/startHost races",
  );
});

test("createSessionAndOpen injects the new session before selecting it", () => {
  const applyStateStart = source.indexOf("  const applyCreatedSessionState = (");
  const applyTransitionStart = source.indexOf("  const applyCreatedSessionTransition = async");
  const workflowStart = source.indexOf("  const sessionCreationWorkflow = createSessionCreationWorkflow", applyTransitionStart);
  assert.notStrictEqual(applyStateStart, -1, "created session state helper should exist");
  assert.notStrictEqual(applyTransitionStart, -1, "created session transition helper should exist");
  assert.notStrictEqual(workflowStart, -1, "session creation workflow should be wired");
  const stateSource = source.slice(applyStateStart, applyTransitionStart);
  const transitionSource = source.slice(applyTransitionStart, workflowStart);
  const handoffIndex = stateSource.indexOf("options.onMaterializedSessionId?.(result.handoff);");
  const setSessionsIndex = stateSource.indexOf("setSessions([result.session, ...currentStoreSessions]);");
  const sidebarIndex = stateSource.indexOf("materializePendingSessionInWorkspaceSidebar({");
  const ownNavigationIndex = transitionSource.indexOf("sessionRouteSync.markOwnNavigationSession(sessionId);");
  const selectIndex = transitionSource.indexOf("await selectSession(sessionId");
  assert.ok(setSessionsIndex >= 0, "created session should be injected into the session store");
  assert.ok(sidebarIndex > setSessionsIndex, "sidebar materialization should happen after session store injection");
  assert.ok(handoffIndex > sidebarIndex, "scoped materialized handoff should publish after sidebar materialization");
  assert.ok(ownNavigationIndex >= 0, "own navigation guard should be set before selection");
  assert.ok(selectIndex > ownNavigationIndex, "selectSession should run only after the route guard is armed");

  assert.match(
    `${stateSource}\n${transitionSource}`,
    /const displaySession = applyPendingInitialSessionTitle\(result\.session\);[\s\S]*setSessions\(\[result\.session, \.\.\.currentStoreSessions\]\);[\s\S]*materializePendingSessionInWorkspaceSidebar\(\{[\s\S]*options\.onMaterializedSessionId\?\.\(result\.handoff\);[\s\S]*sessionRouteSync\.markOwnNavigationSession\(sessionId\);[\s\S]*await selectSession\(sessionId, \{[\s\S]*skipTranscriptRead: result\.transition\.skipTranscriptRead === true,[\s\S]*\}\);[\s\S]*goToSession\(sessionId\);/s,
    "newly created sessions should enter session/sidebar state, publish handoff, arm route guard, select, then route",
  );
});

test("bare /session keeps the active pending draft context while clearing real session transcript state", () => {
  const routeStart = routeSyncSource.indexOf("  const handleSessionRoute = async");
  const routeEnd = routeSyncSource.indexOf("  const startRouteResumeEffect = () => {", routeStart);
  assert.notStrictEqual(routeStart, -1, "session route block should exist");
  assert.notStrictEqual(routeEnd, -1, "session route block end should exist");
  const routeSource = routeSyncSource.slice(routeStart, routeEnd);

  assert.match(
    routeSource,
    /const sessionPathDecision = resolveSessionPathDecision\(\{[\s\S]*path: rawPath,[\s\S]*routeSessionId: id,[\s\S]*activePendingDraftKey: deps\.activePendingDraftKey\(\),[\s\S]*\}\);[\s\S]*case "clear-session-view":[\s\S]*if \(sessionPathDecision\.preservePendingDraft\) \{[\s\S]*void deps\.activePendingDraftMeta\(\);[\s\S]*\}[\s\S]*if \(deps\.selectedSessionId\(\)\) \{[\s\S]*clearDisplayedSessionForBareRoute\(\);[\s\S]*\}/s,
    "switching from a real session to bare /session should use the explicit route clear helper and keep pending draft context",
  );
  assert.doesNotMatch(
    routeSource,
    /if \(activePendingDraftKey\(\)\) \{[\s\S]*setActivePendingDraftKey\(null\)/s,
    "bare /session should not auto-clear the active pending draft",
  );
});
