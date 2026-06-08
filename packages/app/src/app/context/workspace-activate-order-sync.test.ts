import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace.ts", import.meta.url), "utf8");

test("local activation path applies workspace_set_active response back into the workspace list", () => {
  assert.match(
    source,
    /_wsLog\("\[workspace:activate\] STEP 3 — workspaceSetActive\.\.\.", \{ id \}\);[\s\S]*const ws = await withTimeoutOrThrow\([\s\S]*workspaceSetActive\(id, \{ promoteToFront: activationOptions\?\.promoteToFront \?\? false \}\),[\s\S]*\);[\s\S]*setWorkspaces\(ws\.workspaces\);/s,
  );
});

test("workspace activation paint wait cannot block the switch forever", () => {
  assert.match(
    source,
    /await waitForWorkspaceActivationPaint\(\);/,
    "activateWorkspace should wait for paint through a bounded helper",
  );
  assert.doesNotMatch(
    source,
    /await new Promise<void>\(\(resolve\) => window\.requestAnimationFrame\(\(\) => resolve\(\)\)\);/,
    "a bare requestAnimationFrame await can hang in hidden or pilot-driven Tauri webviews",
  );
});

test("ensuring an existing folder promotes that workspace to the top immediately", () => {
  assert.match(
    source,
    /const existing = findLocalWorkspaceByPath\(resolvedFolder\);[\s\S]*if \(existing\) \{[\s\S]*setWorkspaces\(\(prev\) => \{[\s\S]*return \[existing, \.\.\.rest\];[\s\S]*\}\);[\s\S]*return existing;[\s\S]*\}/s,
  );
});

test("connect flow keeps pending permissions loaded by refreshPendingPermissions", () => {
  assert.match(
    source,
    /await withTimeoutOrThrow\(\s*options\.refreshPendingPermissions\(\),[\s\S]*options\.setSelectedSessionId\(null\);[\s\S]*options\.setMessages\(\[\]\);[\s\S]*options\.setTodos\(\[\]\);[\s\S]*options\.setSessionStatusById\(\{\}\);/s,
  );

  assert.doesNotMatch(
    source,
    /await withTimeoutOrThrow\(\s*options\.refreshPendingPermissions\(\),[\s\S]{0,900}options\.setPendingPermissions\(\[\]\);/s,
  );
});

test("connect flow clears stale session selection before publishing the client", () => {
  const connectStart = source.indexOf("async function connectToServer(");
  const connectEnd = source.indexOf("const openEmptySession = async", connectStart);
  assert.notStrictEqual(connectStart, -1, "connectToServer definition missing");
  assert.notStrictEqual(connectEnd, -1, "connectToServer end marker missing");
  const connectSource = source.slice(connectStart, connectEnd);

  const clearSelectionIdx = connectSource.indexOf("options.setSelectedSessionId(null);");
  const publishClientIdx = connectSource.indexOf("options.setClient(nextClient);");

  assert.notStrictEqual(clearSelectionIdx, -1, "connect flow should clear selected session");
  assert.notStrictEqual(publishClientIdx, -1, "connect flow should publish the client");
  assert.ok(
    clearSelectionIdx < publishClientIdx,
    "connectToServer must reset the previous session before route effects can observe the new client and immediately re-open a session that then gets cleared again",
  );
});

test("post-health connect failures keep the healthy client attached", () => {
  assert.match(
    source,
    /let publishedClient = false;[\s\S]*options\.setClient\(nextClient\);[\s\S]*publishedClient = true;/s,
    "connect flow should mark when the healthy client has already been published",
  );

  assert.match(
    source,
    /if \(publishedClient\) \{[\s\S]*status: "connected",[\s\S]*return true;[\s\S]*\}[\s\S]*options\.setClient\(null\);[\s\S]*options\.setConnectedVersion\(null\);/s,
    "post-health failures must degrade the connect step instead of dropping the live client back to null",
  );
});

test("browsing mode keeps the live client but marks the engine not ready before SQLite-backed browsing", () => {
  assert.match(
    source,
    /if \(!isRemote && wasLocalConnection && workspaceChanged && isTauriRuntime\(\) && options\.populateSidebarFromDb\) \{[\s\S]*options\.setEngineReady\?\.\(false\);[\s\S]*\}/s,
    "browse mode must mark the engine not ready before async SQLite hydration",
  );

  assert.match(
    source,
    /Don't clear session state or client connection here\.[\s\S]*engineReady\(false\) below prevents API calls/,
    "browse mode should keep the live client attached while preventing wrong-workspace API calls",
  );
});

test("bootstrap does not auto-connect or start the engine under lazy boot policy", () => {
  // Lazy boot: bootstrap pre-loads the sidebar from SQLite and lets the user
  // open the workspace explicitly. The bootstrap-specific connect/start
  // helpers must not be invoked anywhere in this file.
  assert.doesNotMatch(
    source,
    /connectOrRecoverLocalBootstrap/,
    "bootstrap must not invoke connectOrRecoverLocalBootstrap; activate flow owns connect",
  );
  assert.doesNotMatch(
    source,
    /reason: "bootstrap-local"/,
    "no connectToServer call may run with reason 'bootstrap-local' — bootstrap must not connect",
  );
});

test("bootstrap pre-loads the sidebar from SQLite without starting the engine", () => {
  assert.match(
    source,
    /async function bootstrapOnboarding\(\)[\s\S]*?options\.populateSidebarFromDb\(/s,
    "bootstrap must populate the sidebar from SQLite for instant browsability",
  );
  assert.match(
    source,
    /async function bootstrapOnboarding\(\)[\s\S]*?options\.setEngineReady\?\.\(false\)/s,
    "bootstrap must explicitly mark engine as not-ready so browsing-mode UI activates",
  );
});

test("orchestrator activation timeout covers cold engine spawn", () => {
  const raw = source.match(/const ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS = ([\d_]+);/)?.[1];
  assert.ok(raw, "ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS constant missing");
  const timeoutMs = Number(raw.replaceAll("_", ""));

  assert.ok(
    timeoutMs >= 75_000,
    "orchestrator activation timeout must stay above the daemon's 60s cold OpenCode health window",
  );
  assert.match(source, /default health window is 60s on cold dev starts/);
});

test("workspace activation delegates local runtime reuse and restart flows to the shared lifecycle helper", () => {
  assert.match(
    source,
    /const localRuntimeLifecycle = createLocalRuntimeLifecycle\(/,
    "workspace store should instantiate the shared local runtime lifecycle helper",
  );

  assert.match(
    source,
    /connectedToLocalHost = await localRuntimeLifecycle\.reattachOrchestratorWorkspace\(\{/,
    "remote-to-local reuse should delegate to the shared helper",
  );

  assert.match(
    source,
    /const ok = await localRuntimeLifecycle\.restartWorkspaceRuntime\(\{/,
    "local-to-local engine switching should delegate to the shared helper",
  );

  assert.match(
    source,
    /const ok = await localRuntimeLifecycle\.restartWorkspaceRuntime\(\{[\s\S]*connectMode: "quiet"/s,
    "browsing-mode engine attach should use the shared helper's quiet reconnect path",
  );
});

test("browsing-mode cold engine attach preserves the current session view", () => {
  const ensureStart = source.indexOf("async function ensureEngineForWorkspace(");
  assert.notStrictEqual(ensureStart, -1, "ensureEngineForWorkspace is missing");
  const ensureSource = source.slice(ensureStart);

  const coldStartIdx = ensureSource.indexOf("ok = await localRuntimeLifecycle.startHost({");
  assert.notStrictEqual(coldStartIdx, -1, "browsing-mode cold-start fallback should be present");
  const coldStartEnd = ensureSource.indexOf("});", coldStartIdx);
  assert.notStrictEqual(coldStartEnd, -1, "browsing-mode cold-start fallback call should close");
  const coldStartSource = ensureSource.slice(coldStartIdx, coldStartEnd);

  assert.match(
    coldStartSource,
    /connectMode: "quiet"/,
    "browsing-mode cold-start fallback must reconnect quietly so sending from a browsed private chat does not clear selectedSessionId",
  );
});
