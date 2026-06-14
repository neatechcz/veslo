import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("session page imports queue model helpers, queue list component, and composer send options", () => {
  assert.match(
    source,
    /import type \{ ComposerSendOptions \} from "\.\.\/components\/session\/composer";/,
    "session view should consume ComposerSendOptions from the composer component",
  );
  assert.match(
    source,
    /import QueuedMessageList from "\.\.\/components\/session\/queued-message-list";/,
    "session view should render the queued message list component",
  );
  assert.match(
    source,
    /from "\.\.\/components\/session\/session-queue-model\.js";/,
    "session view should use the shared session queue model helpers",
  );
});

test("session page owns session-local queue state and handleSendPrompt accepts send options", () => {
  assert.match(
    source,
    /const \[queuedDraftsBySessionKey, setQueuedDraftsBySessionKey\] = createSignal<Record<string, QueuedDraft\[\]>>\(\{\}\);/,
    "session view should keep queued drafts keyed by selected session key",
  );
  assert.match(
    source,
    /const \[queuePausedAfterStopBySessionKey, setQueuePausedAfterStopBySessionKey\] = createSignal<Record<string, boolean>>\(\{\}\);/,
    "session view should keep pause state keyed by selected session key",
  );
  assert.match(
    source,
    /const \[editingQueuedDraftId, setEditingQueuedDraftId\] = createSignal<string \| null>\(null\);/,
    "session view should track the queued draft currently being edited",
  );
  assert.match(
    source,
    /const handleSendPrompt = async \(draft: ComposerDraft, options: ComposerSendOptions = \{\}\) => \{/,
    "session send handler should accept composer send options",
  );
});

test("running non-sendNow sends append to the queue before any immediate send path", () => {
  const handlerStart = source.indexOf("const handleSendPrompt = async (draft: ComposerDraft, options: ComposerSendOptions = {}) => {");
  const runningBranch = source.indexOf("if (showRunIndicator() && !sendNow) {", handlerStart);
  const appendCall = source.indexOf("appendDraftToCurrentQueue(draft);", runningBranch);
  const returnTrue = source.indexOf("return true;", appendCall);
  const nextImmediateCall = source.indexOf("sendPromptImmediate(draft", returnTrue);

  assert.notEqual(handlerStart, -1, "session send handler should exist");
  assert.ok(runningBranch > handlerStart, "handler should branch queued sends while a run is visible");
  assert.ok(appendCall > runningBranch, "running Enter sends should append to the session queue");
  assert.ok(returnTrue > appendCall, "queued sends should return true so the composer clears");
  assert.ok(nextImmediateCall > returnTrue, "running queued sends should not call the immediate send path first");
});

test("paused queue Enter append unpauses and starts the first drain-eligible queued draft", () => {
  assert.match(
    source,
    /if \(queuePaused\(\) && !sendNow\) \{\s*const sessionKey = currentSessionQueueKey\(\);\s*appendDraftToCurrentQueue\(draft\);\s*setQueuePausedForSessionKey\(sessionKey, false\);\s*void drainNextQueuedDraft\("normal", sessionKey\);\s*return true;\s*\}/s,
    "plain Enter while paused should append, unpause, and start draining the first queued item",
  );
});

test("idle Enter appends behind an existing queue instead of sending immediately", () => {
  const handlerStart = source.indexOf("const handleSendPrompt = async (draft: ComposerDraft, options: ComposerSendOptions = {}) => {");
  const queuedBranch = source.indexOf("if (queuedDrafts().length > 0 && !sendNow) {", handlerStart);
  const appendCall = source.indexOf("appendDraftToCurrentQueue(draft);", queuedBranch);
  const drainCall = source.indexOf("void drainNextQueuedDraft(\"normal\", sessionKey);", appendCall);
  const returnTrue = source.indexOf("return true;", drainCall);
  const sendNowBranch = source.indexOf("if (sendNow) {", returnTrue);
  const immediateNormal = source.indexOf("return sendPromptImmediate(draft, { reason: \"normal\", sendTraceId: options.sendTraceId });", returnTrue);

  assert.notEqual(handlerStart, -1, "session send handler should exist");
  assert.ok(queuedBranch > handlerStart, "plain Enter should branch when the queue already has drafts");
  assert.ok(appendCall > queuedBranch, "idle queued Enter should append the new draft behind the existing queue");
  assert.ok(drainCall > appendCall, "idle queued Enter should make sure the first queued item starts draining");
  assert.ok(returnTrue > drainCall, "idle queued Enter should clear the composer without sending the new draft immediately");
  assert.ok(sendNowBranch > returnTrue, "send-now should still bypass the queue after the plain Enter queue branch");
  assert.ok(immediateNormal > returnTrue, "normal immediate send should only be reached after the existing-queue branch");
});

test("paused send-now unpauses only after accepted immediate send", () => {
  assert.match(
    source,
    /const sessionKey = currentSessionQueueKey\(\);\s*const wasPaused = queuePausedForSessionKey\(sessionKey\);\s*const accepted = await sendPromptImmediate\(draft, \{\s*reason: "send-now",\s*expectedSessionKey: sessionKey,\s*sendTraceId: options\.sendTraceId,\s*\}\);\s*if \(accepted && wasPaused\) \{\s*setQueuePausedForSessionKey\(sessionKey, false\);\s*\}\s*return accepted;/s,
    "send-now while paused should unpause only after the immediate send is accepted",
  );
});

test("idle transition drains only after a non-idle status and only when queue is not paused", () => {
  assert.match(
    source,
    /createEffect\(\s*on\(\s*\(\) => props\.sessionStatus,\s*\(status, previousStatus\) => \{\s*if \(previousStatus === undefined \|\| previousStatus === "idle" \|\| status !== "idle"\) return;\s*const sessionKey = currentSessionQueueKey\(\);\s*if \(queuePausedForSessionKey\(sessionKey\)\) return;\s*void drainNextQueuedDraft\("queue-drain", sessionKey\);/s,
    "idle transitions should drain only after a previous non-idle status and while not paused",
  );
  assert.match(
    source,
    /const sessionId = sessionIdForQueueKey\(sessionKey\);[\s\S]*if \(!sessionId\) continue;[\s\S]*previousStatuses\[sessionId\][\s\S]*statuses\[sessionId\]/s,
    "background queue status checks should resolve scoped UI keys back to raw session ids",
  );
});

test("queued drain uses a stable session key and guards stale navigation", () => {
  assert.match(
    source,
    /const targetSessionId = expectedSessionKey \? sessionIdForQueueKey\(expectedSessionKey\) : null;[\s\S]*if \(expectedSessionKey && currentSessionQueueKey\(\) !== expectedSessionKey && !targetSessionId\) return false;/s,
    "immediate sends should target stale real sessions but refuse stale pending queues",
  );

  assert.match(
    source,
    /const accepted = await sendPromptImmediate\(item\.draft, \{ reason, expectedSessionKey: sessionKey \}\);/,
    "queue drains should pass their captured session key to the immediate send path",
  );

  assert.match(
    source,
    /const promptSendOptions:[\s\S]*clientMessageId: string;[\s\S]*origin: SessionSendOrigin;[\s\S]*= \{[\s\S]*clientMessageId,[\s\S]*origin,[\s\S]*\.\.\.\(targetSessionId \? \{ targetSessionId \} : \{\}\),[\s\S]*\.\.\.\(options\.sendTraceId \? \{ sendTraceId: options\.sendTraceId \} : \{\}\),[\s\S]*props\.sendPromptAsync\(draft, promptSendOptions\)/s,
    "queue drains should pass their captured target session and trace id to the parent send path",
  );

  assert.match(
    source,
    /if \(options\.expectedSessionKey && currentSessionQueueKey\(\) !== options\.expectedSessionKey\) \{\s*if \(showOptimisticSubmit\) \{\s*clearMatchingPendingSubmit\(\);\s*\}\s*return accepted;\s*\}/,
    "stale queue sends should not start run UI for the newly selected session",
  );
});

test("pending draft queues remap to the real session key without replacing existing real queues", () => {
  assert.match(
    source,
    /remapPendingSubmittedSession/,
    "session view should remap optimistic pending submissions when the real session id materializes",
  );

  assert.match(
    source,
    /const remapPendingQueueToSession = \(pendingKey: string, sessionId: string\) => \{[\s\S]*const sessionKey = sessionQueueKeyForSessionId\(sessionId\);[\s\S]*const pendingQueue = current\[pendingKey\] \?\? \[\];[\s\S]*const existingRealQueue = current\[sessionKey\] \?\? \[\];[\s\S]*\[sessionKey\]: \[\.\.\.existingRealQueue, \.\.\.pendingQueue\],[\s\S]*\};/s,
    "pending queue remap should append pending drafts behind any existing real-session queue",
  );

  assert.match(
    source,
    /setQueuePausedAfterStopBySessionKey\(\(current\) => \{[\s\S]*const pendingPaused = Boolean\(current\[pendingKey\]\);[\s\S]*return \{[\s\S]*\[sessionKey\]: pendingPaused \|\| Boolean\(current\[sessionKey\]\),[\s\S]*\};[\s\S]*\}\);/s,
    "pending queue pause state should remap to the real-session key without clearing an existing real pause",
  );
});

test("session queue keys follow the UI conversation workspace scope", () => {
  assert.match(
    source,
    /activeUiConversationRef\?: UiConversationRef;/,
    "session props should accept the UI conversation scope used by the app-level selection controller",
  );

  assert.match(
    source,
    /const activeUiConversationWorkspaceId = \(\) =>[\s\S]*props\.activeUiConversationRef\?\.workspaceId\?\.trim\(\) \|\| props\.activeWorkspaceId \|\| "default";/,
    "session queue keys should prefer the visible conversation workspace over the active workspace fallback",
  );

  assert.match(
    source,
    /const workspaceIdForSessionQueue = \(sessionId: string\) => \{[\s\S]*ref\.sessionId\?\.trim\(\)[\s\S]*ref\.conversationId\?\.trim\(\)[\s\S]*ref\.opencodeSessionId\?\.trim\(\)[\s\S]*return ref\.workspaceId\?\.trim\(\) \|\| activeUiConversationWorkspaceId\(\);[\s\S]*\};/s,
    "real session queue keys should stay anchored to the scoped visible conversation across send-time workspace activation",
  );

  assert.match(
    appSource,
    /activeUiConversationRef: activeUiConversationRef\(\),/,
    "app should pass the scoped visible conversation identity into SessionView",
  );
});

test("accepted first pending submit captures and remaps the pending queue key", () => {
  assert.match(
    source,
    /const \[pendingQueueKeyAwaitingSessionIdByBaseKey, setPendingQueueKeyAwaitingSessionIdByBaseKey\] =\s*createSignal<Record<string, string>>\(\{\}\);/,
    "session view should retain a captured pending queue key until a real session id is available",
  );

  assert.match(
    source,
    /const pendingSessionBaseKeyBeforeHandoff =[\s\S]*const pendingSessionKeyBeforeHandoff = !targetSessionId && !sessionIdForQueueKey\(sessionKey\) \? sessionKey : null;[\s\S]*setPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);[\s\S]*const accepted = await \(options\.replaceMessageId[\s\S]*if \(accepted && pendingSessionKeyBeforeHandoff\) \{[\s\S]*const materializedSessionId = materializedSessionIdFromHandoff \?\? props\.selectedSessionId\?\.trim\(\);[\s\S]*materializePendingHandoffToSession\(materializedSessionId\);/s,
    "sendPromptImmediate should capture the pending queue key before await and remap it after an accepted first submit",
  );

  assert.match(
    source,
    /createEffect\(\s*on\(\s*\(\) => props\.selectedSessionId,[\s\S]*const pendingBaseKey = pendingSessionQueueKey\(\);[\s\S]*const pendingKey = !previousSessionId[\s\S]*pendingQueueKeyAwaitingSessionIdByBaseKey\(\)\[pendingBaseKey\] \?\? null[\s\S]*if \(pendingKey && !isPendingSessionInstanceId\(sessionId\)\) \{[\s\S]*remapPendingQueueToSession\(pendingKey, sessionId\);[\s\S]*clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingBaseKey, pendingKey\);[\s\S]*\}/s,
    "session view should also remap pending queues when the selected session id arrives in a later reactive update",
  );

  assert.doesNotMatch(
    source,
    /pendingQueueKeyAwaitingSessionId\(\) \?\? pendingSessionQueueKey\(\)/,
    "delayed session materialization should not fall back to the current active pending draft key",
  );
});

test("accepted pending queue drain removes the sent item from the materialized session queue", () => {
  assert.match(
    source,
    /resolveQueuedDraftSessionKey\(queuedDraftsBySessionKey\(\), originalSessionKey, draftId\);/,
    "session view should resolve a queued draft's current key from the full queue map before falling back to the original key",
  );

  assert.match(
    source,
    /if \(accepted\) \{\s*const acceptedSessionKey = resolveQueueKeyForQueuedDraft\(sessionKey, item\.id\);\s*updateQueueForSessionKey\(acceptedSessionKey, \(queue\) => removeQueuedDraft\(queue, item\.id\)\);\s*return;\s*\}/s,
    "accepted pending queue drains should remove the sent item from whichever queue currently contains it",
  );
});

test("failed first pending submit restores remapped queued drafts to the pending key", () => {
  assert.match(
    source,
    /const restoreMaterializedQueueToPending = \(pendingKey: string, sessionId: string \| null \| undefined\) => \{[\s\S]*const materializedQueue = current\[sessionKey\] \?\? \[\];[\s\S]*const existingPendingQueue = current\[pendingKey\] \?\? \[\];[\s\S]*\[pendingKey\]: \[\.\.\.existingPendingQueue, \.\.\.materializedQueue\],[\s\S]*\};/s,
    "session view should be able to move queued follow-up drafts back from the materialized session key",
  );

  assert.match(
    source,
    /let materializedSessionIdToRestore: string \| null = null;[\s\S]*materializedSessionIdToRestore = current\.sessionId;[\s\S]*restoreMaterializedQueueToPending\(pendingSessionKeyBeforeHandoff, materializedSessionIdToRestore\);/s,
    "failed pending submit should restore any remapped queued drafts before returning to the pending draft route",
  );
});

test("rejected pending queue drain updates the remapped item key", () => {
  assert.match(
    source,
    /if \(currentSessionQueueKey\(\) !== sessionKey && !sessionIdForQueueKey\(sessionKey\)\) \{\s*const queuedSessionKey = resolveQueueKeyForQueuedDraft\(sessionKey, item\.id\);\s*updateQueueForSessionKey\(queuedSessionKey, \(queue\) => markQueuedDraftQueued\(queue, item\.id\)\);\s*return;\s*\}/s,
    "queued fallback should restore the item in whichever queue currently contains it",
  );

  assert.match(
    source,
    /const errorSessionKey = resolveQueueKeyForQueuedDraft\(sessionKey, item\.id\);\s*updateQueueForSessionKey\(errorSessionKey, \(queue\) =>\s*markQueuedDraftError\(queue, item\.id, props\.error \?\? tr\("session\.connect_server_to_attach"\)\),\s*\);/s,
    "rejected queue drains should mark the remapped queued item as error instead of updating the stale pending key",
  );
});

test("app prompt send accepts an explicit target session without freezing model bootstrap", () => {
  const sendStart = appSource.indexOf("async function sendPrompt");
  const targetCapture = appSource.indexOf("let sessionID = isPendingSessionInstanceId(options.targetSessionId)", sendStart);
  const bootstrap = appSource.indexOf('"sendPrompt:ensure-managed-ai-bootstrap-ready"', sendStart);
  const modelResolution = appSource.indexOf("const model = modelForSession(sessionID);", sendStart);
  const agentResolution = appSource.indexOf("const agent = agentForSession(sessionID);", sendStart);

  assert.notEqual(sendStart, -1, "app sendPrompt should exist");
  assert.ok(targetCapture > sendStart, "sendPrompt should accept a captured target session id");
  assert.ok(modelResolution > bootstrap, "model should resolve after managed AI bootstrap");
  assert.ok(agentResolution > bootstrap, "agent should resolve after managed AI bootstrap");
});

test("queued edit lifecycle restores editing items and drains idle saves", () => {
  assert.match(
    source,
    /const restoreEditingQueuedDraft = \(sessionKey: string, id: string \| null\) => \{[\s\S]*markQueuedDraftQueued\(queue, id\)[\s\S]*\};/,
    "session view should be able to restore an editing queued draft to queued state",
  );

  assert.match(
    source,
    /const currentEditingId = editingQueuedDraftId\(\);\s*if \(currentEditingId && currentEditingId !== id\) \{\s*restoreEditingQueuedDraft\(currentSessionQueueKey\(\), currentEditingId\);\s*\}/,
    "editing a second queued item should restore the previous editing item",
  );

  assert.match(
    source,
    /const previousEditingQueuedDraftId = editingQueuedDraftId\(\);[\s\S]*restoreEditingQueuedDraft\(sessionQueueKeyForSessionId\(previousSessionId\), previousEditingQueuedDraftId\);[\s\S]*props\.clearComposerDraftForSession\(previousSessionId\);[\s\S]*setEditingQueuedDraftId\(null\);/,
    "switching sessions should restore the previous queued edit item and clear its composer draft",
  );

  assert.match(
    source,
    /if \(!showRunIndicator\(\) && !queuePausedForSessionKey\(sessionKey\)\) \{\s*void drainNextQueuedDraft\("normal", sessionKey\);\s*\}/,
    "saving an edited queued draft while idle should resume draining",
  );
});

test("edited queued send-now marks the edited item sending before awaiting handoff", () => {
  assert.match(
    source,
    /const sessionKey = currentSessionQueueKey\(\);\s*const wasPaused = queuePausedForSessionKey\(sessionKey\);\s*updateQueueForSessionKey\(sessionKey, \(queue\) =>\s*markQueuedDraftSending\(updateQueuedDraft\(queue, editingId, draft\), editingId\),\s*\);\s*if \(currentSessionQueueKey\(\) === sessionKey\) \{\s*setEditingQueuedDraftId\(null\);\s*props\.setComposerDraft\(emptyComposerDraft\(draft\.mode\)\);\s*\}\s*const accepted = await sendPromptImmediate\(draft, \{\s*reason: "send-now",\s*expectedSessionKey: sessionKey,\s*restoreDraftOnFailure: false,\s*sendTraceId: options\.sendTraceId,\s*\}\);/s,
    "edited queued send-now should persist the edited draft into a sending queue item and release the composer before awaiting handoff",
  );
});

test("edited queued send-now marks the edited item error when handoff is rejected", () => {
  assert.match(
    source,
    /const accepted = await sendPromptImmediate\(draft, \{\s*reason: "send-now",\s*expectedSessionKey: sessionKey,\s*restoreDraftOnFailure: false,\s*sendTraceId: options\.sendTraceId,\s*\}\);\s*const resultSessionKey = resolveQueueKeyForQueuedDraft\(sessionKey, editingId\);\s*if \(!accepted\) \{\s*updateQueueForSessionKey\(resultSessionKey, \(queue\) =>\s*markQueuedDraftError\(queue, editingId, props\.error \?\? tr\("session\.connect_server_to_attach"\)\),\s*\);\s*return false;\s*\}\s*updateQueueForSessionKey\(resultSessionKey, \(queue\) => removeQueuedDraft\(queue, editingId\)\);[\s\S]*if \(accepted && wasPaused\) \{\s*setQueuePausedForSessionKey\(sessionKey, false\);\s*\}/s,
    "edited queued send-now should update whichever queue contains the edited item after a pending remap",
  );
});

test("cancelRun marks the current queue paused before aborting", () => {
  const cancelStart = source.indexOf("const cancelRun = async () => {");
  const pauseCall = source.indexOf("setQueuePausedForCurrentSession(true);", cancelStart);
  const abortCall = source.indexOf("await props.abortSession(props.selectedSessionId);", cancelStart);

  assert.notEqual(cancelStart, -1, "cancelRun should exist");
  assert.ok(pauseCall > cancelStart, "cancelRun should pause the current queue");
  assert.ok(abortCall > pauseCall, "queue pause should happen before the abort request resolves");
});

test("queued message list renders above the composer", () => {
  const queueList = source.indexOf("<QueuedMessageList");
  const composer = source.indexOf("<Composer", queueList);

  assert.ok(queueList !== -1, "session should render the queued message list");
  assert.ok(composer > queueList, "queued message list should render above the composer");
});
