import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sendWorkflowSource = readFileSync(
  new URL("../pages/session-send-workflow.ts", import.meta.url),
  "utf8",
);
const createWorkflowSource = readFileSync(
  new URL("../pages/session-creation-workflow.ts", import.meta.url),
  "utf8",
);

function sendPromptSource(): string {
  const start = sendWorkflowSource.indexOf("async function sendPrompt(");
  const end = sendWorkflowSource.indexOf("async function abortSession", start);
  assert.notEqual(start, -1, "sendPrompt should exist");
  assert.notEqual(end, -1, "sendPrompt block should end before abortSession");
  return sendWorkflowSource.slice(start, end);
}

function legacyConversationRunFallbackSource(): string {
  const start = sendWorkflowSource.indexOf("export function createLegacyConversationRunFallback(");
  const end = sendWorkflowSource.indexOf("export function createSessionSendWorkflow", start);
  assert.notEqual(start, -1, "legacy conversation run fallback should exist");
  assert.notEqual(end, -1, "legacy conversation run fallback block should end before createSessionSendWorkflow");
  return sendWorkflowSource.slice(start, end);
}

function createSessionAndOpenSource(): string {
  const start = createWorkflowSource.indexOf("const runCreateSessionFlow = async (");
  const end = createWorkflowSource.indexOf("\n  const createSession = (", start);
  assert.notEqual(start, -1, "runCreateSessionFlow should exist");
  assert.notEqual(end, -1, "runCreateSessionFlow block should end before createSession wrapper");
  return createWorkflowSource.slice(start, end);
}

test("pending draft sends snapshot selected target metadata and fall back to the global draft id", () => {
  const source = sendPromptSource();
  const pendingSnapshot = source.indexOf("const pendingDraftSendState = (() => {");
  const pendingSnapshotEnd = source.indexOf("    })();", pendingSnapshot);
  assert.notEqual(pendingSnapshot, -1, "sendPrompt should snapshot pending draft state");
  assert.notEqual(pendingSnapshotEnd, -1, "pending draft snapshot should be bounded");
  const pendingSnapshotSource = source.slice(pendingSnapshot, pendingSnapshotEnd);

  assert.match(
    pendingSnapshotSource,
    /const pendingDraftMeta = deps\.activePendingDraftMeta\(\);[\s\S]*meta: pendingDraftMeta,[\s\S]*draftId: pendingDraftMeta\?\.id\?\.trim\(\) \|\| GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,/s,
    "first-send cleanup should use the selected pending metadata and still delete the global draft record if metadata is unavailable",
  );
});

test("successful pending draft sends consume the pending draft only after the prompt handoff succeeds", () => {
  const source = sendPromptSource();
  const fallbackSource = legacyConversationRunFallbackSource();
  assert.match(
    source,
    /const consumePendingDraftAfterAcceptedSend = async \(clearDisplayedPendingDraftState: boolean\) => \{[\s\S]*const pendingDraftStorageKey = pendingDraftSendState\.key;[\s\S]*const pendingDraftId = pendingDraftSendState\.draftId;[\s\S]*if \(pendingDraftId && deps\.isTauriRuntime\(\)\) \{[\s\S]*await deps\.pendingSessionDraftsDelete\(pendingDraftId\);[\s\S]*\}[\s\S]*deps\.setComposerDraftBySessionId\(\(current\) => deleteSessionComposerDraft\(current, \{[\s\S]*storageKey: pendingDraftStorageKey,[\s\S]*\}\)\);[\s\S]*\};/s,
    "pending drafts should be deleted and cleared through the accepted-send cleanup helper",
  );
  assert.match(
    fallbackSource,
    /await runConversationOrFail\(\s*\{[\s\S]*kind: "prompt_async",[\s\S]*\}\);\s*\}\s*await input\.consumePendingDraftAfterAcceptedSend\(input\.sendTargetStillDisplayed\(\)\);[\s\S]*deps\.finishPerf\(perfEnabled, "session\.prompt", "done", startedAt, \{[\s\S]*\}\);\s*deps\.recordSendTrace\("sendPrompt:success"[\s\S]*return true;/s,
    "legacy fallback should consume pending drafts only after the prompt handoff succeeds",
  );
  assert.match(
    source,
    /deps\.emitLiveTranscriptPolicyEvent\(\{[\s\S]*reason: "sendPrompt:success",[\s\S]*\}\);\s*await consumePendingDraftAfterAcceptedSend\(true\);[\s\S]*return true;/s,
    "first-session server submit success should consume pending drafts after the typed success result",
  );
});

test("failed sends do not consume pending draft state", () => {
  const source = legacyConversationRunFallbackSource();
  const catchStart = source.indexOf("    } catch (e) {");
  const catchEnd = source.indexOf("    } finally {", catchStart);
  assert.notEqual(catchStart, -1, "send failure path should exist");
  assert.notEqual(catchEnd, -1, "send failure path should end before finally");
  const catchWindow = source.slice(catchStart, catchEnd);

  assert.doesNotMatch(
    catchWindow,
    /pendingSessionDraftsDelete\(|clearActivePendingDraftState\(|deleteSessionComposerDraft\(/,
    "failed sends must leave the pending draft intact",
  );
});

test("failed pending draft sends restore the pending draft route instead of leaving the empty real session selected", () => {
  assert.match(
    sendPromptSource(),
    /if \(pendingDraftSendState\) \{\s*deps\.setActivePendingDraftKey\(pendingDraftSendState\.key\);\s*deps\.setActivePendingDraftMeta\(pendingDraftSendState\.meta\);\s*deps\.setView\("session"\);\s*\}/s,
    "pending-draft send failures should return the UI to the pending draft route",
  );
});

test("pending draft cleanup failures are handled separately from prompt handoff success", () => {
  assert.match(
    sendPromptSource(),
    /if \(pendingDraftId && deps\.isTauriRuntime\(\)\) \{\s*try \{[\s\S]*const deleted = await deps\.pendingSessionDraftsDelete\(pendingDraftId\);[\s\S]*if \(!deleted\) \{[\s\S]*deps\.markPendingDraftConsumed\(pendingDraftId\);[\s\S]*console\.warn\([\s\S]*\} else \{[\s\S]*deps\.clearConsumedPendingDraftId\(pendingDraftId\);[\s\S]*\}[\s\S]*\} catch \(error\) \{[\s\S]*deps\.markPendingDraftConsumed\(pendingDraftId\);[\s\S]*deps\.reportError\(error, "pendingDrafts\.consume"\);[\s\S]*\}\s*\}/s,
    "pending-draft cleanup should report delete errors without converting a successful prompt handoff into a send failure",
  );
});

test("slash command sends preassign the message id used for optimistic display", () => {
  const source = legacyConversationRunFallbackSource();
  const commandBranchStart = source.indexOf("        commandMessageIDToClear = input.sendCorrelation.clientMessageId;");
  const commandBranchEnd = source.indexOf("        commandMessageIDToClear = null;", commandBranchStart);
  assert.notEqual(commandBranchStart, -1, "legacy fallback should have a slash command branch");
  assert.notEqual(commandBranchEnd, -1, "slash command branch should end before promptAsync branch");

  const commandBranch = source.slice(commandBranchStart, commandBranchEnd);
  assert.match(commandBranch, /commandMessageIDToClear = input\.sendCorrelation\.clientMessageId;/);
  assert.match(
    commandBranch,
    /deps\.sessionStoreSetCommandDisplay\(commandMessageID,\s*command\.name,\s*command\.arguments\);/,
  );
  assert.match(commandBranch, /messageID:\s*commandMessageID/);
});

test("failed slash command sends clear the preassigned command display alias", () => {
  const source = legacyConversationRunFallbackSource();
  const catchStart = source.indexOf("    } catch (e) {");
  const catchEnd = source.indexOf("    } finally {", catchStart);
  assert.notEqual(catchStart, -1, "send failure path should exist");
  assert.notEqual(catchEnd, -1, "send failure path should end before finally");
  const catchWindow = source.slice(catchStart, catchEnd);

  assert.match(
    catchWindow,
    /deps\.sessionStoreClearCommandDisplay\(/,
    "failed slash-command sends should clear optimistic command display aliases",
  );
});

test("first pending draft send materializes workspace and session without global app blocking", () => {
  const source = sendPromptSource();

  assert.match(
    source,
    /const sendPromptBusyOwnership = deps\.resolveSendPromptBusyOwnership\(\{ sessionId: sessionID \}\);[\s\S]*const blockAppDuringPromptSend = sendPromptBusyOwnership\.ownsBusy;/,
    "a brand-new pending draft send should be identifiable so workspace/session materialization can stay scoped to the session view",
  );
  assert.match(
    source,
    /const createdSessionId = await deps\.sendTraceStep\(\s*"sendPrompt:create-session-and-open"[\s\S]*?deps\.createSessionAndOpen\(initialSessionTitle, \{[\s\S]*?blockAppDuringCreate: blockAppDuringPromptSend,[\s\S]*?pendingSession: pendingSidebarSession,[\s\S]*?clientMessageId: sendCorrelation\.clientMessageId,[\s\S]*?onMaterializedSessionId: options\.onMaterializedSessionId,[\s\S]*?preflight: sendPreflight,[\s\S]*?\}\)[\s\S]*?\);[\s\S]*const materializedSessionId = createdSessionId\?\.trim\(\);[\s\S]*if \(materializedSessionId\) \{[\s\S]*sessionID = materializedSessionId;/s,
    "first prompt session creation should opt out of global app blocking and pass scoped handoff metadata while existing-session sends keep the old guarded behavior",
  );

  const createSessionSource = createSessionAndOpenSource();

  assert.match(
    createSessionSource,
    /options: SessionCreationWorkflowCreateOptions = \{\}/,
    "session creation should expose a scoped option for pending first sends",
  );
  assert.match(
    createSessionSource,
    /const blockAppDuringCreate = options\.blockAppDuringCreate \?\? true;/,
    "manual session creation should keep the existing global guard by default",
  );
  assert.match(
    createSessionSource,
    /if \(blockAppDuringCreate\) \{\s*deps\.emitFlowProgress\(\{ type: "session\.creating", owner: "create" \}\);[\s\S]*\}/s,
    "global busy and navigation lock should only be requested through flow progress when the caller requests app-level blocking",
  );
  assert.match(
    createSessionSource,
    /transition:\s*\{[\s\S]*shouldRouteAfterSelect: shouldRouteCreatedSessionAfterSelect\(\{[\s\S]*blockAppDuringCreate,[\s\S]*currentView: deps\.currentView\(\),[\s\S]*\}\),[\s\S]*sessionId: createdSession\.id,[\s\S]*\}/s,
    "non-blocking first-send materialization should compute a transition recommendation instead of navigating inline",
  );
  assert.match(
    createSessionSource,
    /if \(applyEffects\) \{[\s\S]*deps\.applyCreatedSessionState\(creationResult, options\);[\s\S]*deps\.sendTraceStep\(\s*"createSessionAndOpen:select-session"[\s\S]*deps\.applyCreatedSessionTransition\(creationResult\)/s,
    "session creation should apply state and transition through adapters after the typed creation result exists",
  );
  assert.doesNotMatch(
    createSessionSource,
    /deps\.(goToSession|selectSession|materializePendingSessionInWorkspaceSidebar|setSessions)\b/,
    "session creation workflow should not own route navigation or sidebar/session-list mutations directly",
  );
});
