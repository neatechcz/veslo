import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const appSendTraceSource = readFileSync(new URL("../context/app-send-trace.ts", import.meta.url), "utf8");
const conversationServiceSource = readFileSync(
  new URL("../context/conversation-service.ts", import.meta.url),
  "utf8",
);
const readinessSource = readFileSync(new URL("../context/send-runtime-readiness.ts", import.meta.url), "utf8");
const schedulerSource = readFileSync(new URL("../lib/workspace-runtime-schedulers.ts", import.meta.url), "utf8");
const mcpRefreshSource = readFileSync(new URL("../lib/mcp-server-refresh.ts", import.meta.url), "utf8");
const mcpRuntimeStatusSource = readFileSync(
  new URL("../lib/mcp-runtime-status-refresh.ts", import.meta.url),
  "utf8",
);
const mcpConnectionWorkflowSource = readFileSync(
  new URL("../context/mcp-connection-workflow.ts", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(new URL("../components/session/composer.tsx", import.meta.url), "utf8");
const sidebarWorkspaceSessionsSource = readFileSync(
  new URL("../context/sidebar-workspace-sessions.ts", import.meta.url),
  "utf8",
);
const sessionCapabilitiesStoreSource = readFileSync(
  new URL("../context/session-capabilities-store.ts", import.meta.url),
  "utf8",
);
const workspaceSessionSnapshotsSource = readFileSync(
  new URL("../context/workspace-session-snapshots.ts", import.meta.url),
  "utf8",
);
const mutationWorkflowSource = readFileSync(
  new URL("../pages/session-mutation-workflow.ts", import.meta.url),
  "utf8",
);
const sendWorkflowSource = readFileSync(
  new URL("../pages/session-send-workflow.ts", import.meta.url),
  "utf8",
);
const createWorkflowSource = readFileSync(
  new URL("../pages/session-creation-workflow.ts", import.meta.url),
  "utf8",
);

function conversationRunCompatibilityBridgeSource(): string {
  const start = sendWorkflowSource.indexOf("export function createConversationRunCompatibilityBridge(");
  const end = sendWorkflowSource.indexOf("export function createSessionSendWorkflow(", start);
  assert.ok(start >= 0 && end > start, "conversation run compatibility bridge source should be present");
  return sendWorkflowSource.slice(start, end);
}

test("send preflight records per-step latency trace entries for step 2", () => {
  assert.match(
    appSendTraceSource,
    /const sendTraceStep = async <T,>\(/,
    "app send trace owner should expose a helper that records duration for awaited send preflight steps",
  );
  for (const event of [
    "sendPrompt:maybe-resolve-skill-command",
    "sendPrompt:ensure-scoped-workspace-active",
    "sendPrompt:create-session-and-open",
  ]) {
    assert.match(
      sendWorkflowSource,
      new RegExp(`deps\\.sendTraceStep\\(\\s*"${event}"`),
      `${event} should be timed with sendTraceStep`,
    );
  }
  for (const event of [
    "sendPrompt:ensure-local-runtime-reachable",
    "sendPrompt:ensure-managed-ai-bootstrap-ready",
  ]) {
    assert.match(
      readinessSource,
      new RegExp(`deps\\.sendTraceStep\\(\\s*\`${"\\$"}\\{reason\\}:${event.replace("sendPrompt:", "")}\``),
      `${event} should be timed by the send runtime readiness owner`,
    );
  }
  assert.match(
    readinessSource,
    /deps\.sendTraceStep\(\s*`\$\{reason\}:runtime-recovery-ensure-engine`/,
    "workspace engine recovery should still be timed from the readiness owner",
  );
});

test("send flow preserves UI trace id and forwards each trace through the shared native sink", () => {
  assert.match(
    appSendTraceSource,
    /const createSendPreflightContext = \(traceId\?: string \| null\): AppSendPreflightContext => \(\{\s*traceId: traceId\?\.trim\(\) \|\| makeSendTraceId\(\),/,
    "send preflight should reuse the trace id created by the UI send action",
  );
  assert.match(
    sendWorkflowSource,
    /const sendPreflight = deps\.createSendPreflightContext\(options\.sendTraceId\);/,
    "app sendPrompt should seed preflight tracing from composer send options",
  );
  assert.match(
    appSendTraceSource,
    /recordSendWorkflowTrace\("app", event, safePayload\);/,
    "app send trace owner should use the shared native workflow trace sink",
  );
  assert.doesNotMatch(
    appSendTraceSource,
    /logUiEvent\("send-trace"/,
    "app send trace owner must not duplicate the shared workflow trace over Tauri IPC",
  );
  assert.match(
    appSendTraceSource,
    /relativeMs/,
    "send trace entries should include a relative timestamp for cold-start timelines",
  );
  assert.match(
    source,
    /const appSendTrace = createAppSendTrace\(\);[\s\S]*createSendPreflightContext[\s\S]*recordSendTrace[\s\S]*sendTraceStep/,
    "app should wire send trace helpers from the app send trace owner",
  );
});

test("skill command resolution uses the scoped send target workspace", () => {
  assert.match(
    sendWorkflowSource,
    /async function maybeResolveSkillCommand\(\s*draft: ComposerDraft,\s*traceId\?: string \| null,\s*targetWorkspace\?: SendTargetWorkspaceScope \| null,/,
    "skill resolution should accept the workspace resolved for the current send",
  );
  assert.match(
    sendWorkflowSource,
    /const targetWorkspaceId = targetWorkspace\?\.workspaceId\?\.trim\(\) \|\| "";\s*const workspaceId = targetWorkspaceId \|\| deps\.resolvedDevtoolsWorkspaceId\(\);/,
    "skill resolution should prefer the scoped send workspace before the devtools fallback",
  );
  assert.match(
    sendWorkflowSource,
    /\(\) => maybeResolveSkillCommand\(resolvedDraft, sendTraceId, sendTargetWorkspace\)/,
    "sendPrompt should pass the scoped target workspace into skill resolution",
  );
});

test("send-time workspace activation preserves scoped browsed conversation state", () => {
  assert.match(
    source,
    /createWorkspaceSessionSnapshots\(\{[\s\S]*selectedSessionId,[\s\S]*resolveSelectedSessionBrowseScope,[\s\S]*saveWorkspaceSnapshot: \(workspaceId\) => sessionStore\.saveWorkspaceSnapshot\(workspaceId\),[\s\S]*loadWorkspaceSnapshot: \(workspaceId\) => sessionStore\.loadWorkspaceSnapshot\(workspaceId\),[\s\S]*\}\);/,
    "app should wire workspace snapshot save/load through the workspace session snapshots controller",
  );
  assert.match(
    workspaceSessionSnapshotsSource,
    /const selectedBelongsToOutgoing =\s*!selectedScopeWorkspaceId \|\| selectedScopeWorkspaceId === previousWorkspaceId;[\s\S]*saveWorkspaceId = previousWorkspaceId;/s,
    "outgoing workspace snapshot must not be overwritten by a scoped conversation from another workspace",
  );
  assert.match(
    workspaceSessionSnapshotsSource,
    /const selectedBelongsToIncoming = selectedScopeWorkspaceId === activeWorkspaceId;[\s\S]*if \(!selectedBelongsToIncoming\) \{[\s\S]*loadWorkspaceId = activeWorkspaceId;/s,
    "incoming workspace snapshot must not replace the scoped conversation during send-time activation",
  );
});

test("active conversation busy state follows scoped selected session workspace", () => {
  assert.match(
    source,
    /const activeConversationBusy = createMemo\(\(\) => \{[\s\S]*const sessionId = activeSessionId\(\);[\s\S]*const scope = sessionId \? resolveSelectedSessionBrowseScope\(sessionId\) : null;[\s\S]*const workspaceId = scope\?\.workspaceId\?\.trim\(\) \|\| currentWorkspaceStoreRef\(\)\?\.activeWorkspaceId\(\)\.trim\(\) \|\| "";[\s\S]*const sessionsForWorkspace = workspaceId \? busySessionByWorkspaceId\(\)\[workspaceId\] : null;[\s\S]*if \(!sessionsForWorkspace \|\| !sessionId\) return false;[\s\S]*sessionIdentityCandidates\(sessionId, scope\)\.some\(\(id\) =>[\s\S]*Boolean\(sessionsForWorkspace\[id\]\),[\s\S]*\);[\s\S]*\}\);/,
    "composer busy state should use the displayed scoped session workspace instead of only the active workspace",
  );
});

test("artifact family workspace root follows scoped selected session", () => {
  assert.match(
    source,
    /resolveArtifactFamilies\(\{[\s\S]*workspaceRoot:\s*\(activeSessionId\(\) \? resolveSelectedSessionBrowseScope\(activeSessionId\(\)!\)\?\.workspaceRoot : null\) \|\|\s*workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\),[\s\S]*\}\)/,
    "artifact rendering should resolve relative paths against the displayed scoped session workspace root",
  );
});

test("artifact families project latest-run artifacts from the selected transcript", () => {
  assert.match(
    source,
    /const projection = transcriptProjectionStore\.currentTranscriptProjection\(\);[\s\S]*resolveArtifactFamilies\(\{[\s\S]*serverArtifacts: projection\?\.items,[\s\S]*preferServerArtifacts: Boolean\(projection\),[\s\S]*legacyArtifacts: projection \? \[\] : artifacts\(\),[\s\S]*workingFiles: projection \? \[\] : workingFiles\(\),/s,
    "artifact rendering should use the guarded latest-run projection from the selected transcript",
  );
  assert.doesNotMatch(
    source,
    /getSessionLatestRunArtifacts/,
    "artifact rendering must not issue an uncorrelated latest-run request after a transcript projection is reserved",
  );
});

test("conversation read workspace registration dedupes per Veslo client", () => {
  assert.match(
    conversationServiceSource,
    /const conversationWorkspaceRegistrationCacheByClient = new WeakMap<[\s\S]*Map<string, ConversationWorkspaceRegistrationFlight>[\s\S]*>\(\);/,
    "conversation workspace registration should keep a cache scoped to the current Veslo client object",
  );
  assert.match(
    conversationServiceSource,
    /if \(!requireLiveOpencodeBaseUrl\) \{[\s\S]*const liveRegistration = registrationCache\.get\(liveRegistrationCacheKey\);[\s\S]*const result = await liveRegistration\.promise;[\s\S]*if \(result\.cacheable && result\.id\) return result\.id;/,
    "a read started during a live registration should join that in-flight registration before doing its own lookup",
  );
  assert.match(
    conversationServiceSource,
    /const cachedRegistration = registrationCache\.get\(registrationCacheKey\);[\s\S]*return \(await cachedRegistration\.promise\)\.id;/,
    "repeated registrations with the same policy should join the same in-flight lookup",
  );
  assert.match(
    conversationServiceSource,
    /if \(!result\.cacheable && registrationCache\.get\(registrationCacheKey\) === registrationFlight\) \{[\s\S]*registrationCache\.delete\(registrationCacheKey\);[\s\S]*\}/,
    "failed fallback-only registration attempts should not be cached forever",
  );
});

test("create session preflight records duration for duplicate gates and server creation", () => {
  const start = createWorkflowSource.indexOf("const runCreateSessionFlow = async (");
  const end = createWorkflowSource.indexOf("\n  const createSession = (", start);
  assert.ok(start >= 0 && end > start, "runCreateSessionFlow source should be present");
  const createSource = createWorkflowSource.slice(start, end);

  for (const event of [
    "createSessionAndOpen:ensure-managed-ai-bootstrap-ready",
    "createSessionAndOpen:ensure-local-runtime-reachable",
    "createSessionAndOpen:abort-refresh-settle",
    "createSessionAndOpen:veslo-conversation-create",
    "createSessionAndOpen:select-session",
  ]) {
    assert.match(
      createSource,
      new RegExp(`deps\\.sendTraceStep\\(\\s*"${event}"`),
      `${event} should be timed with sendTraceStep`,
    );
  }
});

test("create run and compact do not fall back to legacy OpenCode SDK writes", () => {
  const compactStart = mutationWorkflowSource.indexOf("  async function submitCurrentSessionCompaction(");
  const compactEnd = mutationWorkflowSource.indexOf("  async function replaceUserMessage(", compactStart);
  const createStart = createWorkflowSource.indexOf("const runCreateSessionFlow = async (");
  const createEnd = createWorkflowSource.indexOf("\n  const createSession = (", createStart);

  assert.ok(compactStart >= 0 && compactEnd > compactStart, "submitCurrentSessionCompaction source should be present");
  assert.ok(createStart >= 0 && createEnd > createStart, "runCreateSessionFlow source should be present");

  const bridgeSource = conversationRunCompatibilityBridgeSource();
  const compactSource = mutationWorkflowSource.slice(compactStart, compactEnd);
  const createSource = createWorkflowSource.slice(createStart, createEnd);

  assert.match(bridgeSource, /const runConversationOrFail = async \(runInput: VesloConversationRunInput\)/);
  assert.doesNotMatch(bridgeSource, /runConversationOrLegacy|sendPrompt:legacy-run-fallback|c\.session\.promptAsync|c\.session\.command|shellInSession/);
  assert.doesNotMatch(compactSource, /compactSession:legacy-run-fallback|compactSessionTyped|falling back to OpenCode SDK/);
  assert.doesNotMatch(createSource, /legacy-create-fallback|legacy-session-create|c\.session\.create|falling back to OpenCode SDK/);
  assert.match(createSource, /throw new Error\("Conversation service is unavailable for session creation\."\);/);
});

test("create session preflight does not add a fixed abort-refresh settle delay", () => {
  const start = createWorkflowSource.indexOf("const runCreateSessionFlow = async (");
  const end = createWorkflowSource.indexOf("\n  const createSession = (", start);
  assert.ok(start >= 0 && end > start, "runCreateSessionFlow source should be present");
  const createSource = createWorkflowSource.slice(start, end);
  const settleStart = createSource.indexOf('"createSessionAndOpen:abort-refresh-settle"');
  const settleEnd = createSource.indexOf("deps.setError(null);", settleStart);
  assert.ok(settleStart >= 0 && settleEnd > settleStart, "abort-refresh trace block should be present");
  const settleSource = createSource.slice(settleStart, settleEnd);

  assert.match(
    settleSource,
    /deps\.abortRefreshes\(\);/,
    "create session should still synchronously cancel refresh work before session creation",
  );
  assert.doesNotMatch(
    settleSource,
    /setTimeout\([^)]*,\s*50\)/,
    "create session should not spend a fixed 50ms delay before model submission",
  );
});

test("sidebar bulk refresh is single-flight to avoid duplicate cold workspace session scans", () => {
  assert.match(
    sidebarWorkspaceSessionsSource,
    /let sidebarBulkRefreshInFlight: Promise<void> \| null = null;/,
    "sidebar bulk refresh should keep a single in-flight promise",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const existingBulkRefresh = sidebarBulkRefreshInFlight;[\s\S]*await existingBulkRefresh;[\s\S]*"refresh-all-joined"/,
    "refresh-all should join an existing bulk refresh instead of starting duplicate workspace scans",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const existingBulkRefresh = sidebarBulkRefreshInFlight;[\s\S]*await existingBulkRefresh;[\s\S]*"refresh-local-joined"/,
    "refresh-local should join an existing bulk refresh instead of duplicating refresh-all work",
  );
  assert.match(
    source,
    /const sidebarWorkspaceSessions = createSidebarWorkspaceSessions\(\{[\s\S]*workspaceStore,[\s\S]*workspaceRouting,[\s\S]*listConversationsFromVesloReadApi,[\s\S]*backfillConversationsToVesloReadApi,[\s\S]*\}\);/,
    "app should wire sidebar session behavior through the sidebar workspace sessions controller",
  );
});

test("sidebar conversation read sync follows warm workspace readiness", () => {
  assert.match(
    sidebarWorkspaceSessionsSource,
    /listConversationsFromVesloReadApi: \([\s\S]*workspaceId: string,[\s\S]*directory\?: string,[\s\S]*options\?: \{ sync\?: boolean \},[\s\S]*\) => Promise<ConversationReadResult>;[\s\S]*shouldSyncConversationRead\?: \(workspaceId: string\) => boolean;[\s\S]*allowLiveWorkspaceSessionList\?: \(workspaceId: string\) => boolean;/,
    "sidebar read API dependency should accept an explicit sync option",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const sync = readOptions\?\.sync \?\? \(options\.shouldSyncConversationRead\?\.\(workspaceId\) === true\);[\s\S]*options\.listConversationsFromVesloReadApi\(workspaceId, directory, \{ sync \}\);/,
    "sidebar read API calls should request sync through an explicit override or per-workspace readiness predicate",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const refreshFromHostReadApi = async[\s\S]*refreshSidebarWorkspaceSessionsFromReadApi\(id, hostReadDirectory, reason, readOptions\)[\s\S]*if \(result\.available\) return result;[\s\S]*if \(activeSendTraceId\) \{[\s\S]*scheduleDeferredSidebarRefresh\(id, activeSendTraceId\);[\s\S]*await refreshFromHostReadApi\("active-send-host-read", \{ sync: false \}\);[\s\S]*return;/,
    "sidebar refresh should still run host-first conversation reads during active sends while deferring live engine refresh",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const hostFirstResult = await refreshFromHostReadApi\("host-first"\);[\s\S]*if \(hostFirstResult\) return;[\s\S]*const activeWorkspaceId = options\.workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*if \(hostReadDirectory && options\.allowLiveWorkspaceSessionList\?\.\(id\) !== true\) \{[\s\S]*skipLiveSidebarSessionList\(id, "live-session-list-not-allowed"\);[\s\S]*return;[\s\S]*\}[\s\S]*if \(activeWorkspaceId === id && !options\.activeWorkspaceRuntimeReady\(\)\) \{[\s\S]*markSidebarRefreshUnavailable\(id, "active-runtime-not-ready"\);[\s\S]*return;[\s\S]*\}[\s\S]*if \(!config\.baseUrl\)/,
    "normal local sidebar refresh should prefer host conversation reads and soft-skip live OpenCode session listing until send flow explicitly allows live reads",
  );
  assert.match(
    source,
    /const runtimeOwner = createRuntimeOwner\(\{[\s\S]*activeWorkspaceId: \(\) => currentWorkspaceStoreRef\(\)\?\.activeWorkspaceId\(\)\.trim\(\) \?\? "",[\s\S]*activeLegacyEngineReady: \(\) => engineReady\(\),[\s\S]*readyEngineWorkspaceIds,[\s\S]*workspaceBusy: \(\) => currentWorkspaceStoreRef\(\)\?\.workspaceBusy\(\) \?\? \{\},[\s\S]*routing: workspaceRouting,[\s\S]*\}\);[\s\S]*const shouldSyncConversationReadForWorkspace =[\s\S]*runtimeOwner\.shouldSyncConversationReadForWorkspace;[\s\S]*shouldSyncConversationRead: shouldSyncConversationReadForWorkspace,[\s\S]*allowLiveWorkspaceSessionList: isLiveTranscriptReadAllowedForWorkspace,/,
    "app should allow passive read sync from the runtime owner while gating local live sidebar lists through explicit send-flow live-read allowance",
  );
});

test("runtime owner gates app-level routing client reads", () => {
  assert.match(
    source,
    /const runtimeOwner = createRuntimeOwner\(\{[\s\S]*routing: workspaceRouting,[\s\S]*\}\);[\s\S]*const runtimeOwnedRouting = createRuntimeOwnedRouting\(workspaceRouting, runtimeOwner\);[\s\S]*const routedClient = \(workspaceId\?: string\) => runtimeOwner\.client\(workspaceId\);/,
    "app should create a runtime-owned routing wrapper next to the runtime owner",
  );
  assert.match(
    source,
    /requiresOrchestratorReadiness: \(workspaceId\) => \{[\s\S]*engineRuntime\(\) !== "veslo-orchestrator"[\s\S]*currentWorkspaceStoreRef\(\)\?\.workspaces\(\)\.find\(\(entry\) => entry\.id === workspaceId\)[\s\S]*workspace\?\.workspaceType === "local";[\s\S]*\}/,
    "local orchestrator routes should not be treated as runtime-ready without an orchestrator engine snapshot",
  );
  assert.match(
    source,
    /const sessionStore = createSessionStore\(\{[\s\S]*client,[\s\S]*routing: runtimeOwnedRouting,/,
    "session store runtime client reads should go through runtime-owned routing",
  );
  assert.match(
    source,
    /const extensionsStore = createExtensionsStore\(\{[\s\S]*client,[\s\S]*routing: runtimeOwnedRouting,/,
    "extensions and skills runtime client reads should go through runtime-owned routing",
  );
  assert.match(
    source,
    /const systemState = createSystemState\(\{[\s\S]*client,[\s\S]*routing: runtimeOwnedRouting,/,
    "system reload/runtime client reads should go through runtime-owned routing",
  );
  assert.match(
    source,
    /<WorkspaceRoutingProvider value=\{runtimeOwnedRouting\}>/,
    "routing context consumers should receive the owner-gated routing surface",
  );
});

test("session-store sidebar sync skips unchanged sidebar rows", () => {
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const sidebarSessionItemsEqual = \(left: SidebarSessionItem\[\], right: SidebarSessionItem\[\]\) => \{[\s\S]*a\.id !== b\.id[\s\S]*a\.title !== b\.title[\s\S]*a\.directory !== b\.directory[\s\S]*a\.time\?\.created[\s\S]*return true;[\s\S]*\};/,
    "app should compare sidebar rows before publishing session-store sync output",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /import \{ deriveSidebarRowsFromSessionStore \} from "\.\.\/lib\/sidebar-session-store-sync";[\s\S]*const activeSendInProgress = Boolean\(options\.activeSendTraceId\?\.\(\)\?\.trim\(\)\);[\s\S]*const existingTargetSidebarRows = untrack\(\(\) => sidebarSessionsByWorkspaceId\(\)\[wsId\] \?\? \[\]\);[\s\S]*activeSendInProgress,[\s\S]*const incomingVisibleRows = expandSidebarSessionSliceWithAncestors\(visibleSessions, requestLimit\);[\s\S]*const nextRows = deriveSidebarRowsFromSessionStore\(\{[\s\S]*incomingSessions: visibleSessions,[\s\S]*existingRows: existingTargetSidebarRows,[\s\S]*setSidebarSessionsByWorkspaceId\(\(prev\) => \{[\s\S]*const currentRows = prev\[wsId\] \?\? \[\];[\s\S]*if \(sidebarSessionItemsEqual\(currentRows, nextRows\)\) return prev;[\s\S]*\[wsId\]: nextRows,[\s\S]*\}\);/,
    "session-store sync should preserve sidebar signal identity when visible rows are unchanged",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const retainedExistingSidebarRows = nextRows\.length > incomingVisibleRows\.length;[\s\S]*setSidebarSessionHasMoreByWorkspaceId\(\(prev\) => \{[\s\S]*const nextHasMore = retainedExistingSidebarRows[\s\S]*\? prev\[wsId\] \?\? deriveSidebarHasMore\(nextRows\.length, requestLimit\)[\s\S]*: deriveSidebarHasMore\(visibleSessions\.length, requestLimit\);[\s\S]*if \(\(prev\[wsId\] \?\? false\) === nextHasMore\) return prev;/,
    "session-store sync should not invalidate sidebar paging state when hasMore is unchanged",
  );
});

test("local sidebar runtime failures fall back to passive conversation read", () => {
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const isSidebarRuntimeUnavailableError = \(message: string\) =>[\s\S]*engine_not_running[\s\S]*error sending request for url[\s\S]*Request timed out[\s\S]*unauthorized/i,
    "sidebar should classify local engine runtime failures and stale local proxy errors separately from real remote errors",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /if \(hostReadDirectory && isSidebarRuntimeUnavailableError\(message\)\) \{[\s\S]*await refreshSidebarWorkspaceSessionsFromReadApi\(id, hostReadDirectory, "engine-runtime-unavailable"\);[\s\S]*return;/,
    "local sidebar refresh should fall back to Veslo read API when a stale engine route reports runtime unavailable",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /void options\.backfillConversationsToVesloReadApi\?\.\(id, queryDirectory, visibleSessions\)[\s\S]*sidebar:conversation-read:backfill-error/,
    "successful live sidebar reads should backfill Veslo conversation bindings without blocking visible UI",
  );
  assert.match(
    conversationServiceSource,
    /const backfillConversationsToVesloReadApi = async[\s\S]*serverClient\.importConversations\(serverWorkspaceId,[\s\S]*deps\.rememberConversationScopesFromSessions\(workspaceId, directory, result\.items\);/,
    "app should backfill imported live sessions through the Veslo read API registration path",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /setSidebarSessionErrorByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[(?:workspaceId|id)\]: null \}\)\);/,
    "passive sidebar fallback should clear stale sidebar errors after publishing rows",
  );
});

test("local sidebar refresh keeps routed auth and does not clear rows when runtime is unavailable", () => {
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const auth = entry\?\.auth \?\? activeEngineAuth;/,
    "local sidebar refresh should prefer the routed workspace entry auth over the active engine auth",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const markSidebarRefreshUnavailable = \(id: string, reason: string\) => \{[\s\S]*existingCount: untrack\(\(\) => sidebarSessionsByWorkspaceId\(\)\[id\]\?\.length \?\? 0\),[\s\S]*\};[\s\S]*markSidebarRefreshUnavailable\(id, "no-engine-base-url"\);/s,
    "sidebar refresh should preserve existing rows when no runtime base URL is available",
  );
});

test("MCP server refresh joins duplicate refreshes for the same workspace context", () => {
  assert.match(
    mcpRefreshSource,
    /const refreshInFlightByKey = new Map<string, McpRefreshInFlight>\(\);/,
    "MCP server refresh should track in-flight refreshes by workspace context",
  );
  assert.match(
    mcpRefreshSource,
    /const refreshKey = \[[\s\S]*activeWorkspaceId[\s\S]*projectDir[\s\S]*canUseVesloServer \? vesloWorkspaceId \?\? "" : ""[\s\S]*\]\.join\("::"\);/,
    "MCP refresh key should include workspace and runtime context",
  );
  assert.doesNotMatch(
    mcpRefreshSource,
    /vesloServerStatus\(\),/,
    "MCP fallback refresh key should not split identical filesystem reads on transient server status changes",
  );
  assert.match(
    mcpRefreshSource,
    /const existingRefresh = refreshInFlightByKey\.get\(refreshKey\);[\s\S]*await existingRefresh\.promise;[\s\S]*"refresh-joined"/,
    "duplicate MCP refreshes for the same key should join the existing promise",
  );
  assert.match(
    mcpRefreshSource,
    /if \(refreshInFlightByKey\.get\(refreshKey\)\?\.promise === run\) \{[\s\S]*refreshInFlightByKey\.delete\(refreshKey\);/,
    "MCP refresh single-flight entry should be cleared after the owning run completes",
  );
  assert.match(
    mcpRefreshSource,
    /if \(refreshMode !== "explicit" \|\| existingRefresh\.mode === "explicit"\) \{[\s\S]*return;[\s\S]*\}/,
    "explicit MCP refresh should not inherit an older auto refresh skip via single-flight join",
  );
  assert.match(
    mcpRefreshSource,
    /const isCurrentRefreshTarget = \(\) =>[\s\S]*options\.activeWorkspaceId\(\)\.trim\(\) === activeWorkspaceId[\s\S]*options\.projectDir\(\)\.trim\(\) === projectDir;/,
    "MCP refresh should re-check workspace and project directory before applying async results",
  );
  assert.match(
    mcpRefreshSource,
    /"refresh-stale-skip"/,
    "stale MCP refresh results should be logged and ignored instead of overwriting the current workspace UI",
  );
  assert.match(
    mcpRefreshSource,
    /return async function refreshMcpServers\(refreshOptions: McpServersRefreshOptions = \{\}\)[\s\S]*const refreshMode = refreshOptions\.mode \?\? "auto";[\s\S]*const skipForActiveRuntimeActivity = \(phase: string\) => \{[\s\S]*if \(refreshMode === "explicit"\) return false;[\s\S]*"workspace\.mcp", "refresh-skip-active-send"[\s\S]*activeSendTraceId: activeRuntimeActivityId,[\s\S]*phase,[\s\S]*return true;[\s\S]*if \(skipForActiveRuntimeActivity\("start"\)\) \{[\s\S]*return;[\s\S]*\}/,
    "MCP auto refresh should skip while visible runtime activity is active, while explicit post-mutation refreshes can still update config state",
  );
  assert.match(
    mcpRefreshSource,
    /const applyEntriesForRun = \(entries: McpServerEntry\[\], phase: string\) => \{[\s\S]*if \(skipForActiveRuntimeActivity\(phase\)\) \{[\s\S]*return;[\s\S]*\}[\s\S]*if \(!isCurrentRefreshTarget\(\)\)/,
    "MCP refresher should also skip late async apply results if a send handoff became active after the refresh started",
  );
  assert.match(
    source,
    /refreshMcpServers = createMcpServersRefresher\(\{[\s\S]*projectDir: \(\) => workspaceProjectDir\(\),[\s\S]*workspaceType: \(\) => workspaceStore\.activeWorkspaceDisplay\(\)\.workspaceType,[\s\S]*activeRuntimeActivityId: activeVisibleRuntimeActivityId,[\s\S]*scheduleRuntimeStatusRefresh: mcpConnectionWorkflow\.scheduleMcpRuntimeStatusRefresh,[\s\S]*\}\);/,
    "app should wire MCP refresh through the dedicated MCP refresh module",
  );
  assert.match(
    mcpConnectionWorkflowSource,
    /await deps\.refreshMcpServers\(\{ mode: "explicit", reason: "mcp-activate-installed" \}\);[\s\S]*await deps\.refreshMcpServers\(\{ mode: "explicit", reason: "mcp-activate-installed-complete" \}\);/,
    "post-install MCP refreshes should be explicit so active conversation runs do not leave the MCP UI stale",
  );
  assert.match(
    mcpConnectionWorkflowSource,
    /await deps\.refreshMcpServers\(\{ mode: "explicit", reason: "mcp-remove" \}\);/,
    "post-remove MCP refresh should be explicit so active conversation runs do not hide the mutation result",
  );
});

test("pending permission interval skips active sends and single-client mode covered by SSE", () => {
  assert.match(
    source,
    /const \[visibleRuntimeActivityHold, setVisibleRuntimeActivityHold\] = createSignal[\s\S]*const holdVisibleRuntimeActivity = \(sessionId: string \| null \| undefined, reason: string\) => \{[\s\S]*const token = `run-handoff:\$\{id\}`;[\s\S]*setVisibleRuntimeActivityHold\(\{ sessionId: id, token, expiresAt \}\);[\s\S]*const activeVisibleRuntimeActivityId = \(\) => \{[\s\S]*const sendTraceId = activeSendTraceId\(\)\?\.trim\(\);[\s\S]*if \(sendTraceId\) return sendTraceId;[\s\S]*const sessionId = selectedSessionId\(\)\?\.trim\(\);[\s\S]*const status = statusForSession\(sessionId\);[\s\S]*if \(status === "running" \|\| status === "retry"\) return `run:\$\{sessionId\}`;[\s\S]*const hold = visibleRuntimeActivityHold\(\);[\s\S]*if \(hold\?\.sessionId === sessionId && hold\.expiresAt > Date\.now\(\)\) return hold\.token;/,
    "app should keep runtime refresh guards active for the visible send, accepted-before-SSE handoff, and selected running session",
  );
  assert.match(
    sendWorkflowSource,
    /deps\.recordSendTrace\("sendPrompt:success"[\s\S]*deps\.holdVisibleRuntimeActivity\(sessionID, "sendPrompt:success"\);[\s\S]*return true;/,
    "successful sends should hold visible runtime activity until session status catches up",
  );
  assert.match(
    schedulerSource,
    /const activeSendTraceId = options\.activeSendTraceId\(\);[\s\S]*if \(activeSendTraceId\) \{[\s\S]*"session\.permissions", "poll-skip-active-send"/,
    "periodic permission polling should skip while a submit is actively running",
  );
  assert.match(
    schedulerSource,
    /if \(activeSendTraceId\) \{[\s\S]*return;[\s\S]*\}[\s\S]*if \(options\.anyWorkspaceRuntimeReady\?\.\(\) === false\) \{[\s\S]*return;[\s\S]*\}[\s\S]*const routedWorkspaceCount = options\.routedWorkspaceCount\(\);[\s\S]*if \(routedWorkspaceCount <= 1\) \{[\s\S]*return;[\s\S]*\}[\s\S]*void options\.refreshPendingPermissions\(\);/,
    "permission polling should not call refreshPendingPermissions during an active send, lazy boot, or single-client mode",
  );
  assert.match(
    composerSource,
    /function setActiveSendTraceId\(sendTraceId: string \| null\)[\s\S]*__vesloActiveSendTraceId = sendTraceId;/,
    "composer should publish the active send trace id for runtime schedulers",
  );
  assert.match(
    composerSource,
    /setActiveSendTraceId\(options\.sendTraceId \?\? null\);\s*sendPromise = props\.onSend\(submittedDraft, sendOptions\);[\s\S]*?sendResult = await sendPromise;[\s\S]*?finally \{[\s\S]*?finishSending\(\);\s*setActiveSendTraceId\(null\);/,
    "composer should keep the active send trace id set while onSend is pending",
  );
  assert.match(
    source,
    /const activeWorkspaceRuntimeReady = runtimeOwner\.activeWorkspaceRuntimeReady;[\s\S]*const anyWorkspaceRuntimeReady = runtimeOwner\.anyWorkspaceRuntimeReady;[\s\S]*createPermissionPollingScheduler\(\{[\s\S]*routedWorkspaceCount: \(\) => workspaceRouting\.entryIds\(\)\.length,[\s\S]*activeWorkspaceId: \(\) => workspaceStore\.activeWorkspaceId\(\)\.trim\(\) \|\| null,[\s\S]*activeSendTraceId: activeVisibleRuntimeActivityId,[\s\S]*anyWorkspaceRuntimeReady,[\s\S]*refreshPendingPermissions: \(\) => sessionStore\.refreshPendingPermissions\(\),[\s\S]*\}\);/,
    "app should wire permission polling to workspace routing, workspace-scoped readiness, visible send/run activity, and session store state",
  );
  assert.match(
    source,
    /const sidebarWorkspaceSessions = createSidebarWorkspaceSessions\(\{[\s\S]*activeWorkspaceRuntimeReady,[\s\S]*activeSendTraceId: activeVisibleRuntimeActivityId,[\s\S]*developerMode: \(\) => developerMode\(\),/,
    "sidebar live refresh should use active workspace readiness and defer for the same visible send/run activity token",
  );
  assert.match(
    sessionCapabilitiesStoreSource,
    /const loadSessionMcpStatuses = async[\s\S]*const activeRuntimeActivityId = deps\.activeVisibleRuntimeActivityId\(\)\?\.trim\(\);[\s\S]*"session-capabilities-skip-active-send"[\s\S]*return \{\};[\s\S]*const status = unwrap\(await runtimeClient\.mcp\.status\(\{ directory \}\)[\s\S]*"session-capabilities-result-skip-active-send"[\s\S]*return \{\};/,
    "session capability MCP status reads should not run or apply results during the visible send handoff",
  );
  assert.match(
    mcpConnectionWorkflowSource,
    /const mcpRuntimeStatusRefresher = createMcpRuntimeStatusRefresher<Client>\(\{[\s\S]*activeRuntimeActivityId: deps\.activeRuntimeActivityId,[\s\S]*activeWorkspaceRuntimeReady: deps\.activeWorkspaceRuntimeReady,[\s\S]*client: deps\.routedClient,[\s\S]*currentEntries: \(\) => deps\.mcpServers\(\),[\s\S]*loadStatus: async \(activeClient, directory\) =>[\s\S]*activeClient\.mcp\.status\(\{ directory \}\)[\s\S]*setStatuses: deps\.setMcpStatuses,[\s\S]*recordEvent: \(event, payload\) =>[\s\S]*deps\.recordPerfLog\(deps\.developerMode\(\), "workspace\.mcp", event, payload\),[\s\S]*\}\);[\s\S]*function scheduleMcpRuntimeStatusRefresh\(projectDir: string, entries: McpServerEntry\[\]\) \{[\s\S]*mcpRuntimeStatusRefresher\.schedule\(projectDir, entries\);[\s\S]*\}/,
    "MCP runtime status scheduling should be delegated to the testable runtime status refresher",
  );
  assert.match(
    mcpRuntimeStatusSource,
    /const activeRuntimeActivityId = options\.activeRuntimeActivityId\(\)\?\.trim\(\);[\s\S]*"runtime-status-skip-active-send"[\s\S]*return;[\s\S]*(?:const|let) status = await options\.loadStatus\(activeClient, directory\);[\s\S]*"runtime-status-result-skip-active-send"[\s\S]*return;/,
    "MCP runtime status scheduling should skip direct runtime calls and late applies during visible send handoff",
  );
});

test("MCP auto refresh scheduler keeps UI wiring thin", () => {
  assert.match(
    schedulerSource,
    /export function createMcpAutoRefreshScheduler/,
    "MCP auto refresh scheduling should live outside the app component",
  );
  assert.match(
    schedulerSource,
    /if \(!options\.isTauriRuntime\(\)\) return;[\s\S]*if \(options\.activeWorkspaceRuntimeReady\(\) === false\) return;[\s\S]*const projectDir = options\.workspaceProjectDir\(\)\.trim\(\);[\s\S]*if \(!projectDir\) return;[\s\S]*const activeSendTraceId = options\.activeSendTraceId\?\.\(\)\?\.trim\(\) \?\? "";[\s\S]*if \(activeSendTraceId\) \{[\s\S]*scheduleDeferredRefresh\(activeSendTraceId, projectDir\);[\s\S]*return;[\s\S]*\}[\s\S]*scheduleAutoRefresh\(projectDir\);/,
    "MCP scheduler should preserve Tauri, engine and project directory gates while deferring during active sends",
  );
  assert.match(
    schedulerSource,
    /export function mcpAutoRefreshTargetKey[\s\S]*export function shouldRefreshMcpAutoRefreshTarget[\s\S]*"workspace\.mcp", "refresh-skip-recent-target"/,
    "MCP scheduler should dedupe repeated auto refreshes by stable workspace/project target",
  );
  assert.match(
    schedulerSource,
    /"workspace\.mcp", "refresh-skip-active-send"/,
    "MCP scheduler should log and defer automatic refresh while a send is active",
  );
  assert.match(
    schedulerSource,
    /const nextActiveSendTraceId = options\.activeSendTraceId\?\.\(\)\?\.trim\(\) \?\? "";[\s\S]*if \(nextActiveSendTraceId\) \{[\s\S]*scheduleDeferredRefresh\(nextActiveSendTraceId, options\.workspaceProjectDir\(\)\.trim\(\)\);[\s\S]*return;[\s\S]*\}/,
    "deferred MCP refresh should keep waiting until the active send clears",
  );
  assert.match(
    source,
    /createMcpAutoRefreshScheduler\(\{[\s\S]*isTauriRuntime,[\s\S]*activeWorkspaceRuntimeReady,[\s\S]*activeWorkspaceId: \(\) => workspaceStore\.activeWorkspaceId\(\),[\s\S]*activeSendTraceId: activeVisibleRuntimeActivityId,[\s\S]*workspaceProjectDir: \(\) => workspaceProjectDir\(\),[\s\S]*refreshMcpServers,[\s\S]*\}\);/,
    "app should wire MCP auto refresh to active workspace readiness and visible send/run activity without duplicating scheduler logic",
  );
  assert.doesNotMatch(
    source,
    /createEffect\(\(\) => \{\s*if \(!isTauriRuntime\(\)\) return;\s*workspaceStore\.activeWorkspaceId\(\);\s*workspaceProjectDir\(\);\s*void refreshMcpServers\(\);\s*\}\);/,
    "app must not keep a raw MCP auto-refresh effect that bypasses the scheduler active-send guard",
  );
});

test("selected transcript reads stay passive while accepted-run recovery owns server start", () => {
  assert.doesNotMatch(
    source,
    /activeVisibleSelectedSession|serverStartRecoveryKey/,
    "ordinary selected-session transcript reads must not obtain local-server-start authority",
  );

  assert.match(
    source,
    /recoverAcceptedConversationRunStatus,/,
    "the accepted-run lifecycle owner should receive the dedicated recovery executor",
  );

  assert.match(
    source,
    /hydrateLatestSessionFromDb: async \(workspaceId: string, directory: string\) => \{[\s\S]*const snapshot = await getTranscriptFromVesloReadApi\(workspaceId, latest\.id, 50, directory\);/s,
    "background latest-session hydration must remain passive and must not opt into server-start recovery",
  );

  assert.doesNotMatch(
    source,
    /createSubmittedRunTranscriptCatchup|scheduleSubmittedRunTranscriptCatchup/,
    "normal submit must not schedule a client transcript re-read that can overwrite live SSE state",
  );
});
