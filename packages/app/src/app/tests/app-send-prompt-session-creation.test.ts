import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("sendPrompt keeps the session id returned by createSessionAndOpen before prompting", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const sendPromptSource = source.slice(start, end);

  const initialTitleIndex = sendPromptSource.indexOf("const initialSessionTitle = resolvedDraft.text.trim();");
  const createNeededIndex = sendPromptSource.indexOf('recordSendTrace("sendPrompt:create-session-needed"');
  const createCallIndex = sendPromptSource.indexOf("createSessionAndOpen(initialSessionTitle", createNeededIndex);
  const createdSessionIdIndex = sendPromptSource.indexOf("const createdSessionId = await sendTraceStep(", createNeededIndex);
  const materializedSessionIdIndex = sendPromptSource.indexOf("const materializedSessionId = createdSessionId?.trim();", createNeededIndex);
  const assignmentIndex = sendPromptSource.indexOf("sessionID = materializedSessionId;", createNeededIndex);
  const blockedIndex = sendPromptSource.indexOf('recordSendTrace("sendPrompt:blocked-no-session"', createNeededIndex);

  assert.ok(initialTitleIndex >= 0, "sendPrompt should derive the initial session title before creating");
  assert.ok(createNeededIndex > initialTitleIndex, "sendPrompt should decide session creation after initial content checks");
  assert.ok(createdSessionIdIndex > createNeededIndex, "sendPrompt should capture the create-session result");
  assert.ok(createCallIndex > createdSessionIdIndex, "sendPrompt should call createSessionAndOpen inside the traced creation step");
  assert.ok(materializedSessionIdIndex > createCallIndex, "sendPrompt should normalize the created session id before prompting");
  assert.ok(assignmentIndex > materializedSessionIdIndex, "sendPrompt should assign the create-session result back to sessionID");
  assert.ok(blockedIndex > createCallIndex, "sendPrompt should only check for missing session after createSessionAndOpen returns");
  assert.match(
    sendPromptSource.slice(createdSessionIdIndex, blockedIndex),
    /preflight: sendPreflight,/,
    "sendPrompt should pass the preflight context when creating the first session",
  );
});

test("sendPrompt skips first-session creation when a browsed session is the explicit target", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const sendPromptSource = source.slice(start, end);

  const explicitTargetIndex = sendPromptSource.indexOf("const explicitTargetSessionId = isPendingSessionInstanceId(options.targetSessionId)");
  const sessionAssignmentIndex = sendPromptSource.indexOf("let sessionID = explicitTargetSessionId || selectedRealSessionId;", explicitTargetIndex);
  const scopedActivationIndex = sendPromptSource.indexOf('"sendPrompt:ensure-scoped-workspace-active"', sessionAssignmentIndex);
  const createGuardIndex = sendPromptSource.indexOf("if (!sessionID) {", scopedActivationIndex);
  const createNeededIndex = sendPromptSource.indexOf('recordSendTrace("sendPrompt:create-session-needed"', createGuardIndex);
  const conversationRunIndex = sendPromptSource.indexOf("runConversationFromVesloWriteApi(sessionID", createGuardIndex);

  assert.ok(explicitTargetIndex >= 0, "sendPrompt should normalize an explicit target session id");
  assert.ok(sessionAssignmentIndex > explicitTargetIndex, "explicit target should become the send session id before create checks");
  assert.ok(scopedActivationIndex > sessionAssignmentIndex, "explicit target should activate its scoped workspace before sending");
  assert.ok(createGuardIndex > scopedActivationIndex, "first-session creation should be guarded by the resolved session id");
  assert.ok(createNeededIndex > createGuardIndex, "new-session creation should stay inside the missing-session branch");
  assert.ok(conversationRunIndex > createGuardIndex, "prompt sends should still route existing sessions through the conversation run API");
});

test("createSessionAndOpen persists the first composer text as the initial backend title", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const chooseFolderForCurrentSession = async () =>");
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");

  const createSessionAndOpenSource = source.slice(start, end);
  assert.match(
    createSessionAndOpenSource,
    /const initialSessionTitle = initialTitle\.trim\(\);/,
    "createSessionAndOpen should trim the prompt before using it as the local temporary title",
  );
  const createCallStart = createSessionAndOpenSource.indexOf("createConversationFromVesloWriteApi(");
  const createCallEnd = createSessionAndOpenSource.indexOf("});", createCallStart);
  assert.ok(createCallStart >= 0 && createCallEnd > createCallStart, "conversation service create call should be present");
  const createCallSource = createSessionAndOpenSource.slice(createCallStart, createCallEnd);
  assert.match(
    createCallSource,
    /initialSessionTitle \|\| undefined,/,
    "createSessionAndOpen should persist the first composer text as the backend session title until an explicit rename/title update happens",
  );
  assert.match(
    createSessionAndOpenSource,
    /c\.session\.create\(\{[\s\S]*title: initialSessionTitle \|\| undefined,/,
    "legacy session.create fallback should keep the same initial title contract",
  );
  assert.match(
    createSessionAndOpenSource,
    /registerPendingInitialSessionTitle\(session\.id, initialSessionTitle\);[\s\S]*const displaySession = applyPendingInitialSessionTitle\(session\);/,
    "createSessionAndOpen should register the prompt title locally and render it optimistically",
  );
});
