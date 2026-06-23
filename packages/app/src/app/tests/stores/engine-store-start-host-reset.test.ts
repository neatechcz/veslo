import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../stores/engine-store.ts", import.meta.url), "utf8");

test("startHost clears the stale live client before launching a different local host", () => {
  assert.match(
    source,
    /async function startHost\(optionsOverride\?: \{ workspacePath\?: string; navigate\?: boolean \}\) \{[\s\S]*deps\.setClient\(null\);[\s\S]*deps\.setConnectedVersion\(null\);[\s\S]*deps\.setSelectedSessionId\(null\);[\s\S]*deps\.setMessages\(\[\]\);[\s\S]*deps\.setTodos\(\[\]\);[\s\S]*deps\.setPendingPermissions\(\[\]\);[\s\S]*deps\.setSessionStatusById\(\{\}\);[\s\S]*deps\.setSseConnected\(false\);[\s\S]*const ok = await localRuntimeLifecycle\.startHost\(/s,
    "startHost must drop the previous workspace client before delegating engine start to the shared helper so session opens cannot race against a stale engine connection",
  );
});

test("refreshEngine still skips state sync when browsing a different local workspace", () => {
  assert.match(
    source,
    /const engineSnapshotMatchesActiveWorkspace =[\s\S]*!activeWorkspaceRoot[\s\S]*!engineProjectDir[\s\S]*activeWorkspaceRoot === engineProjectDir;/s,
    "refreshEngine should only sync mutable runtime state when the engine snapshot belongs to the active local workspace",
  );
  assert.match(
    source,
    /if \(info\.projectDir && syncLocalState && engineSnapshotMatchesActiveWorkspace\) \{[\s\S]*deps\.setProjectDir\(info\.projectDir\);[\s\S]*\}/s,
    "refreshEngine must not overwrite projectDir with a different workspace's engine snapshot",
  );
});

test("refreshEngine does not auto-reconnect under lazy boot policy", () => {
  // Lazy boot: the user-driven activateWorkspace owns connect. refreshEngine
  // is purely informational and must not trigger connectToServer itself.
  assert.doesNotMatch(
    source,
    /async function refreshEngine\(\)[\s\S]*?deps\.connectToServer\(/s,
    "refreshEngine must not call connectToServer; activate flow owns reconnect",
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

test("startHost preflights Windows WSL sandbox readiness before engine launch", () => {
  assert.match(source, /desktopSandboxEnvironment\(\)/);
  assert.match(
    source,
    /async function ensureLocalRuntimeReadyForWorkspaceStart\(workspacePath: string\) \{[\s\S]*const windowsSandboxEnvironment = await resolveWindowsSandboxEnvironmentForLocalStart\(\);[\s\S]*if \(deps\.isWindowsPlatform\(\) && !windowsSandboxEnvironment\) \{[\s\S]*return false;[\s\S]*\}[\s\S]*const useWindowsWslSandbox = windowsSandboxEnvironment\?\.backend === "windows-wsl2";/s,
  );
  assert.match(source, /const useWindowsWslSandbox = windowsSandboxEnvironment\?\.backend === "windows-wsl2";/);
  assert.match(source, /async function ensureWindowsSandboxReadyForLocalStart\(\)/);
  assert.match(source, /ensureLocalRuntimeReadyForWorkspaceStart,/);
  assert.match(source, /wslPrerequisitesRepair\(\{ checkOnly: true \}\)/);
  assert.match(source, /wslSandboxRepair\(\{ checkOnly: true \}\)/);
  assert.match(
    source,
    /if \(!\(await ensureLocalRuntimeReadyForWorkspaceStart\(dir\)\)\) \{[\s\S]*return false;[\s\S]*\}[\s\S]*const source = deps\.engineSource\(\);/s,
  );
});
