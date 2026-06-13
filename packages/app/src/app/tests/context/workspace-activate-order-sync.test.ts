import assert from "node:assert/strict";
import test from "node:test";

import {
  readContextSource,
  readWorkspaceBehaviorSources,
  readWorkspaceFacadeSource,
} from "./workspace-source";

const source = readWorkspaceBehaviorSources();
const connectionControllerSource = readContextSource("workspace-connection-controller.ts");

test("local activation path applies workspace_set_active response back into the workspace list", () => {
  assert.match(
    source,
    /_wsLog\("\[workspace:activate\] STEP 3 — workspaceSetActive\.\.\.", \{ id \}\);[\s\S]*const ws = await withTimeoutOrThrow\([\s\S]*workspaceSetActive\(id, \{ promoteToFront: activationOptions\?\.promoteToFront \?\? false \}\),[\s\S]*\);[\s\S]*setWorkspaces\(ws\.workspaces\);/s,
  );
});

test("workspace activation options live in the shared workspace-types module", () => {
  const typesSource = readContextSource("workspace-types.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(
    typesSource,
    /export type WorkspaceActivationOptions = \{/,
    "WorkspaceActivationOptions should live in workspace-types.ts",
  );

  assert.doesNotMatch(
    facadeSource,
    /export type WorkspaceActivationOptions = \{/,
    "workspace.ts should re-export shared activation types instead of owning them",
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
    connectionControllerSource,
    /await deps\.loadSessions\(context\?\.targetRoot\);[\s\S]*await deps\.refreshPendingPermissions\(\);/s,
    "connect flow should refresh sessions and then pending permissions after routing ensure",
  );

  assert.doesNotMatch(
    connectionControllerSource,
    /clearPendingPermissions: true/s,
    "connect flow should not clear pending permissions that are refreshed later in the connect path",
  );
});

test("connect flow publishes the routed workspace client only after routing ensure", () => {
  assert.match(
    connectionControllerSource,
    /const entry = await deps\.routing\.ensure\(/,
    "connect flow should ensure the workspace route before publishing a client",
  );
  assert.match(
    connectionControllerSource,
    /deps\.setClient\(entry\.client\);/,
    "connect flow should publish the routed client entry",
  );
  assert.doesNotMatch(
    connectionControllerSource,
    /createClient\(nextBaseUrl/,
    "connect flow should not recreate the old single-active client directly",
  );
});

test("workspace scope comparisons use scope-aware normalized directory paths", () => {
  assert.match(
    source,
    /const normalizeWorkspaceScopePath = \([\s\S]*workspaceType\?: WorkspaceInfo\["workspaceType"\] \| null,[\s\S]*const normalized = normalizeDirectoryQueryPath\(value \?\? ""\);[\s\S]*workspaceType === "local" && options\.isWindowsPlatform\(\)[\s\S]*normalized\.toLowerCase\(\)[\s\S]*: normalized;/s,
    "workspace store should only apply case-insensitive path comparison to local Windows paths",
  );
  assert.match(
    source,
    /const workspaceChanged =[\s\S]*workspaceScopeChanged\(oldWorkspacePath, nextRoot, "local"\)/s,
    "activateWorkspace should compare local workspace paths using local filesystem semantics",
  );
  assert.match(
    connectionControllerSource,
    /const connectWorkspaceType = context\?\.workspaceType \?\? deps\.activeWorkspaceType\(\);[\s\S]*const incomingDirectoryScope = deps\.normalizeWorkspaceScopePath\([\s\S]*incomingDirectory,[\s\S]*connectWorkspaceType,/s,
    "connect flow should resolve the path comparison scope from workspace type",
  );
  assert.match(
    connectionControllerSource,
    /deps\.normalizeWorkspaceScopePath\(deps\.clientDirectory\(\), connectWorkspaceType\) === incomingDirectoryScope/s,
    "connect idempotency should compare normalized client directories with workspace scope semantics",
  );
  assert.match(
    connectionControllerSource,
    /const connectRequestKey =[\s\S]*normalizeWorkspaceScopePath\(directory \?\? "", context\?\.workspaceType\)[\s\S]*normalizeWorkspaceScopePath\(context\?\.targetRoot \?\? "", context\?\.workspaceType\)/s,
    "connect dedupe key should normalize directory and target root paths with explicit workspace type semantics",
  );
  assert.match(
    connectionControllerSource,
    /currentActiveRootScope[\s\S]*incomingDirectoryScope[\s\S]*currentActiveRootScope !== incomingDirectoryScope/s,
    "connect stale-after-ensure gating should compare normalized directories with workspace scope semantics",
  );
});

test("routing ensure failures preserve concrete UI error messages", () => {
  assert.match(
    connectionControllerSource,
    /const detail = deps\.routing\.lastEnsureError\(workspaceId\);[\s\S]*`Failed to ensure workspace client: \$\{detail\}`/s,
    "connect flow should include routing ensure details in the UI error message",
  );

  assert.match(
    connectionControllerSource,
    /deps\.setOpencodeConnectStatus\?\.\(\{[\s\S]*status: "error",[\s\S]*error: message,/s,
    "connect flow should forward the concrete error message into connect status diagnostics",
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

test("bootstrap clears stale onboarding gates restored before persisted metadata", () => {
  assert.match(
    source,
    /if \(options\.onboardingStep\(\) === "language"\) \{[\s\S]*persisted language found - clearing stale language gate[\s\S]*options\.setOnboardingStep\(resolveWelcomeOnboardingStep\(\)\);[\s\S]*\}/s,
    "bootstrap should leave the language gate when a persisted language is available",
  );

  assert.match(
    source,
    /if \(options\.onboardingStep\(\) === "auth"\) \{[\s\S]*cached DEN auth found - clearing stale auth gate[\s\S]*options\.setOnboardingStep\(resolveWelcomeOnboardingStep\(\)\);[\s\S]*\}/s,
    "bootstrap should leave the auth gate when cached auth is available",
  );
});

test("quiet port-rotation only binds the workspace proxy client without reading the engine", () => {
  assert.match(
    connectionControllerSource,
    /const quietPortRefresh = quiet && context\?\.reason === "port-rotation";[\s\S]*skipHealth: quietPortRefresh,/s,
    "quiet port-rotation should bind the routed client without eager workspace proxy health polling",
  );
  assert.match(
    connectionControllerSource,
    /if \(quietPortRefresh\) \{[\s\S]*deps\.wsDebug\("connect:proxy-bound"[\s\S]*return true;[\s\S]*\}[\s\S]*await deps\.loadSessions\(context\?\.targetRoot\);[\s\S]*await deps\.refreshPendingPermissions\(\);[\s\S]*deps\.onEngineStable\?\.\(\);/s,
    "quiet port-rotation must not load sessions, poll permissions, or mark the engine stable before it has actually started",
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

test("orchestrator browse attach preserves busy state for other live workspaces", () => {
  const ensureSource = readContextSource("workspace-runtime-controller.ts");

  assert.match(
    ensureSource,
    /if \(deps\.resolveEngineRuntime\(\) !== "veslo-orchestrator"\) \{\s*deps\.clearWorkspaceBusyAllExcept\(workspace\.id\);\s*\}/,
    "orchestrator workspace switching must not clear busy state for other pooled workspaces",
  );
});
