import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const selectionSource = readFileSync(
  new URL("../context/session-selection-controller.ts", import.meta.url),
  "utf8",
);

function createSessionAndOpenSource(): string {
  const start = source.indexOf("  async function createSessionAndOpen(");
  const end = source.indexOf("  const chooseFolderForCurrentSession = async", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen block should be present");
  return source.slice(start, end);
}

test("app delegates created session materialization decisions to session creation flow helpers", () => {
  assert.match(
    source,
    /import \{\s*buildCreatedSidebarSessionItem,\s*resolveCreatedSessionWorkspaceId,\s*shouldRouteCreatedSessionAfterSelect,\s*\} from "\.\/controllers\/session-creation-flow";/,
    "app.tsx should import the session creation flow helpers",
  );
});

test("createSessionAndOpen uses the creation flow helpers before selecting the session", () => {
  const createSource = createSessionAndOpenSource();

  assert.match(
    createSource,
    /const newItem = buildCreatedSidebarSessionItem\(\{[\s\S]*session,[\s\S]*displaySession,[\s\S]*pendingSidebarSession,[\s\S]*\}\);/,
    "sidebar item construction should live in the creation flow helper",
  );
  assert.match(
    createSource,
    /const createdWorkspaceId = resolveCreatedSessionWorkspaceId\(\{[\s\S]*pendingSidebarSession,[\s\S]*targetWorkspaceId: targetWorkspace\?\.workspaceId,[\s\S]*connectingWorkspaceId: workspaceStore\.connectingWorkspaceId\(\),[\s\S]*activeWorkspaceId: workspaceStore\.activeWorkspaceId\(\),[\s\S]*\}\);[\s\S]*if \(createdWorkspaceId\) \{[\s\S]*rememberConversationScope\(\{[\s\S]*workspaceId: createdWorkspaceId,[\s\S]*\}\);[\s\S]*const wsId = createdWorkspaceId;/,
    "workspace id selection should live in the creation flow helper",
  );
  assert.match(
    createSource,
    /const shouldRouteCreatedSession = shouldRouteCreatedSessionAfterSelect\(\{[^}]*blockAppDuringCreate,[^}]*currentView: currentView\(\)[^}]*\}\);[\s\S]*if \(shouldRouteCreatedSession\) \{[\s\S]*routeResumeSelectionAlreadyHandledForSession = session\.id;[\s\S]*\}[\s\S]*mark\("session:select:start", \{ sessionID: session\.id \}\);[\s\S]*"createSessionAndOpen:select-session"[\s\S]*mark\("session:select:ok", \{ sessionID: session\.id \}\);[\s\S]*if \(shouldRouteCreatedSession\) \{[\s\S]*routeResumeSelectionAlreadyHandledForSession = session\.id;[\s\S]*goToSession\(session\.id\);[\s\S]*\}/s,
    "created sessions should mark their own navigation before selecting so bare /session cannot clear the handoff, then route after selection",
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
    source,
    /let lastRouteClientResumeKey = "";[\s\S]*let lastRouteConversationKey = "";[\s\S]*const routeConversationIdentityKeyFor = \(/,
    "app should track route conversation identity separately from connection freshness",
  );
  assert.match(
    source,
    /onSessionRoute: \(\{ rawPath \}\) => \{[\s\S]*const routeBrowseScope = id \? resolveSelectedSessionBrowseScope\(id\) : null;[\s\S]*const routeConversationKey = routeConversationIdentityKeyFor\(id, routeBrowseScope\);[\s\S]*case "consume-own-navigation":[\s\S]*routeResumeSelectionAlreadyHandledForSession = "";[\s\S]*if \(routeConversationKey\) \{[\s\S]*lastRouteConversationKey = routeConversationKey;[\s\S]*\}/s,
    "the startup/session path effect should seed lastRouteConversationKey when it consumes create-session navigation",
  );
});
