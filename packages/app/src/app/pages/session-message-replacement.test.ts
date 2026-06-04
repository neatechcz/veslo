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
    /async function sendPrompt\(\s*draft\?: ComposerDraft,\s*options: \{ targetSessionId\?: string \| null \} = \{\},\s*\): Promise<boolean> \{/,
    "app send API should not accept a replacement message id; edited transcript sends must create a new backend message after revert",
  );
  const promptAsyncStart = appSource.indexOf("const result = await c.session.promptAsync({");
  const promptAsyncEnd = appSource.indexOf("        });", promptAsyncStart);
  assert.notEqual(promptAsyncStart, -1, "promptAsync send branch should exist");
  assert.notEqual(promptAsyncEnd, -1, "promptAsync send branch should have a clear request object");
  const promptAsyncCall = appSource.slice(promptAsyncStart, promptAsyncEnd);
  assert.doesNotMatch(
    promptAsyncCall,
    /\bmessageID\b/,
    "normal promptAsync sends, including transcript replacements after revert, should let OpenCode allocate a fresh message id",
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
    /async function replaceUserMessage\([\s\S]*messageID: string,[\s\S]*draft: ComposerDraft,[\s\S]*options: \{ targetSessionId\?: string \| null \} = \{},[\s\S]*\): Promise<boolean> \{[\s\S]*const sessionID = \(options\.targetSessionId\?\.trim\(\) \|\| selectedSessionId\(\) \|\| ""\)\.trim\(\);[\s\S]*if \(!sessionID \|\| !messageID\.trim\(\)\) return false;[\s\S]*let c = client\(\) \?\? await connectLocalRuntimeClientFromEngineInfo\("replaceUserMessage"\);[\s\S]*if \(!c\) \{[\s\S]*if \(!\(await ensureLocalRuntimeReachableForSend\("replaceUserMessage"\)\)\) return false;[\s\S]*c = client\(\) \?\? await connectLocalRuntimeClientFromEngineInfo\("replaceUserMessage"\);[\s\S]*\}[\s\S]*if \(!\(await ensureManagedAiBootstrapReady\(\)\)\) return false;[\s\S]*if \(!c\) \{[\s\S]*recordSendTrace\("replaceUserMessage:blocked-no-client"\);[\s\S]*return false;[\s\S]*\}[\s\S]*const previousRevertMessageID = selectedSession\(\)\?\.revert\?\.messageID \?\? null;[\s\S]*const next = await revertSession\(c, sessionID, messageID\);[\s\S]*upsertLocalSession\(next\);[\s\S]*const accepted = await sendPrompt\(draft, \{ targetSessionId: sessionID \}\);/,
    "app replacement API should recover the runtime, revert to the target user message, and send the edited draft as a new message",
  );
  assert.match(
    appSource,
    /if \(!accepted\) \{[\s\S]*previousRevertMessageID\s*\? await revertSession\(c, sessionID, previousRevertMessageID\)\s*: await unrevertSession\(c, sessionID\)/,
    "replacement API should restore the prior revert boundary if the edited send is rejected",
  );
});
