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
  const end = creationWorkflowSource.indexOf("\n\n  return {", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen block should be present");
  return creationWorkflowSource.slice(start, end);
}

test("app delegates created session materialization decisions to session creation flow helpers", () => {
  assert.match(
    creationWorkflowSource,
    /import \{\s*buildCreatedSidebarSessionItem,\s*resolveCreatedSessionWorkspaceId,\s*shouldRouteCreatedSessionAfterSelect,\s*type CreatedSession,\s*\} from "\.\.\/controllers\/session-creation-flow";/,
    "the session creation workflow module should own the creation flow helpers",
  );
  assert.match(
    source,
    /import \{\s*createSessionCreationWorkflow,\s*type SessionCreationWorkflowCreateOptions,\s*\} from "\.\/pages\/session-creation-workflow";/,
    "app.tsx should import the session creation workflow module",
  );
  assert.match(
    source,
    /const sessionCreationWorkflow = createSessionCreationWorkflow\(\{[\s\S]*sessionRouteSync,[\s\S]*createConversationFromVesloWriteApi[\s\S]*\}\);/,
    "app.tsx should wire route handoff and Veslo conversation creation into the workflow",
  );
});

test("createSessionAndOpen uses the creation flow helpers before selecting the session", () => {
  const createSource = createSessionAndOpenSource();

  assert.match(
    createSource,
    /const newItem = buildCreatedSidebarSessionItem\(\{[\s\S]*session: createdSession,[\s\S]*displaySession,[\s\S]*pendingSidebarSession,[\s\S]*\}\);/,
    "sidebar item construction should live in the creation flow helper",
  );
  assert.match(
    createSource,
    /const createdWorkspaceId = resolveCreatedSessionWorkspaceId\(\{[\s\S]*pendingSidebarSession,[\s\S]*targetWorkspaceId: targetWorkspace\?\.workspaceId,[\s\S]*connectingWorkspaceId: deps\.workspace\.connectingWorkspaceId\(\),[\s\S]*activeWorkspaceId: deps\.workspace\.activeWorkspaceId\(\),[\s\S]*\}\);[\s\S]*if \(createdWorkspaceId\) \{[\s\S]*deps\.rememberConversationScope\(\{[\s\S]*workspaceId: createdWorkspaceId,[\s\S]*\}\);[\s\S]*const wsId = createdWorkspaceId;/,
    "workspace id selection should live in the creation flow helper",
  );
  assert.match(
    createSource,
    /const shouldRouteCreatedSession = shouldRouteCreatedSessionAfterSelect\(\{[^}]*blockAppDuringCreate,[^}]*currentView: deps\.currentView\(\)[^}]*\}\);[\s\S]*if \(shouldRouteCreatedSession\) \{[\s\S]*deps\.sessionRouteSync\.markOwnNavigationSession\(createdSession\.id\);[\s\S]*\}[\s\S]*mark\("session:select:start", \{ sessionID: createdSession\.id \}\);[\s\S]*"createSessionAndOpen:select-session"[\s\S]*catch \(selectError\) \{[\s\S]*deps\.sessionRouteSync\.clearOwnNavigationSessionIf\(createdSession\.id\);[\s\S]*throw selectError;[\s\S]*\}[\s\S]*mark\("session:select:ok", \{ sessionID: createdSession\.id \}\);[\s\S]*if \(shouldRouteCreatedSession\) \{[\s\S]*deps\.sessionRouteSync\.markOwnNavigationSession\(createdSession\.id\);[\s\S]*deps\.goToSession\(createdSession\.id\);[\s\S]*\}/s,
    "created sessions should seed the route-sync own-navigation handoff before selecting, clear it on selection failure, then route after selection",
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
