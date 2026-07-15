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
const engineCommandSource = readFileSync(
  new URL("../../../../../desktop/src-tauri/src/commands/engine.rs", import.meta.url),
  "utf8",
);
const orchestratorCommandSource = readFileSync(
  new URL("../../../../../desktop/src-tauri/src/commands/orchestrator.rs", import.meta.url),
  "utf8",
);

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

test("browsing mode keeps the live client and preserves target runtime readiness before SQLite-backed browsing", () => {
  const localActivationSource = readContextSource("workspace-activation-local.ts");

  assert.match(
    localActivationSource,
    /const targetRuntimeReady = Boolean\(deps\.isWorkspaceRuntimeReady\?\.\(id\)\);/,
    "local activation should ask for workspace-scoped runtime readiness before touching global engineReady",
  );
  assert.match(
    localActivationSource,
    /if \(targetRuntimeReady\) \{[\s\S]*deps\.setEngineReady\?\.\(true\);[\s\S]*\} else if \(startedFromLocalMode && workspaceChanged && isTauriRuntime\(\) && deps\.populateSidebarFromDb\) \{[\s\S]*deps\.setEngineReady\?\.\(false\);[\s\S]*\}/s,
    "browse mode must not demote engineReady when the target workspace already has a ready route/runtime",
  );
  assert.match(
    localActivationSource,
    /deps\.setEngineReady\?\.\(selection\.targetRuntimeReady\);[\s\S]*await deps\.populateSidebarFromDb!\(id, next\.path\);/s,
    "SQLite-backed browse should publish target readiness before title-only DB hydration",
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
    /!selection\.passiveBrowseActivation[\s\S]*!\(selection\.startedFromLocalMode \|\| selection\.wasLocalConnection \|\| isColdBoot \|\| needsEngineWarmup\)/s,
    "local browse mode should be limited to explicit passive browse activations, not send or compose activations",
  );
  assert.match(
    localActivationSource,
    /if \(selection\.passiveBrowseActivation\) \{[\s\S]*activate:local:veslo-host-active:skip[\s\S]*\} else \{[\s\S]*await deps\.activateVesloHostWorkspace\(next\.path\);/s,
    "passive browse should not call Veslo server /workspaces/:id/activate through host activation",
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

test("passive browse path is non-spawning and title-only", () => {
  const facadeSource = readWorkspaceFacadeSource();
  const match = facadeSource.match(/async function browseWorkspace[\s\S]*?const connectionController/);
  assert.ok(match, "workspace facade should expose a dedicated browseWorkspace function");
  const browseSource = match[0] ?? "";

  assert.match(
    browseSource,
    /isPassiveLocalBrowseActivationOrigin\(activationOptions\.origin\)/,
    "browseWorkspace should only accept explicit passive browse origins",
  );
  assert.match(
    browseSource,
    /workspaceSetActive\(id, \{ promoteToFront: activationOptions\.promoteToFront \?\? false \}\)/,
    "passive browse may update the local Tauri active marker because this command is state-only",
  );
  assert.match(
    browseSource,
    /await options\.populateSidebarFromDb\(id, nextRoot\)/,
    "passive browse should load only title rows from the host DB",
  );
  assert.doesNotMatch(
    browseSource,
    /activateVesloHostWorkspace|orchestratorWorkspaceActivate|ensureEngineForWorkspace|prepareWorkspaceRuntime|restartWorkspaceRuntime|workspaceRouting\.ensure|hydrateLatestSessionFromDb|setConnectingWorkspaceId|status: "connecting"/,
    "passive browse must not call server/orchestrator activate, runtime prepare/restart, transcript hydration, or connecting state",
  );
});

test("workspace store wires lifecycle reducer to activation and passive browse events", () => {
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(
    facadeSource,
    /createInitialWorkspaceLifecycleState,[\s\S]*reduceWorkspaceLifecycleState,[\s\S]*type WorkspaceLifecycleEvent,/s,
    "workspace store should import the existing lifecycle reducer instead of introducing another runtime state model",
  );
  assert.match(
    facadeSource,
    /const \[workspaceLifecycleState, setWorkspaceLifecycleState\] =[\s\S]*createSignal\(createInitialWorkspaceLifecycleState\(\)\);[\s\S]*const dispatchWorkspaceLifecycle = \(event: WorkspaceLifecycleEvent\) => \{[\s\S]*reduceWorkspaceLifecycleState\(state, event\)/s,
    "workspace store should own one lifecycle signal backed by the shared reducer",
  );
  assert.match(
    facadeSource,
    /dispatchWorkspaceLifecycle\(\{[\s\S]*type: "activation-started",[\s\S]*workspaceId: id,[\s\S]*version: myVersion,[\s\S]*origin: activationOptions\.origin \?\? "unknown",[\s\S]*workspaceType: next\.workspaceType,/s,
    "blocking activation should publish activation-started with the activation guard version",
  );
  assert.match(
    facadeSource,
    /dispatchWorkspaceLifecycle\([\s\S]*type: "connected",[\s\S]*workspaceId: id,[\s\S]*version: myVersion,[\s\S]*reason: activationOptions\.origin \?\? "activation"/s,
    "successful activation should publish a versioned connected event",
  );
  assert.match(
    facadeSource,
    /dispatchWorkspaceLifecycle\(\{[\s\S]*type: "browse-ready",[\s\S]*workspaceId: id,[\s\S]*root: nextRoot,[\s\S]*\}\);[\s\S]*wsDebug\("browse:local:done"/s,
    "passive browse should publish browse-ready after title-only DB hydration finishes",
  );
  assert.match(
    facadeSource,
    /workspaceLifecycleState,/,
    "workspace lifecycle state should be exposed from the store for diagnostics and future overlay derivation",
  );
});

test("app controllers use the shared browse-policy activation wrapper instead of raw workspace activation", () => {
  assert.match(
    appSource,
    /const activateWorkspaceThroughBrowsePolicy = \([\s\S]*return activateWorkspaceWithBrowsePolicy\(store, workspaceId, options\);[\s\S]*\};/s,
    "App should expose one shared wrapper that delegates passive browse decisions to the tested browse policy",
  );
  assert.match(
    appSource,
    /createPendingSessionDraftController\([\s\S]*workspace: \{[\s\S]*activateWorkspace: activateWorkspaceThroughBrowsePolicy,[\s\S]*createScratchWorkspace/s,
    "pending draft controller should use the browse-policy wrapper",
  );
  assert.match(
    appSource,
    /createComposerTargetController\([\s\S]*workspace: \{[\s\S]*activateWorkspace: activateWorkspaceThroughBrowsePolicy,[\s\S]*pickWorkspaceFolder/s,
    "composer target controller should use the browse-policy wrapper",
  );
  assert.match(
    appSource,
    /createWorkspaceSendTarget<Client>\(\{[\s\S]*activeWorkspaceId: \(\) => workspaceStore\.activeWorkspaceId\(\),[\s\S]*activateWorkspace: activateWorkspaceThroughBrowsePolicy,[\s\S]*recordSendTrace/s,
    "send target activation should use the browse-policy wrapper",
  );
});

test("project-open workspace switches clear stale session routes before passive browse", () => {
  assert.match(
    appSource,
    /const shouldClearSessionRouteForProjectOpen = \(workspaceId: string, origin\?: string \| null\) => \{[\s\S]*origin !== "workspace-session-list:project-open"[\s\S]*location\.pathname\.toLowerCase\(\)\.startsWith\("\/session\/"\)[\s\S]*nextWorkspaceId !== workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*\};/s,
    "explicit project-open switches should only reset concrete session routes when moving to another workspace",
  );

  assert.match(
    appSource,
    /if \(shouldClearSessionRouteForProjectOpen\(workspaceId, options\?\.origin\)\) \{[\s\S]*wsDebug\("route:workspace-project-open:clear-session-route"[\s\S]*navigate\("\/session", \{ replace: true \}\);[\s\S]*\}[\s\S]*if \(isPassiveLocalBrowseActivationOrigin\(options\?\.origin\)\) \{[\s\S]*return activateWorkspaceThroughBrowsePolicy\(workspaceId, options\);[\s\S]*\}[\s\S]*return workspaceStore\.activateWorkspace\(workspaceId, options\);/s,
    "route reset must happen before passive browse so route effects cannot reselect the old session",
  );
});

test("bootstrap does not synchronously connect under lazy boot policy", () => {
  // Lazy boot may warm the engine in the background through the runtime
  // controller, but the old bootstrap-specific connect/start helpers must not
  // be invoked anywhere in this file.
  assert.doesNotMatch(
    source,
    /connectOrRecoverLocalBootstrap/,
    "bootstrap must not invoke connectOrRecoverLocalBootstrap; activate flow owns connect",
  );
  assert.match(
    source,
    /function warmActiveLocalWorkspaceEngineInBackground\([\s\S]*ensureEngineForWorkspace\(workspaceId, \{[\s\S]*reason: "boot-warmup",[\s\S]*loadSessions: false,/s,
    "background warmup should reuse runtime ensure without session-list side effects",
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

test("bootstrap schedules sidebar hydration without blocking lazy boot completion", () => {
  assert.match(
    source,
    /function populateSidebarFromDbInBackground\([\s\S]*?void options\.populateSidebarFromDb\(workspaceId, workspacePath\)/s,
    "bootstrap should keep sidebar SQLite hydration in a fire-and-forget helper",
  );
  assert.match(
    source,
    /async function bootstrapOnboarding\(\)[\s\S]*?lazy boot — skip Veslo host activation[\s\S]*?markOnboardingComplete\(\);[\s\S]*?options\.setOnboardingStep\(resolveWelcomeOnboardingStep\(\)\);[\s\S]*?populateSidebarFromDbInBackground\(/s,
    "bootstrap passive browse must publish boot completion before background engine and DB work",
  );
  assert.doesNotMatch(
    source,
    /await options\.populateSidebarFromDb\(activeWorkspace\?\.id \?\? "", workspacePath\)/,
    "bootstrap must not await sidebar DB hydration before first paint",
  );
  assert.match(
    source,
    /async function bootstrapOnboarding\(\)[\s\S]*?options\.setEngineReady\?\.\(false\)/s,
    "bootstrap must explicitly mark engine as not-ready so browsing-mode UI activates",
  );
});

test("lazy browse stays title-only and does not auto-hydrate or auto-select the latest session", () => {
  const localActivationSource = readContextSource("workspace-activation-local.ts");

  assert.match(
    localActivationSource,
    /activate:local->local:browsingMode:skipLatestHydration[\s\S]*reason: "title-only-browse"/s,
    "local browse mode should explicitly skip latest transcript hydration",
  );
  assert.doesNotMatch(
    localActivationSource,
    /await deps\.hydrateLatestSessionFromDb/,
    "local browse mode must not hydrate transcript or auto-select latest conversation",
  );
  assert.match(
    source,
    /function populateSidebarFromDbInBackground\([\s\S]*?lazy boot — skip latest transcript hydration/s,
    "bootstrap background sidebar hydration should stay title-only",
  );
  assert.doesNotMatch(
    source,
    /await options\.hydrateLatestSessionFromDb\(activeWorkspace\.id, workspacePath\)/,
    "bootstrap must not hydrate transcript or auto-select latest conversation",
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

test("backend runtime prepare owns orchestrator attach fallback decisions", () => {
  assert.match(engineCommandSource, /pub async fn runtime_prepare_workspace\(/);
  assert.match(
    engineCommandSource,
    /workspace_runtime_prepare_action[\s\S]*runtime-recovery[\s\S]*WorkspaceRuntimePrepareAction::FreshStart/s,
    "runtime recovery should become a fresh backend start decision before the UI reconnects",
  );
  assert.match(
    engineCommandSource,
    /orchestrator_workspace_activate_blocking[\s\S]*falling back to fresh start[\s\S]*engine_start_reserved/s,
    "backend prepare should fall back from orchestrator attach to fresh start inside Rust",
  );
  assert.match(
    engineCommandSource,
    /start_queue[\s\S]*\.lock\(\)[\s\S]*engine_start_reserved\([\s\S]*\)\?;[\s\S]*Fresh orchestrator start only boots the daemon[\s\S]*orchestrator_workspace_activate_blocking[\s\S]*engine_info/s,
    "fresh orchestrator start must activate the target workspace before returning engine_info",
  );
  assert.match(
    orchestratorCommandSource,
    /ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS[\s\S]*AgentBuilder::new\(\)[\s\S]*\.timeout\(Duration::from_millis\(\s*ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS,?\s*\)\)[\s\S]*\.post\(&activate_url\)/s,
    "orchestrator workspace activation must have a native HTTP timeout so runtime prepare cannot hang indefinitely",
  );
});

test("workspace activation delegates local runtime reuse and restart flows to the shared lifecycle helper", () => {
  assert.match(
    source,
    /const localRuntimeLifecycle = createLocalRuntimeLifecycle\(/,
    "workspace store should instantiate the shared local runtime lifecycle helper",
  );

  assert.match(
    source,
    /connectedToLocalHost = await deps\.localRuntimeLifecycle\.prepareWorkspaceRuntime\(\{/,
    "remote-to-local reuse should delegate to the backend-owned prepare helper",
  );

  assert.match(
    source,
    /const ok = await deps\.localRuntimeLifecycle\.prepareWorkspaceRuntime\(\{/,
    "local-to-local engine switching should delegate to the backend-owned prepare helper",
  );

  assert.match(
    source,
    /const ok = await deps\.localRuntimeLifecycle\.prepareWorkspaceRuntime\(\{[\s\S]*connectMode: "quiet"/s,
    "browsing-mode engine attach should use the shared backend prepare helper's quiet reconnect path",
  );
});

test("orchestrator browse attach preserves busy state for other live workspaces", () => {
  const ensureSource = readContextSource("workspace-runtime-controller.ts");

  assert.match(
    ensureSource,
    /const runtime = deps\.resolveEngineRuntime\(\);[\s\S]*if \(runtime !== "veslo-orchestrator"\) \{\s*deps\.clearWorkspaceBusyAllExcept\(workspace\.id\);\s*\}/,
    "orchestrator workspace switching must not clear busy state for other pooled workspaces",
  );
});
