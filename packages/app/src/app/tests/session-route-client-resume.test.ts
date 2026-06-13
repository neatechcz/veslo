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
    /const storedPendingDraftKey = readActivePendingDraftKey\(\);[\s\S]*const pendingDrafts = \(await deps\.pendingSessionDraftsList\(\)\)\.filter\(\(draft\) => !isConsumedPendingDraftId\(draft\.id\)\);[\s\S]*const matchingPendingDraft = pendingDrafts\.find\(\(draft\) => resolvePendingDraftKey\(\{[\s\S]*\}\) === storedPendingDraftKey\) \?\? null;[\s\S]*const loadedPendingDraft = await deps\.pendingSessionDraftsGet\(matchingPendingDraft\.id\);[\s\S]*const restoreError = formatPendingDraftAttachmentRestoreError\(loadedPendingDraft\.attachmentFailures\);[\s\S]*if \(restoreError\) \{\s*deps\.setError\(restoreError\);[\s\S]*setActivePendingDraftKey\(storedPendingDraftKey\);[\s\S]*setActivePendingDraftMeta\(matchingPendingDraft\);[\s\S]*restorePendingDraftComposer\(storedPendingDraftKey, loadedPendingDraft\.draft\.composer\);/s,
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
  assert.match(routeSource, /if \(connectionKey === lastRouteClientResumeKey\) return;/);
  assert.match(
    routeSource,
    /const alreadyLoaded = !routeBrowseScope && selectedSessionId\(\) === id && visibleMessages\(\)\.length > 0;/,
    "route resume guard should not skip explicit browse-scope reselection just because another transcript is visible",
  );
  assert.match(
    routeSource,
    /lastRouteClientResumeKey = connectionKey;[\s\S]*void selectSession\(id\);/s,
    "route session should be re-selected once after the client reconnects so deep links survive bootstrap/startHost races",
  );
});

test("bare /session keeps the active pending draft context while clearing real session transcript state", () => {
  const routeStart = source.indexOf('    if (path.startsWith("/session")) {');
  const routeEnd = source.indexOf('    if (path.startsWith("/proto-v1-ux")) {', routeStart);
  assert.notStrictEqual(routeStart, -1, "session route block should exist");
  assert.notStrictEqual(routeEnd, -1, "session route block end should exist");
  const routeSource = source.slice(routeStart, routeEnd);

  assert.match(
    routeSource,
    /if \(!id\) \{\s*if \(activePendingDraftKey\(\)\) \{\s*(?:void activePendingDraftMeta\(\);\s*)?if \(selectedSessionId\(\)\) \{\s*setSelectedSessionId\(null\);\s*setMessages\(\[\]\);\s*setTodos\(\[\]\);\s*\}\s*return;\s*\}/s,
    "switching from a real session to bare /session should clear transcript state but keep the pending draft active",
  );
  assert.doesNotMatch(
    routeSource,
    /if \(activePendingDraftKey\(\)\) \{[\s\S]*setActivePendingDraftKey\(null\)/s,
    "bare /session should not auto-clear the active pending draft",
  );
});
