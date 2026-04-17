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

test("browsing mode clears the stale live client before SQLite-backed session browsing", () => {
  assert.match(
    source,
    /if \(!isRemote && wasLocalConnection && workspaceChanged && isTauriRuntime\(\) && options\.populateSidebarFromDb\) \{[\s\S]*options\.setSelectedSessionId\(null\);[\s\S]*options\.setMessages\(\[\]\);[\s\S]*options\.setTodos\(\[\]\);[\s\S]*options\.setSessionStatusById\(\{\}\);[\s\S]*options\.setClient\(null\);[\s\S]*options\.setClientDirectory\(""\);/s,
    "browse mode must drop the previous workspace client so session opens use SQLite fallback instead of the wrong engine",
  );
});

test("bootstrap reuses a running local engine only when its projectDir matches the active workspace", () => {
  assert.match(source, /const runningEngineProjectDir = info\?\.projectDir\?\.trim\(\) \?\? "";/);
  assert.match(
    source,
    /const canReuseRunningEngine =[\s\S]*normalizeDirectoryPath\(runningEngineProjectDir\)[\s\S]*normalizeDirectoryPath\(workspacePath\);/s,
  );
  assert.match(
    source,
    /if \(info\?\.running && info\.baseUrl && canReuseRunningEngine\) \{/,
    "bootstrap must not silently attach Prometheus to a stale engine from another workspace",
  );
});

test("bootstrap local connect/start preserves the current session route instead of navigating back to the empty session view", () => {
  assert.match(
    source,
    /const connected = await connectToServer\([\s\S]*engineStore\.engineAuth\(\) \?\? undefined,[\s\S]*\{ navigate: false \},[\s\S]*\);/s,
    "bootstrap reattach must not clobber a deep-linked session route while reconnecting to the local host",
  );
  assert.match(
    source,
    /engineStore\.startHost\(\{ workspacePath, navigate: false \}\)/,
    "bootstrap startHost must preserve the current route so session opening can complete after the host becomes ready",
  );
});
