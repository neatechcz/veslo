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
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  return sendWorkflowSource.slice(start, end);
}

function createSessionAndOpenSource(): string {
  const start = createWorkflowSource.indexOf("const createSessionAndOpen = async (");
  const end = createWorkflowSource.indexOf("return {", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  return createWorkflowSource.slice(start, end);
}

test("sendPrompt keeps the session id returned by createSessionAndOpen before prompting", () => {
  const source = sendPromptSource();

  const initialTitleIndex = source.indexOf("const initialSessionTitle = resolvedDraft.text.trim();");
  const createNeededIndex = source.indexOf('recordSendTrace("sendPrompt:create-session-needed"');
  const createCallIndex = source.indexOf("deps.createSessionAndOpen(initialSessionTitle", createNeededIndex);
  const createdSessionIdIndex = source.indexOf("const createdSessionId = await deps.sendTraceStep(", createNeededIndex);
  const materializedSessionIdIndex = source.indexOf("const materializedSessionId = createdSessionId?.trim();", createNeededIndex);
  const assignmentIndex = source.indexOf("sessionID = materializedSessionId;", createNeededIndex);
  const blockedIndex = source.indexOf('recordSendTrace("sendPrompt:blocked-no-session"', createNeededIndex);

  assert.ok(initialTitleIndex >= 0, "sendPrompt should derive the initial session title before creating");
  assert.ok(createNeededIndex > initialTitleIndex, "sendPrompt should decide session creation after initial content checks");
  assert.ok(createdSessionIdIndex > createNeededIndex, "sendPrompt should capture the create-session result");
  assert.ok(createCallIndex > createdSessionIdIndex, "sendPrompt should call createSessionAndOpen inside the traced creation step");
  assert.ok(materializedSessionIdIndex > createCallIndex, "sendPrompt should normalize the created session id before prompting");
  assert.ok(assignmentIndex > materializedSessionIdIndex, "sendPrompt should assign the create-session result back to sessionID");
  assert.ok(blockedIndex > createCallIndex, "sendPrompt should only check for missing session after createSessionAndOpen returns");
  assert.match(
    source.slice(createdSessionIdIndex, blockedIndex),
    /preflight: sendPreflight,/,
    "sendPrompt should pass the preflight context when creating the first session",
  );
});

test("sendPrompt skips first-session creation when a browsed session is the explicit target", () => {
  const source = sendPromptSource();

  const explicitTargetIndex = source.indexOf("const explicitTargetSessionId = deps.isPendingSessionInstanceId(options.targetSessionId)");
  const sessionAssignmentIndex = source.indexOf("let sessionID = explicitTargetSessionId || selectedRealSessionId;", explicitTargetIndex);
  const scopedActivationIndex = source.indexOf('"sendPrompt:ensure-scoped-workspace-active"', sessionAssignmentIndex);
  const createGuardIndex = source.indexOf("if (!sessionID) {", scopedActivationIndex);
  const createNeededIndex = source.indexOf('recordSendTrace("sendPrompt:create-session-needed"', createGuardIndex);
  const conversationRunIndex = source.indexOf(
    "deps.runConversationFromVesloWriteApi(materializedSessionID",
    createGuardIndex,
  );

  assert.ok(explicitTargetIndex >= 0, "sendPrompt should normalize an explicit target session id");
  assert.ok(sessionAssignmentIndex > explicitTargetIndex, "explicit target should become the send session id before create checks");
  assert.ok(scopedActivationIndex > sessionAssignmentIndex, "explicit target should activate its scoped workspace before sending");
  assert.ok(createGuardIndex > scopedActivationIndex, "first-session creation should be guarded by the resolved session id");
  assert.ok(createNeededIndex > createGuardIndex, "new-session creation should stay inside the missing-session branch");
  assert.ok(conversationRunIndex > createGuardIndex, "prompt sends should route the materialized session through the conversation run API");
});

test("createSessionAndOpen persists the first composer text as the initial backend title", () => {
  const source = createSessionAndOpenSource();
  assert.match(
    source,
    /const initialSessionTitle = initialTitle\.trim\(\);/,
    "createSessionAndOpen should trim the prompt before using it as the local temporary title",
  );
  const createCallStart = source.indexOf("deps.createConversationFromVesloWriteApi(");
  const createCallEnd = source.indexOf(");", createCallStart);
  assert.ok(createCallStart >= 0 && createCallEnd > createCallStart, "conversation service create call should be present");
  const createCallSource = source.slice(createCallStart, createCallEnd);
  assert.match(
    createCallSource,
    /initialSessionTitle \|\| undefined,/,
    "createSessionAndOpen should persist the first composer text as the backend session title until an explicit rename/title update happens",
  );
  assert.doesNotMatch(
    source,
    /c\.session\.create\(/,
    "createSessionAndOpen should not keep a legacy session.create fallback after Veslo conversation creation owns new sessions",
  );
  assert.match(
    source,
    /deps\.registerPendingInitialSessionTitle\(createdSession\.id, initialSessionTitle\);[\s\S]*const displaySession = deps\.applyPendingInitialSessionTitle\(createdSession\);/,
    "createSessionAndOpen should register the prompt title locally and render it optimistically",
  );
});
