import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sendWorkflowSource = readFileSync(new URL("../pages/session-send-workflow.ts", import.meta.url), "utf8");
const createWorkflowSource = readFileSync(new URL("../pages/session-creation-workflow.ts", import.meta.url), "utf8");

function sendPromptSource(): string {
  const start = sendWorkflowSource.indexOf("async function sendPrompt(");
  const end = sendWorkflowSource.indexOf("async function abortSession", start);
  assert.notEqual(start, -1, "sendPrompt should exist");
  assert.notEqual(end, -1, "sendPrompt block should end before abortSession");
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
    /const pendingDraftMeta = deps\.activePendingDraftMeta\(\);[\s\S]*meta: pendingDraftMeta,[\s\S]*draftId:\s*pendingDraftMeta\?\.id\?\.trim\(\) \|\| GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,/s,
    "first-send cleanup should use the selected pending metadata and still delete the global draft record if metadata is unavailable",
  );
});

test("first submitted runs are admitted before selection and are not admitted twice after it", () => {
  const source = sendPromptSource();
  const createSessionSource = createSessionAndOpenSource();

  assert.match(
    source,
    /const serverFirstSubmittedRunAdmissions = new Set<true>\(\);[\s\S]*onSubmittedRunMaterialized: \(materialized\) => \{[\s\S]*deps\.admitAcceptedConversationRun\(\{[\s\S]*\}\);[\s\S]*if \(admitted !== true\) return false;[\s\S]*deps\.emitLiveTranscriptPolicyEvent\(\{[\s\S]*serverFirstSubmittedRunAdmissions\.add\(true\);[\s\S]*return true;/s,
    "a validated first submitted run should claim lifecycle and live-read ownership while creation is still materializing",
  );
  assert.match(
    source,
    /if \(!serverFirstSubmittedRunAdmissions\.has\(true\)\) \{[\s\S]*if \(serverFirstSubmitResult\.status === "submitted"\) \{[\s\S]*deps\.admitAcceptedConversationRun\(/s,
    "the post-creation admission must remain only as a fallback when the early claim did not succeed",
  );
  assert.match(
    createSessionSource,
    /deps\.applyCreatedSessionState\(creationResult, options\);[\s\S]*if \(materializedSubmittedRun\) \{[\s\S]*creationResult\.transition\.skipTranscriptRead =[\s\S]*options\.onSubmittedRunMaterialized\?\.\([\s\S]*\) === true;[\s\S]*await deps\.sendTraceStep\([\s\S]*"createSessionAndOpen:select-session"/s,
    "creation should defer the first transcript read only after state materialization and a successful early lifecycle claim",
  );
});

test("failed first server submit leaves the pending draft unconsumed", () => {
  const source = sendPromptSource();
  const failedResultBranch = source.indexOf('serverFirstSubmitResult.status === "failed" ||');
  const failedResultReturn = source.indexOf("return sessionSubmitResultFromConversationSubmit(", failedResultBranch);
  const consumePendingDraft = source.indexOf("await consumePendingDraftAfterAcceptedSend(true);", failedResultBranch);

  assert.ok(failedResultBranch >= 0, "first server submit failure branch should exist");
  assert.ok(failedResultReturn > failedResultBranch, "failure should return a typed submit result");
  assert.ok(consumePendingDraft > failedResultReturn, "pending draft cleanup must happen only after an accepted first server submit");
});

test("pending draft cleanup failures are handled separately from prompt handoff success", () => {
  assert.match(
    sendPromptSource(),
    /if \(pendingDraftId && deps\.isTauriRuntime\(\)\) \{\s*try \{[\s\S]*const deleted =\s*await deps\.pendingSessionDraftsDelete\(pendingDraftId\);[\s\S]*if \(!deleted\) \{[\s\S]*deps\.markPendingDraftConsumed\(pendingDraftId\);[\s\S]*console\.warn\([\s\S]*\} else \{[\s\S]*deps\.clearConsumedPendingDraftId\(pendingDraftId\);[\s\S]*\}[\s\S]*\} catch \(error\) \{[\s\S]*deps\.markPendingDraftConsumed\(pendingDraftId\);[\s\S]*deps\.reportError\(error, "pendingDrafts\.consume"\);[\s\S]*\}\s*\}/s,
    "pending-draft cleanup should report delete errors without converting a successful prompt handoff into a send failure",
  );
});

test("first pending draft send materializes workspace and session without global app blocking", () => {
  const source = sendPromptSource();

  assert.match(
    source,
    /const sendPromptBusyOwnership = deps\.resolveSendPromptBusyOwnership\(\s*\{\s*sessionId: sessionID,?\s*\},?\s*\);[\s\S]*const blockAppDuringPromptSend = sendPromptBusyOwnership\.ownsBusy;/,
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
