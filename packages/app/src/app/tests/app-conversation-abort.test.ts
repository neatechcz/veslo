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

test("conversation runs remember the submitted run id for scoped abort", () => {
  const runStart = conversationServiceSource.indexOf("  const runConversationFromVesloWriteApi = async (");
  const abortStart = conversationServiceSource.indexOf("  const resolveConversationAbortScope = (", runStart);
  assert.notEqual(runStart, -1, "runConversationFromVesloWriteApi should exist");
  assert.notEqual(abortStart, -1, "abortConversationFromVesloWriteApi should follow runConversationFromVesloWriteApi");

  const runSource = conversationServiceSource.slice(runStart, abortStart);
  assert.match(
    runSource,
    /const latestRunId = result\.status === "submitted"[\s\S]*\? result\.runId[\s\S]*: result\.activeRunId\?\.trim\(\) \|\| result\.reservedRunId;[\s\S]*deps\.rememberLatestConversationRunId\(\{[\s\S]*workspaceId,[\s\S]*conversationId: result\.conversationId,[\s\S]*opencodeSessionId: result\.opencodeSessionId,[\s\S]*uiSessionId: normalizedSessionId,[\s\S]*runId: latestRunId,[\s\S]*\}\);/,
    "conversation runs should remember submitted run ids and queued active/reserved run ids under Veslo and UI identities",
  );
});

test("abortSession routes scoped conversations through Veslo abort and scoped legacy fallback", () => {
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
  const scopedFallbackHelper = abortSessionSource.indexOf("const abortSessionViaScopedLegacy = async");
  const scopedFallbackCall = abortSessionSource.indexOf("if (await abortSessionViaScopedLegacy())");
  const targetScopedFallbackCall = abortSessionSource.indexOf("target?.workspaceId?.trim() && await abortSessionViaScopedLegacy()");
  const fallbackWarn = abortSessionSource.indexOf('console.warn("[conversation-abort] falling back to OpenCode SDK", error);');
  const legacyAbort = abortSessionSource.indexOf("await deps.abortSessionTyped(c, id);");
  const finalThrow = abortSessionSource.indexOf("throw error;", scopedFallbackCall);
  assert.ok(serviceCall >= 0, "abortSession should attempt Veslo abort first");
  assert.ok(scopedFallbackHelper >= 0 && scopedFallbackHelper < serviceCall, "abortSession should define a scoped legacy fallback before service errors");
  assert.ok(scopedFallbackCall > serviceCall, "known scoped conversations should try scoped legacy abort before throwing service errors");
  assert.ok(targetScopedFallbackCall > serviceCall, "background workspace targets should try scoped abort before active-workspace legacy fallback");
  assert.ok(finalThrow > scopedFallbackCall, "scoped abort should throw only after scoped legacy fallback is unavailable");
  assert.ok(fallbackWarn > finalThrow, "active legacy fallback should only be reachable for unscoped migration cases");
  assert.ok(legacyAbort > fallbackWarn, "active OpenCode abort should remain only as an unscoped migration fallback");
  assert.match(
    abortSessionSource,
    /const scopedClient = deps\.routedClient\(scope\.workspaceId\);[\s\S]*await deps\.abortSessionTyped\(scopedClient, opencodeSessionId, \{[\s\S]*directory: scope\.directory\?\.trim\(\) \|\| undefined,[\s\S]*\}\);/,
    "scoped fallback should use the exact workspace entry client and directory, not the active workspace client",
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
