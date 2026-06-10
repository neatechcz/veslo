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
  assert.doesNotMatch(
    source,
    /const storedPendingDraftKey = readActivePendingDraftKey\(\);[\s\S]*setActivePendingDraftKey\(storedPendingDraftKey\);[\s\S]*const pendingDrafts = await pendingSessionDraftsList\(\);/s,
    "startup should not mark a pending draft active before the desktop draft has been validated and loaded",
  );
  assert.match(
    source,
    /const storedPendingDraftKey = readActivePendingDraftKey\(\);[\s\S]*const pendingDrafts = \(await pendingSessionDraftsList\(\)\)\.filter\(\(draft\) => !isConsumedPendingDraftId\(draft\.id\)\);[\s\S]*const matchingPendingDraft = pendingDrafts\.find\(\(draft\) => resolvePendingDraftKey\(\{[\s\S]*\}\) === storedPendingDraftKey\) \?\? null;[\s\S]*const loadedPendingDraft = await pendingSessionDraftsGet\(matchingPendingDraft\.id\);[\s\S]*const restoreError = formatPendingDraftAttachmentRestoreError\(loadedPendingDraft\.attachmentFailures\);[\s\S]*if \(restoreError\) \{\s*setError\(restoreError\);\s*\}[\s\S]*setActivePendingDraftKey\(storedPendingDraftKey\);[\s\S]*setActivePendingDraftMeta\(matchingPendingDraft\);[\s\S]*setComposerDraftBySessionId\(\(current\) => setSessionComposerDraft\(current, \{ storageKey: storedPendingDraftKey \}, loadedPendingDraft\.draft\.composer\)\);/s,
    "startup should hydrate the active pending draft from durable desktop storage",
  );
});

test("pending draft hydration failures clear the active draft key in memory and local storage", () => {
  assert.match(
    source,
    /const clearActivePendingDraftState = \(\) => \{\s*setActivePendingDraftKey\(null\);\s*setActivePendingDraftMeta\(null\);\s*writeActivePendingDraftKey\(null\);\s*\};/s,
    "app should define one explicit cleanup path for stale pending draft state",
  );
  assert.match(
    source,
    /const CONSUMED_PENDING_DRAFT_IDS_KEY = "veslo\.consumed-pending-draft-ids\.v1";[\s\S]*const isConsumedPendingDraftId = \(value: string \| null \| undefined\) => \{[\s\S]*return readConsumedPendingDraftIds\(\)\.has\(trimmed\);[\s\S]*\};/s,
    "app should keep an explicit consumed-draft id set so cleanup failures cannot resurrect a draft on restart",
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
    /const connectionKey = \[\s*id,\s*routedClient\(\) \? "live" : "offline",\s*clientDirectory\(\) \|\| workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\),\s*connectedVersion\(\) \?\? "",\s*\]\.join\("::"\);/s,
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

test("desktop hash session routes drive the route selection effects", () => {
  assert.match(
    source,
    /const currentRoutePath = createMemo\(\(\) => \{[\s\S]*void externalHashRoutePath\(\);[\s\S]*const routerPath = normalizeRoutePath\(location\.pathname\);[\s\S]*const hashPath = readHashRoutePath\(\);[\s\S]*if \(isTauriRuntime\(\) && hashPath && routerPath === "\/"\) \{[\s\S]*return hashPath;[\s\S]*\}[\s\S]*return routerPath;[\s\S]*\}\);/s,
    "desktop routing should use the hash path when the physical browser pathname is still /",
  );

  const routeResumeStart = source.indexOf('let lastRouteClientResumeKey = "";');
  const routeResumeEnd = source.indexOf("  createEffect(() => {\n    const active = workspaceStore.activeWorkspaceDisplay();", routeResumeStart);
  assert.notStrictEqual(routeResumeStart, -1, "route resume block should exist");
  assert.notStrictEqual(routeResumeEnd, -1, "route resume block end should exist");
  const routeResumeSource = source.slice(routeResumeStart, routeResumeEnd);
  assert.match(
    routeResumeSource,
    /const rawPath = currentRoutePath\(\)\.trim\(\);[\s\S]*if \(!path\.startsWith\("\/session\/"\)\) return;[\s\S]*void selectSession\(id\);/s,
    "session deep-link resume should select real sessions from the effective desktop route",
  );

  const routeGuardStart = source.indexOf("  createEffect(() => {\n    const rawPath = currentRoutePath().trim();", routeResumeEnd);
  const routeGuardEnd = source.indexOf('    if (path.startsWith("/proto-v1-ux")) {', routeGuardStart);
  assert.notStrictEqual(routeGuardStart, -1, "main route guard should use currentRoutePath");
  assert.notStrictEqual(routeGuardEnd, -1, "main route guard block end should exist");
  const routeGuardSource = source.slice(routeGuardStart, routeGuardEnd);
  assert.match(
    routeGuardSource,
    /if \(path\.startsWith\("\/session"\)\) \{[\s\S]*const \[, , sessionSegment\] = rawPath\.split\("\/"\);/s,
    "session route correction should also read the effective desktop route",
  );
});

test("desktop session navigation writes the hash route directly", () => {
  assert.match(
    source,
    /const navigateDesktopHashRoute = \(path: string, options\?: \{ replace\?: boolean \}\) => \{[\s\S]*if \(!isTauriRuntime\(\) \|\| typeof window === "undefined"\) return false;[\s\S]*setExternalHashRoutePath\(normalized\);[\s\S]*return true;[\s\S]*\};/s,
    "app should expose a direct hash-route writer for Tauri session navigation",
  );
  assert.match(
    source,
    /if \(navigateDesktopHashRoute\(`\/session\/\$\{trimmed\}`, options\)\) return;\s*navigate\(`\/session\/\$\{trimmed\}`, options\);/s,
    "goToSession should update the Tauri hash before falling back to router navigation",
  );
});

test("desktop bare session navigation writes the hash route directly", () => {
  assert.match(
    source,
    /clearStalePendingSessionLoadForRouteSession\(null\);\s*if \(selectedSessionId\(\)\) \{\s*setSelectedSessionId\(null\);\s*\}\s*goToSession\(""\);\s*return;/s,
    "bare session navigation should use the same Tauri hash writer as concrete session navigation",
  );
});

test("invalid desktop session routes fall back through the hash-safe session navigator", () => {
  const routeResumeStart = source.indexOf('let lastRouteClientResumeKey = "";');
  const routeGuardStart = source.indexOf("  createEffect(() => {\n    const rawPath = currentRoutePath().trim();", routeResumeStart);
  const routeGuardEnd = source.indexOf('    if (path.startsWith("/proto-v1-ux")) {', routeGuardStart);
  assert.notStrictEqual(routeResumeStart, -1, "route resume block should exist");
  assert.notStrictEqual(routeGuardStart, -1, "main route guard should exist");
  assert.notStrictEqual(routeGuardEnd, -1, "main route guard block end should exist");
  const routeGuardSource = source.slice(routeGuardStart, routeGuardEnd);

  assert.match(
    routeGuardSource,
    /shouldFallbackFromSessionRoute\([\s\S]*?\)\s*\) \{[\s\S]*goToSession\("", \{ replace: true \}\);[\s\S]*return;/s,
    "stale pending-session hash routes should be cleared through goToSession so the Tauri hash cannot remain stale",
  );
  assert.doesNotMatch(
    routeGuardSource,
    /shouldFallbackFromSessionRoute\([\s\S]*?\)\s*\) \{[\s\S]*navigate\("\/session", \{ replace: true \}\);/s,
    "route fallback should not use router navigation directly in the Tauri hash path",
  );
});

test("bare /session keeps the active pending draft context while clearing real session transcript state", () => {
  const routeStart = source.indexOf('    if (path.startsWith("/session")) {');
  const routeEnd = source.indexOf('    if (path.startsWith("/proto-v1-ux")) {', routeStart);
  assert.notStrictEqual(routeStart, -1, "session route block should exist");
  assert.notStrictEqual(routeEnd, -1, "session route block end should exist");
  const routeSource = source.slice(routeStart, routeEnd);
  const bareSessionEnd = routeSource.indexOf("      const sessionIdsInStore = sessions().map((session) => session.id);");
  assert.notStrictEqual(bareSessionEnd, -1, "bare /session branch should end before fallback checks");
  const bareSessionSource = routeSource.slice(0, bareSessionEnd);

  assert.match(
    bareSessionSource,
    /if \(!id\) \{\s*if \(activePendingDraftKey\(\)\) \{\s*(?:void activePendingDraftMeta\(\);\s*)?if \(selectedSessionId\(\)\) \{\s*setSelectedSessionId\(null\);\s*\}\s*return;\s*\}/s,
    "switching from a real session to bare /session should clear selected state but keep cached transcripts and the pending draft active",
  );
  assert.doesNotMatch(
    bareSessionSource,
    /setMessages\(\[\]\);\s*setTodos\(\[\]\);/s,
    "bare /session routing must not delete the cached transcript for the previously selected real session",
  );
  assert.doesNotMatch(
    routeSource,
    /if \(activePendingDraftKey\(\)\) \{[\s\S]*setActivePendingDraftKey\(null\)/s,
    "bare /session should not auto-clear the active pending draft",
  );
});
