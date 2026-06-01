import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

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
    /const handleEditUserMessage = \(editable: EditableUserMessageDraft\) => \{[\s\S]*if \(editableUserMessage\(\)\?\.messageId !== editable\.messageId\) return;[\s\S]*setEditingTranscriptMessageId\(editable\.messageId\);[\s\S]*props\.setComposerDraft\(editable\.draft\);[\s\S]*\};/,
    "edit action should load the reconstructed draft into the composer",
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
    /async function sendPrompt\(\s*draft\?: ComposerDraft,\s*options: \{ targetSessionId\?: string \| null; messageId\?: string \| null \} = \{\},\s*\): Promise<boolean> \{/,
    "app send API should allow callers to preserve the backend message id for replacement sends",
  );
  assert.match(
    appSource,
    /const replacementMessageID = options\.messageId\?\.trim\(\) \|\| undefined;/,
    "app send path should normalize the optional replacement message id once before building OpenCode requests",
  );
  assert.match(
    appSource,
    /session\.promptAsync\(\{[\s\S]*\.\.\.\(replacementMessageID \? \{ messageID: replacementMessageID \} : \{\}\),[\s\S]*sessionID,[\s\S]*model,/,
    "prompt replacement sends should pass the original messageID so OpenCode updates that turn instead of appending a duplicate",
  );
  assert.match(
    sessionSource,
    /replaceUserMessageAsync: \(\s*messageId: string,\s*draft: ComposerDraft,\s*options\?: \{ targetSessionId\?: string \| null \},\s*\) => Promise<boolean>;/,
    "session props should expose a replacement send API",
  );
  assert.match(
    sessionSource,
    /const accepted = await \(options\.replaceMessageId\s*\? props\.replaceUserMessageAsync\(options\.replaceMessageId, draft, targetSessionId \? \{ targetSessionId \} : undefined\)\s*: props\.sendPromptAsync\(draft, targetSessionId \? \{ targetSessionId \} : undefined\)\s*\);/s,
    "sendPromptImmediate should route replacement sends through replaceUserMessageAsync",
  );
  assert.match(
    appSource,
    /async function replaceUserMessage\([\s\S]*messageID: string,[\s\S]*draft: ComposerDraft,[\s\S]*options: \{ targetSessionId\?: string \| null \} = \{},[\s\S]*\): Promise<boolean> \{[\s\S]*const sessionID = \(options\.targetSessionId\?\.trim\(\) \|\| selectedSessionId\(\) \|\| ""\)\.trim\(\);[\s\S]*const previousRevertMessageID = selectedSession\(\)\?\.revert\?\.messageID \?\? null;[\s\S]*const next = await revertSession\(c, sessionID, messageID\);[\s\S]*upsertLocalSession\(next\);[\s\S]*const accepted = await sendPrompt\(draft, \{ targetSessionId: sessionID, messageId: messageID \}\);/,
    "app replacement API should revert to the target user message and then send the edited draft with the original message id",
  );
  assert.match(
    appSource,
    /if \(!accepted\) \{[\s\S]*previousRevertMessageID\s*\? await revertSession\(c, sessionID, previousRevertMessageID\)\s*: await unrevertSession\(c, sessionID\)/,
    "replacement API should restore the prior revert boundary if the edited send is rejected",
  );
});
