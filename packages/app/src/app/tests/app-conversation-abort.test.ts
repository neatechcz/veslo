import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(
  new URL("../pages/session-send-workflow.ts", import.meta.url),
  "utf8",
);
const conversationServiceSource = readFileSync(
  new URL("../context/conversation-service.ts", import.meta.url),
  "utf8",
);

test("conversation runs remember abort and lifecycle run ids under scoped identities", () => {
  const runStart = conversationServiceSource.indexOf("  const submitConversationRunViaVesloWriteApi = async (");
  const abortStart = conversationServiceSource.indexOf("  const resolveConversationAbortScope = (", runStart);
  assert.notEqual(runStart, -1, "submitConversationRunViaVesloWriteApi should exist");
  assert.notEqual(abortStart, -1, "abortConversationFromVesloWriteApi should follow submitConversationRunViaVesloWriteApi");

  const runSource = conversationServiceSource.slice(runStart, abortStart);
  assert.match(
    runSource,
    /const (abortRunId|latestRunId) = result\.status === "submitted"[\s\S]*\? result\.runId[\s\S]*: result\.activeRunId\?\.trim\(\) \|\| result\.reservedRunId;[\s\S]*deps\.rememberLatestConversationRunId\(\{[\s\S]*workspaceId,[\s\S]*conversationId: result\.conversationId,[\s\S]*opencodeSessionId: result\.opencodeSessionId,[\s\S]*uiSessionId: normalizedSessionId,[\s\S]*runId: \1,[\s\S]*\}\);/,
    "conversation abort should keep the active queued run id available for stop requests",
  );
  assert.match(
    runSource,
    /const lifecycleRunId = result\.status === "submitted"[\s\S]*\? result\.runId[\s\S]*: result\.reservedRunId;[\s\S]*deps\.rememberLatestConversationLifecycleRunId\(\{[\s\S]*workspaceId,[\s\S]*conversationId: result\.conversationId,[\s\S]*opencodeSessionId: result\.opencodeSessionId,[\s\S]*uiSessionId: normalizedSessionId,[\s\S]*runId: lifecycleRunId,[\s\S]*\}\);/,
    "queued lifecycle recovery should watch the reserved queued run id, not the currently active blocking run",
  );
});

test("abortSession routes scoped conversations through Veslo abort without legacy SDK fallback", () => {
  const abortWrapperStart = conversationServiceSource.indexOf("  const abortConversationFromVesloWriteApi = async (");
  const serviceReturnStart = conversationServiceSource.indexOf("  return {", abortWrapperStart);
  assert.notEqual(abortWrapperStart, -1, "abortConversationFromVesloWriteApi should exist");
  assert.notEqual(serviceReturnStart, -1, "abortConversationFromVesloWriteApi should end before service return");
  const abortWrapperSource = conversationServiceSource.slice(abortWrapperStart, serviceReturnStart);
  assert.match(
    abortWrapperSource,
    /const runId = deps\.resolveLatestConversationRunId\(\{[\s\S]*conversationId,[\s\S]*opencodeSessionId: scope\.opencodeSessionId,[\s\S]*uiSessionId: normalizedSessionId,[\s\S]*\}\);/,
    "conversation abort should still prefer an explicit run id from the scoped run map",
  );
  assert.match(
    abortWrapperSource,
    /\.\.\.\(runId \? \{ runId \} : \{ mode: "active" as const \}\)/,
    "conversation abort should fall back to server-resolved active abort when the local run id is missing",
  );

  const abortSessionStart = sendWorkflowSource.indexOf("async function abortSession(");
  const retryStart = sendWorkflowSource.indexOf("return {", abortSessionStart);
  assert.notEqual(abortSessionStart, -1, "abortSession should exist");
  assert.notEqual(retryStart, -1, "abortSession should end before the workflow return");
  const abortSessionSource = sendWorkflowSource.slice(abortSessionStart, retryStart);
  const serviceCall = abortSessionSource.indexOf("deps.abortConversationFromVesloWriteApi(id, target)");
  assert.ok(serviceCall >= 0, "abortSession should attempt Veslo abort first");
  assert.match(
    abortSessionSource,
    /abortSession:conversation-abort-blocked-unavailable/,
    "server abort unavailability should become an explicit blocked state",
  );
  assert.doesNotMatch(
    abortSessionSource,
    /abortSessionViaScopedLegacy|scoped-legacy-fallback|legacy-fallback|OpenCode SDK|abortSessionTyped|routedClient\(/,
    "abortSession should not bypass server-owned abort through scoped or active legacy SDK clients",
  );
});

test("reload guards include background workspace busy runs", () => {
  assert.match(
    source,
    /createSystemState\(\{[\s\S]*sessions,[\s\S]*sessionStatusById,[\s\S]*workspaceBusy: workspaceStore\.workspaceBusy,[\s\S]*refreshPlugins,/,
    "system state should receive the multi-workspace busy map, not only visible session statuses",
  );
  assert.match(
    source,
    /const activeReloadBlockingSessions = createMemo<ActiveReloadBlockingSession\[\]>\(\(\) => \{[\s\S]*for \(const \[workspaceId, busySessions\] of Object\.entries\(workspaceStore\.workspaceBusy\(\)\)\) \{[\s\S]*for \(const idRaw of Object\.keys\(busySessions\)\) \{[\s\S]*findSidebarSessionForWorkspace\(workspaceId, id\)[\s\S]*conversationId: sidebarSession\?\.conversationId \?\? null,[\s\S]*opencodeSessionId: sidebarSession\?\.opencodeSessionId \?\? id,[\s\S]*\}/,
    "MCP reload blocking should include background busy workspaces and carry conversation metadata",
  );
  assert.match(
    source,
    /const forceStopActiveSessionsAndReload = async \(\) => \{[\s\S]*for \(const session of activeSessions\) \{[\s\S]*await abortSession\(session\.id, session\);/,
    "force-stop reload should pass the scoped session metadata into abortSession",
  );
  assert.match(
    source,
    /const waitForActiveReloadBlockingSessionsToClear = async \(\) => \{[\s\S]*activeReloadBlockingSessions\(\)\.length > 0[\s\S]*return false;[\s\S]*return true;[\s\S]*\};/,
    "force-stop reload should wait for reload-blocking sessions to clear from the active status source",
  );
  assert.match(
    source,
    /const stopFailures: string\[\] = \[\];[\s\S]*catch \(error\) \{[\s\S]*stopFailures\.push[\s\S]*if \(stopFailures\.length > 0\) \{[\s\S]*setError\(/,
    "force-stop reload should surface abort failures instead of silently reloading",
  );
  assert.match(
    source,
    /const cleared = await waitForActiveReloadBlockingSessionsToClear\(\);[\s\S]*if \(!cleared\) \{[\s\S]*setError\("Could not stop active run before reload\."\);[\s\S]*return;[\s\S]*\}[\s\S]*await reloadWorkspaceEngine\(\);/,
    "force-stop reload should only reload after the blocking state clears",
  );
  assert.match(
    source,
    /onForceStopSession=\{\(sessionID, session\) => abortSession\(sessionID, session\)\}/,
    "MCP auth modal force-stop should preserve the scoped background session metadata",
  );
});

test("session lifecycle recovery resolves lifecycle run ids before abort run ids", () => {
  const resolveRunStart = conversationServiceSource.indexOf("  const resolveConversationRunForSession = (");
  const readRunStatusStart = conversationServiceSource.indexOf(
    "  const readConversationRunStatus = async (",
    resolveRunStart,
  );
  assert.notEqual(resolveRunStart, -1, "resolveConversationRunForSession should exist");
  assert.notEqual(readRunStatusStart, -1, "readConversationRunStatus should follow resolveConversationRunForSession");

  const resolveRunSource = conversationServiceSource.slice(resolveRunStart, readRunStatusStart);
  assert.match(
    resolveRunSource,
    /const runId = deps\.resolveLatestConversationLifecycleRunId\(\{[\s\S]*workspaceId,[\s\S]*conversationId,[\s\S]*opencodeSessionId,[\s\S]*uiSessionId: normalizedSessionId,[\s\S]*\}\) \|\| deps\.resolveLatestConversationRunId\(\{[\s\S]*workspaceId,[\s\S]*conversationId,[\s\S]*opencodeSessionId,[\s\S]*uiSessionId: normalizedSessionId,[\s\S]*\}\);/,
    "lifecycle recovery should prefer the queued reserved run id and fall back to the abort run id",
  );
});
