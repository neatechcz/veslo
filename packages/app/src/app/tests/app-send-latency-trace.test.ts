import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const schedulerSource = readFileSync(new URL("../lib/workspace-runtime-schedulers.ts", import.meta.url), "utf8");
const mcpRefreshSource = readFileSync(new URL("../lib/mcp-server-refresh.ts", import.meta.url), "utf8");

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

test("send-time workspace activation preserves scoped browsed conversation state", () => {
  assert.match(
    source,
    /const selectedId = selectedSessionId\(\)\?\.trim\(\) \?\? "";\s*const selectedScope = selectedId \? resolveSelectedSessionBrowseScope\(selectedId\) : null;/,
    "workspace snapshot effect should inspect selected browse scope before switching snapshots",
  );
  assert.match(
    source,
    /const selectedBelongsToOutgoing =\s*!selectedScope \|\| selectedScope\.workspaceId\.trim\(\) === previousActiveWsId;[\s\S]*if \(selectedBelongsToOutgoing\) \{\s*sessionStore\.saveWorkspaceSnapshot\(previousActiveWsId\);/s,
    "outgoing workspace snapshot must not be overwritten by a scoped conversation from another workspace",
  );
  assert.match(
    source,
    /const selectedBelongsToIncoming = selectedScope\?\.workspaceId\.trim\(\) === wsId;[\s\S]*if \(!selectedBelongsToIncoming\) \{\s*sessionStore\.loadWorkspaceSnapshot\(wsId\);/s,
    "incoming workspace snapshot must not replace the scoped conversation during send-time activation",
  );
});

test("active conversation busy state follows scoped selected session workspace", () => {
  assert.match(
    source,
    /const activeConversationBusy = createMemo\(\(\) => \{[\s\S]*const sessionId = activeSessionId\(\);[\s\S]*const scope = sessionId \? resolveSelectedSessionBrowseScope\(sessionId\) : null;[\s\S]*const workspaceId = scope\?\.workspaceId\?\.trim\(\) \|\| workspaceStoreRef\?\.activeWorkspaceId\(\)\.trim\(\) \|\| "";[\s\S]*const entry = workspaceId \? busySessionByWorkspaceId\(\)\[workspaceId\] : null;[\s\S]*return Boolean\(entry && sessionId && entry\.sessionId === sessionId\);[\s\S]*\}\);/,
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
    /ensureConversationReadWorkspaceRegistered\(\s*client,\s*scope\.workspaceId,\s*scope\.directory,\s*\);[\s\S]*client\.getSessionLatestRunArtifacts\(serverWorkspaceId, scope\.sessionId\)/,
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
  const end = source.indexOf("const openNewSessionWithDirectory", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const createSource = source.slice(start, end);

  for (const event of [
    "createSessionAndOpen:ensure-managed-ai-bootstrap-ready",
    "createSessionAndOpen:abort-refresh-settle",
    "createSessionAndOpen:health",
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
  const end = source.indexOf("const openNewSessionWithDirectory", start);
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
    source,
    /let sidebarBulkRefreshInFlight: Promise<void> \| null = null;/,
    "sidebar bulk refresh should keep a single in-flight promise",
  );
  assert.match(
    source,
    /const existingBulkRefresh = sidebarBulkRefreshInFlight;[\s\S]*await existingBulkRefresh;[\s\S]*"refresh-all-joined"/,
    "refresh-all should join an existing bulk refresh instead of starting duplicate workspace scans",
  );
  assert.match(
    source,
    /const existingBulkRefresh = sidebarBulkRefreshInFlight;[\s\S]*await existingBulkRefresh;[\s\S]*"refresh-local-joined"/,
    "refresh-local should join an existing bulk refresh instead of duplicating refresh-all work",
  );
});

test("MCP server refresh joins duplicate refreshes for the same workspace context", () => {
  assert.match(
    mcpRefreshSource,
    /const refreshInFlightByKey = new Map<string, Promise<void>>\(\);/,
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
    /const existingRefresh = refreshInFlightByKey\.get\(refreshKey\);[\s\S]*await existingRefresh;[\s\S]*"refresh-joined"/,
    "duplicate MCP refreshes for the same key should join the existing promise",
  );
  assert.match(
    mcpRefreshSource,
    /if \(refreshInFlightByKey\.get\(refreshKey\) === run\) \{[\s\S]*refreshInFlightByKey\.delete\(refreshKey\);/,
    "MCP refresh single-flight entry should be cleared after the owning run completes",
  );
  assert.match(
    source,
    /const refreshMcpServers = createMcpServersRefresher\(\{[\s\S]*projectDir: \(\) => workspaceProjectDir\(\),[\s\S]*workspaceType: \(\) => workspaceStore\.activeWorkspaceDisplay\(\)\.workspaceType,[\s\S]*scheduleRuntimeStatusRefresh: scheduleMcpRuntimeStatusRefresh,[\s\S]*\}\);/,
    "app should wire MCP refresh through the dedicated MCP refresh module",
  );
});

test("pending permission interval skips single-client mode covered by SSE", () => {
  assert.match(
    schedulerSource,
    /const routedWorkspaceCount = options\.routedWorkspaceCount\(\);[\s\S]*if \(routedWorkspaceCount <= 1\) \{/,
    "periodic permission polling should only run when there are background workspace clients",
  );
  assert.match(
    schedulerSource,
    /"session\.permissions", "poll-skip-single-client"/,
    "single-client permission poll skips should be auditable during runtime investigations",
  );
  assert.match(
    schedulerSource,
    /if \(routedWorkspaceCount <= 1\) \{[\s\S]*return;[\s\S]*\}[\s\S]*void options\.refreshPendingPermissions\(\);/,
    "permission polling should not call refreshPendingPermissions in single-client mode",
  );
  assert.match(
    source,
    /createPermissionPollingScheduler\(\{[\s\S]*routedWorkspaceCount: \(\) => workspaceRouting\.entryIds\(\)\.length,[\s\S]*activeWorkspaceId: \(\) => workspaceStore\.activeWorkspaceId\(\)\.trim\(\) \|\| null,[\s\S]*refreshPendingPermissions: \(\) => sessionStore\.refreshPendingPermissions\(\),[\s\S]*\}\);/,
    "app should wire permission polling to workspace routing and session store state",
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
    /if \(!options\.isTauriRuntime\(\)\) return;[\s\S]*options\.engineReady\(\);[\s\S]*const projectDir = options\.workspaceProjectDir\(\)\.trim\(\);[\s\S]*if \(!projectDir\) return;[\s\S]*void options\.refreshMcpServers\(\);/,
    "MCP scheduler should preserve the previous Tauri, engine and project directory gates",
  );
  assert.match(
    source,
    /createMcpAutoRefreshScheduler\(\{[\s\S]*isTauriRuntime,[\s\S]*engineReady: \(\) => engineReady\(\),[\s\S]*workspaceProjectDir: \(\) => workspaceProjectDir\(\),[\s\S]*refreshMcpServers,[\s\S]*\}\);/,
    "app should wire MCP auto refresh to existing runtime signals without duplicating scheduler logic",
  );
});
