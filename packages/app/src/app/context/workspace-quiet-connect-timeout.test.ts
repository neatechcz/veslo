import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace.ts", import.meta.url), "utf8");

test("workspace activation diagnostics use safe serialization", () => {
  const logStart = source.indexOf("function _wsLog(");
  const logEnd = source.indexOf("const WORKSPACE_ACTIVATE_PAINT_WAIT_TIMEOUT_MS", logStart);
  assert.notEqual(logStart, -1, "_wsLog should exist");
  assert.notEqual(logEnd, -1, "_wsLog source slice should be bounded");
  const logSource = source.slice(logStart, logEnd);

  assert.match(
    logSource,
    /const serializedData = data === undefined \? "" : typeof data === "string" \? data : safeStringify\(data\);[\s\S]*const line = `\[\$\{new Date\(\)\.toISOString\(\)\}\] \$\{msg\}\$\{serializedData \? " " \+ serializedData : ""\}`;/,
    "workspace activation logging should not JSON.stringify live SDK clients",
  );
  assert.match(
    logSource,
    /mod\.logUiEvent\("workspace", msg, serializedData\)/,
    "Tauri diagnostic logging should receive the pre-serialized payload instead of live SDK clients",
  );
  assert.doesNotMatch(
    logSource,
    /JSON\.stringify\(data\)/,
    "workspace activation logging should not throw while serializing recursive diagnostic payloads",
  );
});

test("quiet engine reconnect uses reason-aware health timeout", () => {
  const connectQuietStart = source.indexOf("async function connectToEngineQuiet(");
  assert.notEqual(connectQuietStart, -1, "connectToEngineQuiet should exist");

  const lifecycleStart = source.indexOf("const localRuntimeLifecycle = createLocalRuntimeLifecycle", connectQuietStart);
  const connectQuietSource = source.slice(connectQuietStart, lifecycleStart);

  assert.match(
    connectQuietSource,
    /context\?: \{[\s\S]*workspaceId\?: string;[\s\S]*workspaceType\?: WorkspaceInfo\["workspaceType"\];[\s\S]*targetRoot\?: string;[\s\S]*reason\?: string;[\s\S]*\}/,
    "quiet reconnect should accept the lifecycle workspace identity and reason",
  );
  assert.match(
    connectQuietSource,
    /timeoutMs: resolveConnectHealthTimeoutMs\(context\?\.reason\)/,
    "quiet reconnect should give browse cold starts the long local boot health timeout",
  );
  assert.match(
    connectQuietSource,
    /const workspaceId = context\?\.workspaceId\?\.trim\(\) \|\| activeWorkspaceId\(\)\.trim\(\);[\s\S]*await options\.routing\.ensure\(workspaceId, baseUrl, \{[\s\S]*directory,[\s\S]*auth,[\s\S]*workspaceType: context\?\.workspaceType,[\s\S]*targetRoot: context\?\.targetRoot,[\s\S]*reason: context\?\.reason,[\s\S]*\}\)/s,
    "quiet reconnect should populate the per-workspace routing entry used by later conversation creation",
  );
  assert.match(
    connectQuietSource,
    /if \(\s*context\?\.workspaceType === "local"[\s\S]*currentActiveId !== workspaceId[\s\S]*currentActiveRoot !== directory\.trim\(\)[\s\S]*\) \{\s*return true;\s*\}[\s\S]*options\.setClient\(routingEntry\?\.client \?\? nextClient\);/s,
    "quiet reconnect should not publish a stale global client when the user has already switched away",
  );
});
