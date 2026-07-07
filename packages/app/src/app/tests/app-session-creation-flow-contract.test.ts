import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const creationWorkflowSource = readFileSync(
  new URL("../pages/session-creation-workflow.ts", import.meta.url),
  "utf8",
);
const routeSyncSource = readFileSync(
  new URL("../context/session-route-sync.ts", import.meta.url),
  "utf8",
);
const selectionSource = readFileSync(
  new URL("../context/session-selection-controller.ts", import.meta.url),
  "utf8",
);

function createSessionAndOpenSource(): string {
  const start = creationWorkflowSource.indexOf("  const createSessionAndOpen = async (");
  const endMatch = /\r?\n\r?\n  return \{/.exec(creationWorkflowSource.slice(start));
  const end = endMatch ? start + endMatch.index : -1;
  assert.ok(start >= 0 && end > start, "createSessionAndOpen block should be present");
  return creationWorkflowSource.slice(start, end);
}

test("app delegates created session materialization decisions to session creation flow helpers", () => {
  assert.match(
    creationWorkflowSource,
    /import \{[\s\S]*resolveCreatedSessionWorkspaceId,[\s\S]*shouldRouteCreatedSessionAfterSelect,[\s\S]*type CreatedSession,[\s\S]*\} from "\.\.\/controllers\/session-creation-flow";/,
    "the session creation workflow module should own session creation routing decisions",
  );
  assert.match(
    source,
    /import \{[\s\S]*buildCreatedSidebarSessionItem,[\s\S]*\} from "\.\/controllers\/session-creation-flow";/,
    "app.tsx should keep sidebar materialization on the app-side state boundary",
  );
  assert.match(
    source,
    /import \{[\s\S]*createSessionCreationWorkflow,[\s\S]*type SessionCreationWorkflowCreateOptions,[\s\S]*\} from "\.\/pages\/session-creation-workflow";/,
    "app.tsx should import the session creation workflow module",
  );
  assert.match(
    source,
    /const sessionCreationWorkflow = createSessionCreationWorkflow\(\{[\s\S]*applyCreatedSessionState,[\s\S]*applyCreatedSessionTransition,[\s\S]*createConversationFromVesloWriteApi:[\s\S]*submitConversationFromVesloWriteApi:[\s\S]*\}\);/,
    "app.tsx should wire app state effects and Veslo conversation creation into the workflow",
  );
});

test("createSessionAndOpen uses the creation flow helpers before selecting the session", () => {
  const createSource = creationWorkflowSource.slice(
    creationWorkflowSource.indexOf("  const runCreateSessionFlow = async ("),
    creationWorkflowSource.indexOf("  const createSession = ("),
  );
  const applyStateStart = source.indexOf("  const applyCreatedSessionState = (");
  const applyTransitionStart = source.indexOf("  const applyCreatedSessionTransition = async");
  const workflowStart = source.indexOf("  const sessionCreationWorkflow = createSessionCreationWorkflow", applyTransitionStart);
  assert.notEqual(applyStateStart, -1, "app-side created session state helper should exist");
  assert.notEqual(applyTransitionStart, -1, "app-side created session transition helper should exist");
  assert.notEqual(workflowStart, -1, "session creation workflow wiring should exist");
  const applyStateSource = source.slice(applyStateStart, applyTransitionStart);
  const applyTransitionSource = source.slice(applyTransitionStart, workflowStart);

  assert.match(
    createSource,
    /const createdWorkspaceId = resolveCreatedSessionWorkspaceId\(\{[\s\S]*pendingSidebarSession,[\s\S]*targetWorkspaceId: targetWorkspace\?\.workspaceId,[\s\S]*connectingWorkspaceId: deps\.workspace\.connectingWorkspaceId\(\),[\s\S]*activeWorkspaceId: deps\.workspace\.activeWorkspaceId\(\),[\s\S]*\}\);/,
    "workspace id selection should live in the creation workflow helper",
  );
  assert.match(
    createSource,
    /transition: \{[\s\S]*shouldRouteAfterSelect: shouldRouteCreatedSessionAfterSelect\(\{[\s\S]*blockAppDuringCreate,[\s\S]*currentView: deps\.currentView\(\),[\s\S]*\}\),[\s\S]*sessionId: createdSession\.id,[\s\S]*\},/,
    "route-after-select decision should stay inside the creation workflow result",
  );
  assert.match(
    applyStateSource,
    /rememberConversationScope\(\{[\s\S]*sessionId: result\.sessionId,[\s\S]*workspaceId: result\.workspaceScope\.workspaceId,[\s\S]*\}\);[\s\S]*buildCreatedSidebarSessionItem\(\{[\s\S]*session: result\.session,[\s\S]*displaySession,[\s\S]*pendingSidebarSession: result\.pendingSession,[\s\S]*\}\)[\s\S]*options\.onMaterializedSessionId\?\.\(result\.handoff\);/s,
    "app-side state helper should publish scope, materialize the sidebar row, and emit the scoped handoff",
  );
  assert.match(
    applyTransitionSource,
    /if \(result\.transition\.shouldRouteAfterSelect\) \{[\s\S]*sessionRouteSync\.markOwnNavigationSession\(sessionId\);[\s\S]*\}[\s\S]*await selectSession\(sessionId\);[\s\S]*catch \(selectError\) \{[\s\S]*sessionRouteSync\.clearOwnNavigationSessionIf\(sessionId\);[\s\S]*throw selectError;[\s\S]*\}[\s\S]*if \(result\.transition\.shouldRouteAfterSelect\) \{[\s\S]*sessionRouteSync\.markOwnNavigationSession\(sessionId\);[\s\S]*goToSession\(sessionId\);[\s\S]*\}/s,
    "created sessions should arm route handoff before selecting, clear it on selection failure, then route after selection",
  );
});

test("late session refreshes retain the selected session injected by createSessionAndOpen", () => {
  assert.match(
    selectionSource,
    /let nextSessions = sortSessionsByActivity\(Array\.from\(merged\.values\(\)\)\);[\s\S]*const selectedSessionId = deps\.selectedSessionId\(\)\?\.trim\(\) \?\? "";[\s\S]*!nextSessions\.some\(\(session\) => session\.id === selectedSessionId\)[\s\S]*deps\.store\.sessions\.find\(\(session\) => session\.id === selectedSessionId\)[\s\S]*sessionDirectoryMatchesRoot\(selectedSessionDirectory, root\)[\s\S]*nextSessions = sortSessionsByActivity\(\[selected, \.\.\.nextSessions\]\);/s,
    "loadSessions should not let a delayed list response remove the currently displayed session before the backend index catches up",
  );
});

test("session route own-navigation records conversation identity for later route resume dedupe", () => {
  assert.match(
    routeSyncSource,
    /let lastRouteClientResumeKey = "";[\s\S]*let lastRouteConversationKey = "";[\s\S]*const routeConversationIdentityKeyFor = \(/,
    "session route sync should track route conversation identity separately from connection freshness",
  );
  assert.match(
    routeSyncSource,
    /const handleSessionRoute = async \(\{ rawPath \}: \{ rawPath: string \}\) => \{[\s\S]*const routeBrowseScope = id \? deps\.resolveSelectedSessionBrowseScope\(id\) : null;[\s\S]*const routeConversationKey = routeConversationIdentityKeyFor\(id, routeBrowseScope\);[\s\S]*case "consume-own-navigation":[\s\S]*routeResumeSelectionAlreadyHandledForSession = "";[\s\S]*if \(routeConversationKey\) \{[\s\S]*lastRouteConversationKey = routeConversationKey;[\s\S]*\}/s,
    "session route sync should seed lastRouteConversationKey when it consumes create-session navigation",
  );
  assert.match(
    source,
    /appRouteSync\.startStartupRouteSync\(\{[\s\S]*onSessionRoute: sessionRouteSync\.handleSessionRoute,[\s\S]*\}\);/,
    "app should delegate top-level session route handling to the session route-sync owner",
  );
});
