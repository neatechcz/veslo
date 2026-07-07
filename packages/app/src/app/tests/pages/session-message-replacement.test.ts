import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const conversationFlowSource = readFileSync(
  new URL("../../pages/session-conversation-flow.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(new URL("../../pages/session-send-workflow.ts", import.meta.url), "utf8");
const mutationWorkflowSource = readFileSync(new URL("../../pages/session-mutation-workflow.ts", import.meta.url), "utf8");
const flowSendImmediateStart = conversationFlowSource.indexOf("sendPromptImmediate: async (");
const flowSendImmediateEnd = conversationFlowSource.indexOf("export type RunBaseline", flowSendImmediateStart);
const flowSendImmediateSource = conversationFlowSource.slice(flowSendImmediateStart, flowSendImmediateEnd);
const flowHandleSendStart = conversationFlowSource.indexOf("handleSendPrompt: async (");
const flowHandleSendEnd = conversationFlowSource.indexOf("drainNextQueuedDraft: async (", flowHandleSendStart);
const flowHandleSendSource = conversationFlowSource.slice(flowHandleSendStart, flowHandleSendEnd);

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
    /const handleEditUserMessage = \(editable: EditableUserMessageDraft\) => \{\s*sessionFlowFacade\.handleEditUserMessage\(editable\);\s*\};/,
    "session view edit callback should delegate to the conversation-flow controller",
  );
  assert.match(
    conversationFlowSource,
    /if \(deps\.transcriptEdit\.editableUserMessage\(\)\?\.messageId !== editable\.messageId\) return false;\s*deps\.composer\.setComposerDraft\(editable\.draft\);\s*deps\.transcriptEdit\.setEditingTranscriptMessageId\(editable\.messageId\);/s,
    "edit action should load the reconstructed draft before arming replacement send in the controller",
  );
  assert.match(
    conversationFlowSource,
    /const transcriptMessageId = editingTranscriptMessageId\?\.trim\(\) \|\| null;[\s\S]*if \(transcriptMessageId\) \{[\s\S]*return \{ kind: "replace-transcript-message", messageId: transcriptMessageId \};[\s\S]*\}/,
    "conversation-flow resolver should capture the replacement message id before queue/send branches",
  );
  assert.match(
    flowHandleSendSource,
    /case "replace-transcript-message": \{\s*const sessionKey = deps\.sessionKeys\.currentSessionQueueKey\(\);\s*deps\.transcriptEdit\.setEditingTranscriptMessageId\(null\);\s*const accepted = await controller\.sendPromptImmediate\(draft, \{[\s\S]*reason: "replacement",[\s\S]*expectedSessionKey: sessionKey,[\s\S]*replaceMessageId: action\.messageId,[\s\S]*\}\);/,
    "sending while a transcript edit is armed should clear edit state before handoff and use the captured replacement action id",
  );
  assert.doesNotMatch(
    flowHandleSendSource,
    /const accepted = await controller\.sendPromptImmediate\(draft, \{[\s\S]*reason: "replacement"[\s\S]*\}\);[\s\S]*deps\.transcriptEdit\.setEditingTranscriptMessageId\(null\);/,
    "replacement sends should not keep edit state armed until after the handoff settles",
  );
});

test("replacement send path reverts to the original message before sending the edited draft", () => {
  assert.match(
    sendWorkflowSource,
    /async function sendPrompt\(\s*draft: ComposerDraft,\s*options: SessionSendWorkflowSendOptions,[\s\S]*\): Promise<boolean> \{/,
    "app send API should require a typed send contract for every prompt handoff",
  );
  assert.doesNotMatch(
    sendWorkflowSource.slice(sendWorkflowSource.indexOf("async function sendPrompt("), sendWorkflowSource.indexOf("async function abortSession")),
    /replaceMessageId\?:/,
    "app send API should keep replacement message routing out of the normal prompt send options",
  );
  const promptAsyncCall = sendWorkflowSource.match(/await runConversationOrFail\(\{\s*kind: "prompt_async",[\s\S]*?\n\s*\}\);/)?.[0] ?? "";
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
    flowSendImmediateSource,
    /const accepted = await \(options\.replaceMessageId\s*\? deps\.transport\.replaceUserMessageAsync\(options\.replaceMessageId, draft, replaceOptions\)\s*: deps\.transport\.sendPromptAsync\(draft, promptSendOptions\)\s*\);/s,
    "sendPromptImmediate should route replacement sends through replaceUserMessageAsync",
  );
  const serverReplacementStart = mutationWorkflowSource.indexOf("const submitConversation = deps.submitConversationFromVesloWriteApi;");
  const legacyReplacementStart = mutationWorkflowSource.indexOf("const replaceRuntimePreparation = await deps.prepareSendRuntimeForSend", serverReplacementStart);
  assert.ok(serverReplacementStart >= 0, "mutation workflow should attempt server-owned replacement submit first");
  assert.ok(legacyReplacementStart > serverReplacementStart, "legacy replacement fallback should remain after the server branch");
  const serverReplacementBranch = mutationWorkflowSource.slice(serverReplacementStart, legacyReplacementStart);
  assert.match(
    serverReplacementBranch,
    /submitConversation\(workspaceId, submitDirectory, \{[\s\S]*clientMessageId: sendCorrelation\.clientMessageId,[\s\S]*origin: sendCorrelation\.origin,[\s\S]*draft: conversationSubmitDraftFromComposerDraft\(draft\),[\s\S]*options: \{[\s\S]*replaceMessageId: messageID,[\s\S]*submitQueuePolicy: "normal",[\s\S]*\}[\s\S]*\}, replacePreflight\)/,
    "mutation workflow replacement API should send one server-owned submit with the replacement message id",
  );
  assert.doesNotMatch(
    serverReplacementBranch,
    /revertSession|unrevertSession|deps\.sendPrompt|prepareSendRuntimeForSend/,
    "server-owned replacement branch should not perform app-side revert/send/runtime-prep choreography",
  );
  assert.match(
    mutationWorkflowSource,
    /if \(!accepted\) \{[\s\S]*previousRevertMessageID\s*\? await revertSession\(c, sessionID, previousRevertMessageID\)\s*: await unrevertSession\(c, sessionID\)/,
    "legacy replacement fallback should still restore the prior revert boundary if the edited send is rejected",
  );
  assert.match(
    appSource,
    /const replaceUserMessage = sessionMutationWorkflow\.replaceUserMessage;/,
    "app should expose replacement mutation from the session mutation workflow",
  );
});
