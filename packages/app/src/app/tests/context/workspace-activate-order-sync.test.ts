import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  readContextSource,
  readWorkspaceBehaviorSources,
  readWorkspaceFacadeSource,
} from "./workspace-source";

const source = readWorkspaceBehaviorSources();
const connectionControllerSource = readContextSource("workspace-connection-controller.ts");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("local activation path applies workspace_set_active response back into the workspace list", () => {
  assert.match(
    source,
    /deps\.wsLog\("\[workspace:activate\] STEP 3 — workspaceSetActive\.\.\.", \{ id \}\);[\s\S]*const ws = await deps\.withTimeoutOrThrow\([\s\S]*workspaceSetActive\(id, \{ promoteToFront: deps\.activationOptions\?\.promoteToFront \?\? false \}\),[\s\S]*\);[\s\S]*deps\.setWorkspaces\(ws\.workspaces\);/s,
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

test("boot trace sink is explicit opt-in instead of hardcoded localhost telemetry", () => {
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(
    facadeSource,
    /const BOOT_TRACE_SINK_STORAGE_KEY = "veslo:boot-trace-sink";/,
    "workspace boot trace should expose an explicit local debug sink key",
  );
  assert.match(
    facadeSource,
    /const sinkUrl = bootTraceSinkUrl\(\);[\s\S]*if \(!sinkUrl\) return;[\s\S]*fetch\(sinkUrl,/,
    "bootTrace should only fetch when the local sink was explicitly configured",
  );
  assert.doesNotMatch(
    facadeSource,
    /fetch\("http:\/\/127\.0\.0\.1:9876"/,
    "bootTrace must not spam WebView console with a hardcoded unavailable localhost sink",
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

test("displayed-session reset logs active send trace context", () => {
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(
    facadeSource,
    /activeSendTraceId\?: \(\) => string \| null;/,
    "workspace store should accept the active send trace accessor for reset diagnostics",
  );
  assert.match(
    facadeSource,
    /const activeSendTraceId = options\.activeSendTraceId\?\.\(\)\?\.trim\(\) \?\? "";[\s\S]*wsDebug\("ui-reset:displayed-session", \{[\s\S]*activeSendTraceId: activeSendTraceId \|\| null,/s,
    "displayed-session reset logs must say whether a send was active during the reset",
  );
  assert.match(
    appSource,
    /developerMode,[\s\S]*activeSendTraceId,[\s\S]*setEngineReady,/s,
    "App should wire the active send trace into workspace reset diagnostics",
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
    /createEffect\(\(\) => \{[\s\S]*const activeRoot = activeWorkspaceRoot\(\)\.trim\(\);[\s\S]*const runtimeProjectDir = projectDir\(\)\.trim\(\);[\s\S]*wsDebug\("workspace:projectDir-activeRoot-mismatch"/s,
    "workspace store should log when mutable runtime projectDir drifts from the active workspace root",
  );
  assert.match(
    source,
    /const startedFromLocalMode = deps\.startupPreference\(\) === "local";[\s\S]*const wasLocalConnection = startedFromLocalMode && Boolean\(deps\.routingActive\(\)\);[\s\S]*const previousProjectDir = deps\.projectDir\(\);[\s\S]*const previousActiveWorkspaceRoot = deps\.activeWorkspaceRoot\(\)\.trim\(\);[\s\S]*const oldWorkspacePath = previousActiveWorkspaceRoot \|\| previousProjectDir;/s,
    "activateWorkspace should use the scoped active workspace root before falling back to the mutable runtime projectDir",
  );
  assert.match(
    source,
    /const projectDirOutOfSync =[\s\S]*previousProjectDirScope !== oldWorkspaceScope;[\s\S]*deps\.wsDebug\("activate:local:projectDir-out-of-sync"/s,
    "activation should log when mutable projectDir drifts away from the active workspace root",
  );
  assert.match(
    source,
    /const workspaceChanged =[\s\S]*workspaceScopeChanged\(oldWorkspacePath, nextRoot, "local"\)/s,
    "activateWorkspace should compare local workspace paths using active-root-aware local filesystem semantics",
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
  const localActivationSource = readContextSource("workspace-activation-local.ts");

  assert.match(
    localActivationSource,
    /if \(startedFromLocalMode && workspaceChanged && isTauriRuntime\(\) && deps\.populateSidebarFromDb\) \{[\s\S]*deps\.setEngineReady\?\.\(false\);[\s\S]*\}/s,
    "browse mode must mark the engine not ready before async SQLite hydration",
  );
  assert.match(
    localActivationSource,
    /const displayedSessionCleared = workspaceChanged;[\s\S]*deps\.clearDisplayedSessionState\("connect_workspace_scope_changed", \{[\s\S]*workspaceId: id,[\s\S]*previousDirectory: oldWorkspacePath,[\s\S]*nextDirectory: nextRoot,[\s\S]*clearPendingPermissions: true,[\s\S]*\}\);[\s\S]*batch\(\(\) => \{[\s\S]*deps\.syncActiveWorkspaceId\(id\);[\s\S]*deps\.setProjectDir\(nextRoot\);[\s\S]*\}\);/s,
    "workspace switch should clear the stale visible session before atomically publishing active workspace identity and projectDir",
  );
  assert.match(
    localActivationSource,
    /if \(!deps\.routingActive\(\) \|\| selection\.wasLocalConnection \|\| selection\.startedFromLocalMode\) return true;/s,
    "local browse mode without an active client must not be treated as a remote-to-local reconnect",
  );
  assert.match(
    localActivationSource,
    /!\(selection\.startedFromLocalMode \|\| selection\.wasLocalConnection \|\| isColdBoot \|\| needsEngineWarmup\)/s,
    "local browse mode should allow SQLite-backed browsing even when no routed client was active at activation start",
  );
  assert.match(
    localActivationSource,
    /if \(selection\.workspaceChanged && !selection\.displayedSessionCleared\) \{[\s\S]*deps\.clearDisplayedSessionState\("local_browse_workspace_changed"/s,
    "browse mode should keep its fallback clear path for callers that did not clear before identity switch",
  );

  assert.doesNotMatch(
    localActivationSource,
    /setClient|setBaseUrl|setClientDirectory/,
    "browse mode should keep the live client attached while preventing wrong-workspace API calls",
  );
});

test("project-open workspace switches clear stale session routes before activation", () => {
  assert.match(
    appSource,
    /const shouldClearSessionRouteForProjectOpen = \(workspaceId: string, origin\?: string \| null\) => \{[\s\S]*origin !== "workspace-session-list:project-open"[\s\S]*location\.pathname\.toLowerCase\(\)\.startsWith\("\/session\/"\)[\s\S]*nextWorkspaceId !== workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*\};/s,
    "explicit project-open switches should only reset concrete session routes when moving to another workspace",
  );

  assert.match(
    appSource,
    /if \(shouldClearSessionRouteForProjectOpen\(workspaceId, options\?\.origin\)\) \{[\s\S]*wsDebug\("route:workspace-project-open:clear-session-route"[\s\S]*navigate\("\/session", \{ replace: true \}\);[\s\S]*\}[\s\S]*return workspaceStore\.activateWorkspace\(workspaceId, options\);/s,
    "route reset must happen before workspace activation so route effects cannot reselect the old session",
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

test("workspace id is empty until workspace bootstrap hydrates the real active workspace", () => {
  assert.match(
    source,
    /const \[activeWorkspaceId, setActiveWorkspaceId\] = createSignal<string>\(""\);/,
    "activeWorkspaceId should not use the starter preset as a fake workspace id before hydration",
  );
  assert.doesNotMatch(
    source,
    /createSignal<string>\("starter"\)/,
    "the starter preset must not leak into workspace identity state",
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
    /async function bootstrapOnboarding\(\)[\s\S]*?await activateVesloHostWorkspace\(workspacePath\);[\s\S]*?options\.populateSidebarFromDb\(/s,
    "bootstrap must sync the Veslo host active workspace before reading DB conversations",
  );
  assert.match(
    source,
    /async function bootstrapOnboarding\(\)[\s\S]*?options\.setEngineReady\?\.\(false\)/s,
    "bootstrap must explicitly mark engine as not-ready so browsing-mode UI activates",
  );
});

test("lazy DB hydration selects a stored or latest session only while the workspace is still active", () => {
  assert.match(
    appSource,
    /hydrateLatestSessionFromDb: async \(workspaceId: string, directory: string\) => \{[\s\S]*const \{ visible \} = partitionVesloUtilitySessions\(result\.items\);[\s\S]*const rememberedSessionId = activeWorkspaceLastSessionId\(\)\?\.trim\(\) \?\? "";[\s\S]*visible\[0\][\s\S]*sessionStore\.hydrateTranscriptSnapshot\(snapshot\);[\s\S]*if \(selectedSessionId\(\)\?\.trim\(\)\) return;[\s\S]*if \(workspaceStore\.activeWorkspaceId\(\)\.trim\(\) !== workspaceId\.trim\(\)\) return;[\s\S]*await selectSession\(latest\.id\);/s,
    "lazy DB hydration should render at least the remembered/latest active workspace session without cold-starting another workspace engine",
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
    /if \(quietPortRefresh\) \{[\s\S]*deps\.wsDebug\("connect:proxy-bound"[\s\S]*return true;[\s\S]*\}[\s\S]*await runPostConnectSideEffects\(context, navigate\);/s,
    "quiet port-rotation must not load sessions, poll permissions, or mark the engine stable before it has actually started",
  );
  assert.match(
    connectionControllerSource,
    /const runPostConnectSideEffects = async[\s\S]*await deps\.loadSessions\(context\?\.targetRoot\);[\s\S]*await deps\.refreshPendingPermissions\(\);[\s\S]*deps\.onEngineStable\?\.\(\);/s,
    "non-quiet connect should keep session, permission, and engine-stable side effects grouped after routed client commit",
  );
  assert.match(
    connectionControllerSource,
    /if \(!quiet\) \{\s*deps\.setError\(null\);[\s\S]*deps\.setSseConnected\(false\);[\s\S]*\}/s,
    "quiet port-rotation must not clear global errors or flip SSE disconnected state during active UI work",
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
    /connectedToLocalHost = await deps\.localRuntimeLifecycle\.reattachOrchestratorWorkspace\(\{/,
    "remote-to-local reuse should delegate to the shared helper",
  );

  assert.match(
    source,
    /const ok = await deps\.localRuntimeLifecycle\.restartWorkspaceRuntime\(\{/,
    "local-to-local engine switching should delegate to the shared helper",
  );

  assert.match(
    source,
    /ok = await deps\.localRuntimeLifecycle\.restartWorkspaceRuntime\(\{[\s\S]*connectMode: "quiet"/s,
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
