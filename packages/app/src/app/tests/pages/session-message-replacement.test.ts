import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("session view computes and passes editable latest-user-message state", () => {
  assert.match(
    sessionSource,
    /import \{ getEditableUserMessageDraft, type EditableUserMessageDraft \} from "\.\.\/components\/session\/message-editability";/,
    "session view should consume the transcript editability helper",
  );
  assert.match(
    sessionSource,
    /const editableUserMessage = createMemo\(\(\) =>\s*getEditableUserMessageDraft\(\{\s*messages: props\.messages,\s*sessionIdle: !showRunIndicator\(\),\s*queueEmpty: queuedDrafts\(\)\.length === 0,\s*composerEmpty: isComposerDraftEmpty\(props\.composerDraft\),\s*\}\),\s*\);/s,
    "editability should require idle session, empty queue, and empty composer",
  );
  assert.match(
    sessionSource,
    /<MessageList[\s\S]*editableUserMessage=\{editableUserMessage\(\)\}[\s\S]*onEditUserMessage=\{handleEditUserMessage\}/,
    "message list should receive the editable message and edit callback",
  );
});

test("clicking a transcript edit action loads the draft and arms replacement send", () => {
  assert.match(
    sessionSource,
    /const \[editingTranscriptMessageId, setEditingTranscriptMessageId\] = createSignal<string \| null>\(null\);/,
    "session view should track the transcript message being edited",
  );
  assert.match(
    sessionSource,
    /const handleEditUserMessage = \(editable: EditableUserMessageDraft\) => \{[\s\S]*if \(editableUserMessage\(\)\?\.messageId !== editable\.messageId\) return;[\s\S]*props\.setComposerDraft\(editable\.draft\);[\s\S]*setEditingTranscriptMessageId\(editable\.messageId\);[\s\S]*\};/,
    "edit action should load the reconstructed draft before arming replacement send",
  );
  assert.match(
    sessionSource,
    /const transcriptEditMessageId = editingTranscriptMessageId\(\);[\s\S]*if \(transcriptEditMessageId\) \{\s*const sessionKey = currentSessionQueueKey\(\);\s*setEditingTranscriptMessageId\(null\);\s*const accepted = await sendPromptImmediate\(draft, \{[\s\S]*reason: "replacement",[\s\S]*expectedSessionKey: sessionKey,[\s\S]*replaceMessageId: transcriptEditMessageId,[\s\S]*\}\);/,
    "sending while a transcript edit is armed should clear edit state before handoff and use the captured replacement id",
  );
  assert.doesNotMatch(
    sessionSource,
    /const accepted = await sendPromptImmediate\(draft, \{[\s\S]*reason: "replacement"[\s\S]*\}\);[\s\S]*setEditingTranscriptMessageId\(null\);/,
    "replacement sends should not keep edit state armed until after the handoff settles",
  );
});

test("replacement send path reverts to the original message before sending the edited draft", () => {
  assert.match(
    appSource,
    /async function sendPrompt\(\s*draft: ComposerDraft,\s*options: AppSendPromptOptions,[\s\S]*\): Promise<boolean> \{/,
    "app send API should require a typed send contract for every prompt handoff",
  );
  assert.doesNotMatch(
    appSource.slice(appSource.indexOf("async function sendPrompt("), appSource.indexOf("async function abortSession")),
    /replaceMessageId\?:/,
    "app send API should keep replacement message routing out of the normal prompt send options",
  );
  const promptAsyncCall = appSource.match(/await runConversationOrFail\(\{\s*kind: "prompt_async",[\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  assert.ok(promptAsyncCall, "conversation prompt send branch should have a clear request object");
  assert.doesNotMatch(
    promptAsyncCall,
    /\bmessageID\b/,
    "normal conversation prompt sends should keep OpenCode message id allocation unchanged",
  );
  assert.match(
    sessionSource,
    /replaceUserMessageAsync: \(\s*messageId: string,\s*draft: ComposerDraft,\s*options: SessionSendOptionsBase & \{ targetSessionId\?: string \| null \},\s*\) => Promise<boolean>;/,
    "session props should expose a replacement send API",
  );
  assert.match(
    sessionSource,
    /const accepted = await \(options\.replaceMessageId\s*\? props\.replaceUserMessageAsync\(options\.replaceMessageId, draft, replaceOptions\)\s*: props\.sendPromptAsync\(draft, promptSendOptions\)\s*\);/s,
    "sendPromptImmediate should route replacement sends through replaceUserMessageAsync",
  );
  assert.match(
    appSource,
    /async function replaceUserMessage\([\s\S]*messageID: string,[\s\S]*draft: ComposerDraft,[\s\S]*options: AppReplaceUserMessageOptions,[\s\S]*\): Promise<boolean> \{[\s\S]*ensureSelectedSessionWorkspaceActiveForSend\(sessionID, sendTraceId\)[\s\S]*const sendTargetWorkspace = resolveSendTargetWorkspaceScope\(sessionID\);[\s\S]*replacePreflight\.targetWorkspace = sendTargetWorkspace;[\s\S]*ensureLocalRuntimeReachableForSend\("replaceUserMessage", replacePreflight\)[\s\S]*const c = routedClientForSendTarget\(sendTargetWorkspace\);[\s\S]*const next = await revertSession\(c, sessionID, messageID\);[\s\S]*const accepted = await sendPrompt\(draft, \{[\s\S]*targetSessionId: sessionID,[\s\S]*clientMessageId: sendCorrelation\.clientMessageId,[\s\S]*origin: sendCorrelation\.origin,[\s\S]*\}\);/,
    "app replacement API should scope runtime/client selection before revert and reuse the same send correlation for the edited draft",
  );
  assert.match(
    appSource,
    /if \(!accepted\) \{[\s\S]*previousRevertMessageID\s*\? await revertSession\(c, sessionID, previousRevertMessageID\)\s*: await unrevertSession\(c, sessionID\)/,
    "replacement API should restore the prior revert boundary if the edited send is rejected",
  );
});
