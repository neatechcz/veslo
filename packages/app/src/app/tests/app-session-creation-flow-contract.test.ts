import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../context/session.ts", import.meta.url), "utf8");

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
    /const wsId = resolveCreatedSessionWorkspaceId\(\{[\s\S]*pendingSidebarSession,[\s\S]*targetWorkspaceId: targetWorkspace\?\.workspaceId,[\s\S]*connectingWorkspaceId: workspaceStore\.connectingWorkspaceId\(\),[\s\S]*activeWorkspaceId: workspaceStore\.activeWorkspaceId\(\),[\s\S]*\}\);/,
    "workspace id selection should live in the creation flow helper",
  );
  assert.match(
    createSource,
    /mark\("session:select:start", \{ sessionID: session\.id \}\);[\s\S]*"createSessionAndOpen:select-session"[\s\S]*mark\("session:select:ok", \{ sessionID: session\.id \}\);[\s\S]*if \(shouldRouteCreatedSessionAfterSelect\(\{[^}]*blockAppDuringCreate,[^}]*currentView: currentView\(\)[^}]*\}\)\) \{[\s\S]*routeResumeSelectionAlreadyHandledForSession = session\.id;[\s\S]*goToSession\(session\.id\);[\s\S]*\}/s,
    "created sessions should select before routing so route effects only consume already-selected own navigation",
  );
});

test("late session refreshes retain the selected session injected by createSessionAndOpen", () => {
  assert.match(
    sessionSource,
    /let nextSessions = sortSessionsByActivity\(Array\.from\(merged\.values\(\)\)\);[\s\S]*const selectedSessionId = options\.selectedSessionId\(\)\?\.trim\(\) \?\? "";[\s\S]*!nextSessions\.some\(\(session\) => session\.id === selectedSessionId\)[\s\S]*store\.sessions\.find\(\(session\) => session\.id === selectedSessionId\)[\s\S]*sessionDirectoryMatchesRoot\(selectedSessionDirectory, root\)[\s\S]*nextSessions = sortSessionsByActivity\(\[selectedSession, \.\.\.nextSessions\]\);/s,
    "loadSessions should not let a delayed list response remove the currently displayed session before the backend index catches up",
  );
});
