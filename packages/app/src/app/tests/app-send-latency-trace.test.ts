import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const schedulerSource = readFileSync(new URL("../lib/workspace-runtime-schedulers.ts", import.meta.url), "utf8");
const mcpRefreshSource = readFileSync(new URL("../lib/mcp-server-refresh.ts", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("../components/session/composer.tsx", import.meta.url), "utf8");
const sidebarWorkspaceSessionsSource = readFileSync(
  new URL("../context/sidebar-workspace-sessions.ts", import.meta.url),
  "utf8",
);
const workspaceSessionSnapshotsSource = readFileSync(
  new URL("../context/workspace-session-snapshots.ts", import.meta.url),
  "utf8",
);

test("send preflight records per-step latency trace entries for step 2", () => {
  assert.match(
    source,
    /const sendTraceStep = async <T,>\(/,
    "app should expose a helper that records duration for awaited send preflight steps",
  );
  for (const event of [
    "sendPrompt:maybe-resolve-skill-command",
    "sendPrompt:ensure-scoped-workspace-active",
    "sendPrompt:ensure-engine-for-workspace",
    "sendPrompt:ensure-managed-ai-bootstrap-ready",
    "sendPrompt:ensure-local-runtime-reachable",
    "sendPrompt:create-session-and-open",
  ]) {
    assert.match(
      source,
      new RegExp(`sendTraceStep\\(\\s*"${event}"`),
      `${event} should be timed with sendTraceStep`,
    );
  }
});

test("send flow preserves UI trace id and forwards trace entries to native logs", () => {
  assert.match(
    source,
    /const createSendPreflightContext = \(traceId\?: string \| null\): SendPreflightContext => \(\{\s*traceId: traceId\?\.trim\(\) \|\| makeSendTraceId\(\),/,
    "send preflight should reuse the trace id created by the UI send action",
  );
  assert.match(
    source,
    /const sendPreflight = createSendPreflightContext\(options\.sendTraceId\);/,
    "app sendPrompt should seed preflight tracing from composer send options",
  );
  assert.match(
    source,
    /logUiEvent\("send-trace", event, entry\);/,
    "app send trace entries should be forwarded to Tauri stderr",
  );
  assert.match(
    source,
    /relativeMs/,
    "send trace entries should include a relative timestamp for cold-start timelines",
  );
});

test("skill command resolution uses the scoped send target workspace", () => {
  assert.match(
    source,
    /async function maybeResolveSkillCommand\(\s*draft: ComposerDraft,\s*traceId\?: string \| null,\s*targetWorkspace\?: SendTargetWorkspaceScope \| null,/,
    "skill resolution should accept the workspace resolved for the current send",
  );
  assert.match(
    source,
    /const targetWorkspaceId = targetWorkspace\?\.workspaceId\?\.trim\(\) \|\| "";\s*const workspaceId = targetWorkspaceId \|\| resolvedDevtoolsWorkspaceId\(\);/,
    "skill resolution should prefer the scoped send workspace before the devtools fallback",
  );
  assert.match(
    source,
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
    /const activeConversationBusy = createMemo\(\(\) => \{[\s\S]*const sessionId = activeSessionId\(\);[\s\S]*const scope = sessionId \? resolveSelectedSessionBrowseScope\(sessionId\) : null;[\s\S]*const workspaceId = scope\?\.workspaceId\?\.trim\(\) \|\| currentWorkspaceStoreRef\(\)\?\.activeWorkspaceId\(\)\.trim\(\) \|\| "";[\s\S]*const entry = workspaceId \? busySessionByWorkspaceId\(\)\[workspaceId\] : null;[\s\S]*return Boolean\(entry && sessionId && entry\.sessionId === sessionId\);[\s\S]*\}\);/,
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

test("latest-run artifacts resolve workspace from scoped selected session", () => {
  assert.match(
    source,
    /const latestRunArtifactScope = createMemo\(\(\) => \{[\s\S]*const scope = resolveSelectedSessionBrowseScope\(sessionId\);[\s\S]*const workspaceId = scope\?\.workspaceId\?\.trim\(\) \|\| workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*const directory = scope\?\.directory\?\.trim\(\) \|\| sessionDirectoryOverrideById\(\)\[sessionId\]\?\.trim\(\) \|\| workspaceRoot;/,
    "latest-run artifact target should be derived from the displayed scoped session",
  );
  assert.match(
    source,
    /ensureConversationReadWorkspaceRegistered\(\s*client,\s*scope\.workspaceId,\s*scope\.directory,\s*\);[\s\S]*client\.getSessionLatestRunArtifacts\(serverWorkspaceId, scope\.sessionId, scope\.directory\)/,
    "latest-run artifact refresh should resolve the server workspace for the scoped session before reading artifacts",
  );
  assert.doesNotMatch(
    source,
    /const workspaceId = vesloServerWorkspaceId\(\);[\s\S]*getSessionLatestRunArtifacts\(workspaceId, sessionId\)/,
    "latest-run artifact refresh must not use the active Veslo workspace for every selected session",
  );
});

test("create session preflight records duration for duplicate gates and fallback branches", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const chooseFolderForCurrentSession", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const createSource = source.slice(start, end);

  for (const event of [
    "createSessionAndOpen:ensure-managed-ai-bootstrap-ready",
    "createSessionAndOpen:ensure-local-runtime-reachable",
    "createSessionAndOpen:abort-refresh-settle",
    "createSessionAndOpen:veslo-conversation-create",
    "createSessionAndOpen:legacy-session-create",
    "createSessionAndOpen:select-session",
  ]) {
    assert.match(
      createSource,
      new RegExp(`sendTraceStep\\(\\s*"${event}"`),
      `${event} should be timed with sendTraceStep`,
    );
  }
});

test("create session preflight does not add a fixed abort-refresh settle delay", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const chooseFolderForCurrentSession", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const createSource = source.slice(start, end);
  const settleStart = createSource.indexOf('"createSessionAndOpen:abort-refresh-settle"');
  const settleEnd = createSource.indexOf("setError(null);", settleStart);
  assert.ok(settleStart >= 0 && settleEnd > settleStart, "abort-refresh trace block should be present");
  const settleSource = createSource.slice(settleStart, settleEnd);

  assert.match(
    settleSource,
    /abortRefreshes\(\);/,
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

test("session-store sidebar sync skips unchanged sidebar rows", () => {
  assert.match(
    sidebarWorkspaceSessionsSource,
    /const sidebarSessionItemsEqual = \(left: SidebarSessionItem\[\], right: SidebarSessionItem\[\]\) => \{[\s\S]*a\.id !== b\.id[\s\S]*a\.title !== b\.title[\s\S]*a\.directory !== b\.directory[\s\S]*a\.time\?\.updated[\s\S]*return true;[\s\S]*\};/,
    "app should compare sidebar rows before publishing session-store sync output",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /import \{ deriveSidebarRowsFromSessionStore \} from "\.\.\/lib\/sidebar-session-store-sync";[\s\S]*const incomingVisibleRows = expandSidebarSessionSliceWithAncestors\(visibleSessions, requestLimit\);[\s\S]*const existingTargetSidebarRows = untrack\(\(\) => sidebarSessionsByWorkspaceId\(\)\[wsId\] \?\? \[\]\);[\s\S]*const nextRows = deriveSidebarRowsFromSessionStore\(\{[\s\S]*incomingSessions: visibleSessions,[\s\S]*existingRows: existingTargetSidebarRows,[\s\S]*setSidebarSessionsByWorkspaceId\(\(prev\) => \{[\s\S]*const currentRows = prev\[wsId\] \?\? \[\];[\s\S]*if \(sidebarSessionItemsEqual\(currentRows, nextRows\)\) return prev;[\s\S]*\[wsId\]: nextRows,[\s\S]*\}\);/,
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
    /if \(wsDirectory && isSidebarRuntimeUnavailableError\(message\)\) \{[\s\S]*await refreshSidebarWorkspaceSessionsFromReadApi\(id, wsDirectory, "engine-runtime-unavailable"\);[\s\S]*return;/,
    "local sidebar refresh should fall back to Veslo read API when a stale engine route reports runtime unavailable",
  );
  assert.match(
    sidebarWorkspaceSessionsSource,
    /void options\.backfillConversationsToVesloReadApi\?\.\(id, queryDirectory, visibleSessions\)[\s\S]*sidebar:conversation-read:backfill-error/,
    "successful live sidebar reads should backfill Veslo conversation bindings without blocking visible UI",
  );
  assert.match(
    source,
    /const backfillConversationsToVesloReadApi = async[\s\S]*serverClient\.importConversations\(serverWorkspaceId,[\s\S]*rememberConversationScopesFromSessions\(workspaceId, directory, result\.items\);/,
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
    /const refreshMcpServers = createMcpServersRefresher\(\{[\s\S]*projectDir: \(\) => workspaceProjectDir\(\),[\s\S]*workspaceType: \(\) => workspaceStore\.activeWorkspaceDisplay\(\)\.workspaceType,[\s\S]*activeRuntimeActivityId: activeVisibleRuntimeActivityId,[\s\S]*scheduleRuntimeStatusRefresh: scheduleMcpRuntimeStatusRefresh,[\s\S]*\}\);/,
    "app should wire MCP refresh through the dedicated MCP refresh module",
  );
  assert.match(
    source,
    /await refreshMcpServers\(\{ mode: "explicit", reason: "mcp-activate-installed" \}\);[\s\S]*await refreshMcpServers\(\{ mode: "explicit", reason: "mcp-activate-installed-complete" \}\);/,
    "post-install MCP refreshes should be explicit so active conversation runs do not leave the MCP UI stale",
  );
  assert.match(
    source,
    /await refreshMcpServers\(\{ mode: "explicit", reason: "mcp-remove" \}\);/,
    "post-remove MCP refresh should be explicit so active conversation runs do not hide the mutation result",
  );
});

test("pending permission interval skips active sends and single-client mode covered by SSE", () => {
  assert.match(
    source,
    /const \[visibleRuntimeActivityHold, setVisibleRuntimeActivityHold\] = createSignal[\s\S]*const holdVisibleRuntimeActivity = \(sessionId: string \| null \| undefined, reason: string\) => \{[\s\S]*const token = `run-handoff:\$\{id\}`;[\s\S]*setVisibleRuntimeActivityHold\(\{ sessionId: id, token, expiresAt \}\);[\s\S]*const activeVisibleRuntimeActivityId = \(\) => \{[\s\S]*const sendTraceId = activeSendTraceId\(\)\?\.trim\(\);[\s\S]*if \(sendTraceId\) return sendTraceId;[\s\S]*const sessionId = selectedSessionId\(\)\?\.trim\(\);[\s\S]*const status = sessionStatusById\(\)\[sessionId\] \?\? "idle";[\s\S]*if \(status === "running" \|\| status === "retry"\) return `run:\$\{sessionId\}`;[\s\S]*const hold = visibleRuntimeActivityHold\(\);[\s\S]*if \(hold\?\.sessionId === sessionId && hold\.expiresAt > Date\.now\(\)\) return hold\.token;/,
    "app should keep runtime refresh guards active for the visible send, accepted-before-SSE handoff, and selected running session",
  );
  assert.match(
    source,
    /recordSendTrace\("sendPrompt:success"[\s\S]*holdVisibleRuntimeActivity\(sessionID, "sendPrompt:success"\);[\s\S]*return true;/,
    "successful sends should hold visible runtime activity until session status catches up",
  );
  assert.match(
    schedulerSource,
    /const activeSendTraceId = options\.activeSendTraceId\(\);[\s\S]*if \(activeSendTraceId\) \{[\s\S]*"session\.permissions", "poll-skip-active-send"/,
    "periodic permission polling should skip while a submit is actively running",
  );
  assert.match(
    schedulerSource,
    /if \(activeSendTraceId\) \{[\s\S]*return;[\s\S]*\}[\s\S]*if \(options\.engineReady\?\.\(\) === false\) \{[\s\S]*return;[\s\S]*\}[\s\S]*const routedWorkspaceCount = options\.routedWorkspaceCount\(\);[\s\S]*if \(routedWorkspaceCount <= 1\) \{[\s\S]*return;[\s\S]*\}[\s\S]*void options\.refreshPendingPermissions\(\);/,
    "permission polling should not call refreshPendingPermissions during an active send, lazy boot, or single-client mode",
  );
  assert.match(
    composerSource,
    /function setActiveSendTraceId\(sendTraceId: string \| null\)[\s\S]*__vesloActiveSendTraceId = sendTraceId;/,
    "composer should publish the active send trace id for runtime schedulers",
  );
  assert.match(
    composerSource,
    /setActiveSendTraceId\(options\.sendTraceId \?\? null\);[\s\S]*sendPromise = props\.onSend\(submittedDraft, options\);[\s\S]*finally \{[\s\S]*setActiveSendTraceId\(null\);/,
    "composer should keep the active send trace id set while onSend is pending",
  );
  assert.match(
    source,
    /createPermissionPollingScheduler\(\{[\s\S]*routedWorkspaceCount: \(\) => workspaceRouting\.entryIds\(\)\.length,[\s\S]*activeWorkspaceId: \(\) => workspaceStore\.activeWorkspaceId\(\)\.trim\(\) \|\| null,[\s\S]*activeSendTraceId: activeVisibleRuntimeActivityId,[\s\S]*engineReady: \(\) => engineReady\(\),[\s\S]*refreshPendingPermissions: \(\) => sessionStore\.refreshPendingPermissions\(\),[\s\S]*\}\);/,
    "app should wire permission polling to workspace routing, engine readiness, visible send/run activity, and session store state",
  );
  assert.match(
    source,
    /const sidebarWorkspaceSessions = createSidebarWorkspaceSessions\(\{[\s\S]*engineReady: \(\) => engineReady\(\),[\s\S]*activeSendTraceId: activeVisibleRuntimeActivityId,[\s\S]*developerMode: \(\) => developerMode\(\),/,
    "sidebar live refresh should defer for the same visible send/run activity token",
  );
  assert.match(
    source,
    /const loadSessionMcpStatuses = async[\s\S]*const activeRuntimeActivityId = activeVisibleRuntimeActivityId\(\)\?\.trim\(\);[\s\S]*"session-capabilities-skip-active-send"[\s\S]*return \{\};[\s\S]*const status = unwrap\(await runtimeClient\.mcp\.status\(\{ directory \}\)\);[\s\S]*"session-capabilities-result-skip-active-send"[\s\S]*return \{\};/,
    "session capability MCP status reads should not run or apply results during the visible send handoff",
  );
  assert.match(
    source,
    /function scheduleMcpRuntimeStatusRefresh\(projectDir: string, entries: McpServerEntry\[\]\) \{[\s\S]*const activeRuntimeActivityId = activeVisibleRuntimeActivityId\(\)\?\.trim\(\);[\s\S]*"runtime-status-skip-active-send"[\s\S]*return;[\s\S]*const status = unwrap\(await activeClient\.mcp\.status\(\{ directory \}\)\);[\s\S]*"runtime-status-result-skip-active-send"[\s\S]*return;/,
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
    /if \(!options\.isTauriRuntime\(\)\) return;[\s\S]*if \(options\.engineReady\(\) === false\) return;[\s\S]*const projectDir = options\.workspaceProjectDir\(\)\.trim\(\);[\s\S]*if \(!projectDir\) return;[\s\S]*const activeSendTraceId = options\.activeSendTraceId\?\.\(\)\?\.trim\(\) \?\? "";[\s\S]*if \(activeSendTraceId\) \{[\s\S]*scheduleDeferredRefresh\(activeSendTraceId, projectDir\);[\s\S]*return;[\s\S]*\}[\s\S]*void options\.refreshMcpServers\(\);/,
    "MCP scheduler should preserve Tauri, engine and project directory gates while deferring during active sends",
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
    /createMcpAutoRefreshScheduler\(\{[\s\S]*isTauriRuntime,[\s\S]*engineReady: \(\) => engineReady\(\),[\s\S]*activeWorkspaceId: \(\) => workspaceStore\.activeWorkspaceId\(\),[\s\S]*activeSendTraceId: activeVisibleRuntimeActivityId,[\s\S]*workspaceProjectDir: \(\) => workspaceProjectDir\(\),[\s\S]*refreshMcpServers,[\s\S]*\}\);/,
    "app should wire MCP auto refresh to runtime and visible send/run activity without duplicating scheduler logic",
  );
  assert.doesNotMatch(
    source,
    /createEffect\(\(\) => \{\s*if \(!isTauriRuntime\(\)\) return;\s*workspaceStore\.activeWorkspaceId\(\);\s*workspaceProjectDir\(\);\s*void refreshMcpServers\(\);\s*\}\);/,
    "app must not keep a raw MCP auto-refresh effect that bypasses the scheduler active-send guard",
  );
});
