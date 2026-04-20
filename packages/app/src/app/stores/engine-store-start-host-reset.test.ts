import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./engine-store.ts", import.meta.url), "utf8");

test("startHost clears the stale live client before launching a different local host", () => {
  assert.match(
    source,
    /async function startHost\(optionsOverride\?: \{ workspacePath\?: string; navigate\?: boolean \}\) \{[\s\S]*deps\.setClient\(null\);[\s\S]*deps\.setConnectedVersion\(null\);[\s\S]*deps\.setSelectedSessionId\(null\);[\s\S]*deps\.setMessages\(\[\]\);[\s\S]*deps\.setTodos\(\[\]\);[\s\S]*deps\.setPendingPermissions\(\[\]\);[\s\S]*deps\.setSessionStatusById\(\{\}\);[\s\S]*deps\.setSseConnected\(false\);[\s\S]*const ok = await localRuntimeLifecycle\.startHost\(/s,
    "startHost must drop the previous workspace client before delegating engine start to the shared helper so session opens cannot race against a stale engine connection",
  );
});

test("refreshEngine does not resurrect a live client while browsing a different local workspace", () => {
  assert.match(
    source,
    /const browsingDifferentLocalWorkspace =[\s\S]*activeWorkspaceRoot !== engineProjectDir;/s,
    "refreshEngine should detect when the active local workspace is only being browsed while the engine still points at another root",
  );

  assert.match(
    source,
    /const workspaceOwnsLocalReconnect = syncLocalState && activeWorkspacePath\.length > 0;/,
    "refreshEngine should let the active local workspace bootstrap own the connect flow instead of racing it from the engine poller",
  );

  assert.match(
    source,
    /if \(\s*syncLocalState &&\s*info\.running &&\s*info\.baseUrl &&\s*!deps\.client\(\) &&\s*!reconnectingEngine &&\s*!workspaceOwnsLocalReconnect &&\s*!browsingDifferentLocalWorkspace\s*\)/s,
    "engine refresh must not auto-reconnect while a local workspace bootstrap or browse-mode flow intentionally owns connectivity",
  );
});

test("engine store delegates host start and reload reconnect flow to the shared local runtime lifecycle helper", () => {
  assert.match(
    source,
    /const localRuntimeLifecycle = createLocalRuntimeLifecycle\(/,
    "engine-store should instantiate the shared local runtime lifecycle helper",
  );

  assert.match(
    source,
    /const ok = await localRuntimeLifecycle\.startHost\(\{/,
    "startHost should delegate engine start and reconnect orchestration to the shared helper",
  );

  assert.match(
    source,
    /const ok = await localRuntimeLifecycle\.restartWorkspaceRuntime\(\{/,
    "reloadWorkspaceEngine should delegate restart and reconnect orchestration to the shared helper",
  );
});
