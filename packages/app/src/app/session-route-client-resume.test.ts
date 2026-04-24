import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("hydrates active pending draft state from the desktop draft store and prefers real session composer keys", () => {
  assert.match(
    source,
    /const \[activePendingDraftKey, setActivePendingDraftKey\] = createSignal<string \| null>\(null\);/,
    "app state should track the active pending draft key",
  );
  assert.match(
    source,
    /const \[activePendingDraftMeta, setActivePendingDraftMeta\] = createSignal<PendingSessionDraftSummary \| null>\(null\);/,
    "app state should track the active pending draft metadata",
  );
  assert.match(
    source,
    /const currentComposerStorageKey = createMemo\(\(\) => \{\s*const sessionId = selectedSessionId\(\);\s*if \(sessionId\) \{\s*return resolveComposerStorageKey\(\{ sessionId \}\);\s*\}\s*return resolveComposerStorageKey\(\{ pendingDraftKey: activePendingDraftKey\(\) \}\);\s*\}\);/s,
    "real sessions should keep their own composer key even when a pending draft remains active in the background",
  );
  assert.match(
    source,
    /const storedPendingDraftKey = readActivePendingDraftKey\(\);[\s\S]*setActivePendingDraftKey\(storedPendingDraftKey\);[\s\S]*const pendingDrafts = await pendingSessionDraftsList\(\);[\s\S]*const matchingPendingDraft = pendingDrafts\.find\(\(draft\) => resolvePendingDraftKey\(\{[\s\S]*\}\) === storedPendingDraftKey\) \?\? null;[\s\S]*const loadedPendingDraft = await pendingSessionDraftsGet\(matchingPendingDraft\.id\);[\s\S]*setActivePendingDraftMeta\(matchingPendingDraft\);[\s\S]*setComposerDraftBySessionId\(\(current\) => setSessionComposerDraft\(current, \{ storageKey: storedPendingDraftKey \}, loadedPendingDraft\.draft\.composer\)\);/s,
    "startup should hydrate the active pending draft from durable desktop storage",
  );
});

test("session route re-selects once when a client becomes available after bootstrap", () => {
  const routeStart = source.indexOf('let lastRouteClientResumeKey = "";');
  const routeEnd = source.indexOf("  createEffect(() => {\n    const active = workspaceStore.activeWorkspaceDisplay();", routeStart);
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
    /const connectionKey = \[\s*id,\s*client\(\) \? "live" : "offline",\s*clientDirectory\(\) \|\| workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\),\s*connectedVersion\(\) \?\? "",\s*\]\.join\("::"\);/s,
    "route resume key should distinguish live vs offline selection and retry once the workspace root becomes available",
  );
  assert.match(routeSource, /if \(connectionKey === lastRouteClientResumeKey\) return;/);
  assert.match(
    routeSource,
    /const alreadyLoaded = selectedSessionId\(\) === id && visibleMessages\(\)\.length > 0;/,
    "route resume guard should skip re-select when the transcript is already present",
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
