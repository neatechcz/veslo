import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const conversationFlowSource = readFileSync(
  new URL("../../pages/session-conversation-flow.ts", import.meta.url),
  "utf8",
);
const queueDrainControllerSource = readFileSync(
  new URL("../../context/session-queue-drain-controller.ts", import.meta.url),
  "utf8",
);
const source = `${sessionSource}\n${conversationFlowSource}\n${queueDrainControllerSource}`;
const appViewPropsSource = readFileSync(new URL("../../app-view-props.ts", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(new URL("../../pages/session-send-workflow.ts", import.meta.url), "utf8");
const sessionRuntimeDoc = readFileSync(new URL("../../../../../../docs/features/session-runtime.md", import.meta.url), "utf8");
const flowSendImmediateStart = conversationFlowSource.indexOf("sendPromptImmediate: async (");
const flowSendImmediateEnd = conversationFlowSource.indexOf("export type RunBaseline", flowSendImmediateStart);
const flowSendImmediateSource = conversationFlowSource.slice(flowSendImmediateStart, flowSendImmediateEnd);
const flowDrainStart = conversationFlowSource.indexOf("drainNextQueuedDraft: async (");
const flowDrainEnd = conversationFlowSource.indexOf("export type RunBaseline", flowDrainStart);
const flowDrainSource = conversationFlowSource.slice(flowDrainStart, flowDrainEnd);
const flowHandleSendStart = conversationFlowSource.indexOf("handleSendPrompt: async (");
const flowHandleSendEnd = conversationFlowSource.indexOf("drainNextQueuedDraft: async (", flowHandleSendStart);
const flowHandleSendSource = conversationFlowSource.slice(flowHandleSendStart, flowHandleSendEnd);

function conversationRunCompatibilityBridgeSource(): string {
  const start = sendWorkflowSource.indexOf("export function createConversationRunCompatibilityBridge(");
  const end = sendWorkflowSource.indexOf("export function createSessionSendWorkflow", start);
  assert.notEqual(start, -1, "conversation run compatibility bridge should exist");
  assert.notEqual(end, -1, "conversation run compatibility bridge block should end before createSessionSendWorkflow");
  return sendWorkflowSource.slice(start, end);
}

test("session page imports queue model helpers, queue list component, and composer send options", () => {
  assert.match(
    source,
    /import type \{ ComposerSendOptions, ComposerSendResult \} from "\.\.\/components\/session\/composer";/,
    "session view should consume ComposerSendOptions and ComposerSendResult from the composer component",
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
    /const handleSendPrompt = async \(draft: ComposerDraft, options: ComposerSendOptions = \{\}\): Promise<ComposerSendResult> => \{/,
    "session send handler should accept composer send options and return a typed result",
  );
  assert.match(
    sessionSource,
    /const sessionFlowFacade = createSessionViewFlowFacade\(\{ conversationFlow \}\);[\s\S]*const modelOverrideSnapshot = \(options as SessionComposerSendOptions\)\.modelOverride;[\s\S]*const result = await sessionFlowFacade\.handleSendPrompt\(draft, \{\s*sendNow: options\.sendNow,\s*sendTraceId: options\.sendTraceId,\s*source: options\.source,\s*modelOverride,\s*onDraftTransferred: options\.onDraftTransferred,\s*\}\);/s,
    "session send handler should delegate queue/send branching and return the typed facade result for the composer",
  );
  assert.doesNotMatch(
    sessionSource,
    /sessionSubmitResultFromAccepted/,
    "session send handler must not rebuild typed composer results from a boolean facade result",
  );
  assert.match(
    flowHandleSendSource,
    /const action = resolveSendPromptAction\(\{[\s\S]*sendNow,[\s\S]*editingQueuedDraftId: deps\.queue\.editingQueuedDraftId\(\),[\s\S]*editingTranscriptMessageId: deps\.transcriptEdit\.editingTranscriptMessageId\(\),[\s\S]*queuePaused: deps\.queue\.queuePaused\(\),[\s\S]*queuedDraftCount: deps\.queue\.queuedDrafts\(\)\.length,[\s\S]*runVisible: deps\.runState\.showRunIndicator\(\),[\s\S]*\}\);/s,
    "conversation-flow controller should resolve send actions from current queue and edit state",
  );
});

test("running non-sendNow sends use the server queue-drain contract directly", () => {
  const resolverBranch = conversationFlowSource.indexOf('if (runVisible && !sendNow) return { kind: "send-running-server-queue" };');
  const handlerStart = flowHandleSendSource.indexOf("handleSendPrompt: async (");
  const runningCase = flowHandleSendSource.indexOf('case "send-running-server-queue"', handlerStart);
  const sessionKeyCapture = flowHandleSendSource.indexOf("const sessionKey = deps.sessionKeys.currentSessionQueueKey();", runningCase);
  const sendImmediateCall = flowHandleSendSource.indexOf("return controller.sendPromptImmediate(draft, {", sessionKeyCapture);
  const queueDrainReason = flowHandleSendSource.indexOf('reason: "queue-drain"', sendImmediateCall);
  const expectedSessionKey = flowHandleSendSource.indexOf("expectedSessionKey: sessionKey", queueDrainReason);
  const sendNormalCase = flowHandleSendSource.indexOf('case "send-normal"', expectedSessionKey);
  const runningBranchSource = flowHandleSendSource.slice(runningCase, sendNormalCase);

  assert.notEqual(resolverBranch, -1, "conversation-flow resolver should classify running non-sendNow sends");
  assert.notEqual(handlerStart, -1, "conversation-flow send handler should exist");
  assert.ok(runningCase > handlerStart, "handler should have a running server-queue action branch");
  assert.ok(sessionKeyCapture > runningCase, "running Enter sends should capture the visible session key");
  assert.ok(sendImmediateCall > sessionKeyCapture, "running Enter sends should submit through sendPromptImmediate");
  assert.ok(queueDrainReason > sendImmediateCall, "running Enter sends should use the existing queue-drain origin");
  assert.ok(expectedSessionKey > queueDrainReason, "running Enter sends should preserve the captured session key");
  assert.ok(sendNormalCase > expectedSessionKey, "running queued sends should return before the normal immediate send branch");
  assert.equal(
    runningBranchSource.includes("appendDraftToCurrentQueue"),
    false,
    "running Enter sends should not fabricate a local queue row before server admission",
  );
  assert.equal(
    runningBranchSource.includes("local_queue_running_append"),
    false,
    "running Enter sends should return the typed server submit result",
  );
});

test("session model selection is roster-validated and snapshots each send", () => {
  assert.match(
    sessionSource,
    /const \[sessionModelOverride, setSessionModelOverride\] = createSignal<\{\s*sessionKey: string;\s*model: ModelRef \| null;\s*\}>\(\{ sessionKey: "", model: null \}\);/s,
    "only one active session model selection should be retained",
  );
  assert.match(
    sessionSource,
    /return selectableSessionModels\(\)\.some\([\s\S]*entry\.model\.providerID === selection\.model!\.providerID[\s\S]*entry\.model\.modelID === selection\.model!\.modelID[\s\S]*\)\s*\? selection\.model\s*:\s*null;/s,
    "a removed selectable model should resolve to the workspace default before send",
  );
  assert.match(
    sessionSource,
    /const modelOverrideSnapshot = \(options as SessionComposerSendOptions\)\.modelOverride;[\s\S]*modelOverrideSnapshot !== undefined[\s\S]*\? modelOverrideSnapshot/s,
    "each send should honor the model captured before the handoff",
  );
});

test("accepted server queue work has a separate read-only projection and scoped hydration controller", () => {
  assert.match(
    sessionSource,
    /import ServerQueuedRunList from "\.\.\/components\/session\/server-queued-run-list";/,
    "session view should render server-owned work through a separate list component",
  );
  assert.match(
    sessionSource,
    /const \[serverQueuedRuns, setServerQueuedRuns\] = createSignal<ServerQueuedRunProjection\[\]>\(\[\]\);/,
    "server-owned queue rows must not use the editable local QueuedDraft owner",
  );
  assert.match(
    sessionSource,
    /const result = await props\.sendPromptAsync\(draft, options\);[\s\S]*const projectionScope = activeServerQueueProjectionScope\(\);[\s\S]*projectionScope\.workspaceId !== workspaceId[\s\S]*projectionScope\.conversationId !== conversationId[\s\S]*return result;/s,
    "an accepted queue response must be projected only into the still-selected matching server scope",
  );
  assert.match(
    sessionSource,
    /result\.status === "queued"[\s\S]*setServerQueuedRuns\(\(current\) =>[\s\S]*upsertServerQueuedRunProjection\(current, \{[\s\S]*queueItemId,[\s\S]*reservedRunId,[\s\S]*clientMessageId:[\s\S]*\}, projectionScope\),[\s\S]*requestServerQueueProjectionRefresh\(projectionScope\);/s,
    "accepted queue responses should appear immediately by their server identity and then refresh their guarded projection scope",
  );
  assert.match(
    sessionSource,
    /const serverQueueProjectionController = createServerQueueProjectionController\(\{[\s\S]*const client = props\.vesloServerClient;[\s\S]*client\.listConversationQueue\(scope\.workspaceId, scope\.conversationId, \{[\s\S]*status: \["pending", "starting", "failed"\],[\s\S]*\}\);[\s\S]*replaceServerQueuedRunScope\(current, scope, items\)/s,
    "hydration must use the captured server workspace and conversation scope and replace only that projection scope",
  );
  assert.match(
    sessionSource,
    /selectionGeneration: unchanged[\s\S]*previous\.selectionGeneration[\s\S]*props\.reconnectState\?\.status \?\? ""[\s\S]*requestServerQueueProjectionRefresh\(\{ workspaceId, conversationId, uiConversationKey, selectionGeneration \}\);/s,
    "activation and reconnect changes should refresh a monotonic visible selection scope, including A-to-B-to-A returns",
  );
  assert.match(
    sessionSource,
    /<ServerQueuedRunList items=\{visibleServerQueuedRuns\(\)\} \/>/,
    "server queue rows should render separately from local drafts",
  );
});

test("canonical queue documentation keeps the local and server ownership contracts distinct", () => {
  assert.match(
    sessionRuntimeDoc,
    /A local queued draft is a pre-admission, editable SessionView item\. It exists only for the lifetime of that view and is not restart-durable\./,
  );
  assert.match(
    sessionRuntimeDoc,
    /While a session is running or streaming, plain Enter and the queue send button submit directly to server admission instead of first creating a local queue row\./,
  );
  assert.match(
    sessionRuntimeDoc,
    /Stop aborts the active lifecycle run and pauses only local pre-admission drafts[\s\S]*A server-accepted queue item is not paused or cancelled by Stop and may continue after the aborted run reaches a terminal state\./,
  );
  assert.match(
    sessionRuntimeDoc,
    /Queue status `submitted` means that queue processing handed the reserved run to the lifecycle; it is not a successful model response\./,
  );
  assert.match(
    sessionRuntimeDoc,
    /Server projection rows are read-only: they do not expose Retry, Edit, Cancel, Move, Pause, or Resume controls/,
  );
  assert.match(
    sessionRuntimeDoc,
    /Legacy pending queue-key prefixes remain compatibility state\./,
  );
  assert.doesNotMatch(
    sessionRuntimeDoc,
    /When a session is running or streaming, plain Enter and the queue send button add the draft to a session-local queue/,
  );
});

test("paused queue Enter append unpauses and starts the first drain-eligible queued draft", () => {
  assert.match(
    conversationFlowSource,
    /if \(queuePaused && !sendNow\) return \{ kind: "append-to-paused-queue-and-drain" \};/,
    "conversation-flow resolver should classify plain Enter while paused",
  );
  assert.match(
    flowHandleSendSource,
    /case "append-to-paused-queue-and-drain": \{\s*const sessionKey = deps\.sessionKeys\.currentSessionQueueKey\(\);\s*deps\.queue\.appendDraftToCurrentQueue\(draft, \{\s*clientMessageId: deps\.identity\.createClientMessageId\(\),[\s\S]*?\}\);\s*acknowledgeDraftTransfer\(\);\s*deps\.queue\.setQueuePausedForSessionKey\(sessionKey, false\);\s*void controller\.drainNextQueuedDraft\("normal", sessionKey\);\s*return localQueuedResult\("local_queue_paused_append"\);\s*\}/s,
    "plain Enter while paused should append, unpause, and start draining the first queued item in the flow controller",
  );
});

test("idle Enter appends behind an existing queue instead of sending immediately", () => {
  const resolverBranch = conversationFlowSource.indexOf("if (queuedDraftCount > 0 && !sendNow)");
  const handlerStart = flowHandleSendSource.indexOf("handleSendPrompt: async (");
  const queuedCase = flowHandleSendSource.indexOf('case "append-to-existing-queue-and-drain-if-idle"', handlerStart);
  const appendCall = flowHandleSendSource.indexOf("deps.queue.appendDraftToCurrentQueue(draft, {", queuedCase);
  const drainCall = flowHandleSendSource.indexOf('void controller.drainNextQueuedDraft("normal", sessionKey);', appendCall);
  const returnQueued = flowHandleSendSource.indexOf('return localQueuedResult("local_queue_existing_append");', drainCall);
  const sendNowBranch = flowHandleSendSource.indexOf('case "send-now"', returnQueued);
  const immediateNormal = flowHandleSendSource.indexOf('case "send-normal"', returnQueued);

  assert.notEqual(resolverBranch, -1, "conversation-flow resolver should classify existing queued sends");
  assert.notEqual(handlerStart, -1, "conversation-flow send handler should exist");
  assert.ok(queuedCase > handlerStart, "plain Enter should branch when the queue already has drafts");
  assert.ok(appendCall > queuedCase, "idle queued Enter should append the new draft behind the existing queue");
  assert.ok(drainCall > appendCall, "idle queued Enter should make sure the first queued item starts draining");
  assert.ok(returnQueued > drainCall, "idle queued Enter should return a typed queued result without sending the new draft immediately");
  assert.ok(sendNowBranch > returnQueued, "send-now should still bypass the queue after the plain Enter queue branch");
  assert.ok(immediateNormal > returnQueued, "normal immediate send should only be reached after the existing-queue branch");
});

test("paused send-now unpauses only after accepted immediate send", () => {
  assert.match(
    flowHandleSendSource,
    /const sessionKey = deps\.sessionKeys\.currentSessionQueueKey\(\);\s*const wasPaused = deps\.queue\.queuePausedForSessionKey\(sessionKey\);\s*const submitResult = await controller\.sendPromptImmediate\(draft, \{\s*reason: "send-now",\s*expectedSessionKey: sessionKey,\s*sendTraceId: options\.sendTraceId,\s*source: options\.source,\s*modelOverride: options\.modelOverride,\s*onDraftTransferred: acknowledgeDraftTransfer,\s*\}\);\s*if \(sessionSubmitWasAccepted\(submitResult\) && wasPaused\) \{\s*deps\.queue\.setQueuePausedForSessionKey\(sessionKey, false\);\s*\}\s*return submitResult;/s,
    "send-now while paused should unpause only after the immediate send is accepted and should preserve composer source",
  );
});

test("idle transition drains only after a non-idle status and only when queue is not paused", () => {
  assert.match(
    queueDrainControllerSource,
    /options\.handleActiveSessionStatusChanged\(status, previousStatus\);/,
    "queue drain controller should report active status changes to the conversation-flow facade",
  );
  assert.match(
    conversationFlowSource,
    /handleActiveSessionStatusChanged: \(status, previousStatus\) => \{\s*if \(previousStatus === undefined \|\| previousStatus === "idle" \|\| status !== "idle"\) return;\s*const sessionKey = deps\.sessionKeys\.currentSessionQueueKey\(\);\s*if \(deps\.queue\.queuePausedForSessionKey\(sessionKey\)\) return;\s*void controller\.drainNextQueuedDraft\("queue-drain", sessionKey\);/s,
    "conversation-flow controller should drain only after a previous non-idle status and while not paused",
  );
  assert.match(
    queueDrainControllerSource,
    /options\.handleSessionStatusMapChanged\(statuses, previousStatuses\);/,
    "queue drain controller should report status-map changes to the conversation-flow facade",
  );
  assert.match(
    conversationFlowSource,
    /const sessionId = deps\.sessionKeys\.sessionIdForQueueKey\(sessionKey\);[\s\S]*if \(!sessionId\) continue;[\s\S]*statusForQueueKey\(sessionKey, previousStatuses\)[\s\S]*statusForQueueKey\(sessionKey, statuses\)/s,
    "background queue status checks should resolve scoped UI keys back to raw session ids in the owner",
  );
  assert.doesNotMatch(
    sessionSource,
    /drainNextQueuedDraft\(/,
    "SessionView effects should not directly drive queued draft drains",
  );
});

test("queued drain uses a stable session key and guards stale navigation", () => {
  assert.match(
    source,
    /const queueDrainAttemptInFlightBySessionKey = new Set<string>\(\);/,
    "queue drain in-flight state should be scoped per session key",
  );
  assert.doesNotMatch(
    source,
    /let queueDrainAttemptInFlight = false;/,
    "queue drain in-flight state must not be a single global lock",
  );
  assert.match(
    flowDrainSource,
    /const start = resolveQueueDrainStart\(\{[\s\S]*sessionKey: drainSessionKey,[\s\S]*inFlight: queueDrainAttemptInFlightBySessionKey\.has\(drainSessionKey\),[\s\S]*queuePaused: deps\.queue\.queuePausedForSessionKey\(drainSessionKey\),[\s\S]*item,[\s\S]*\}\);[\s\S]*queueDrainAttemptInFlightBySessionKey\.add\(drainSessionKey\)[\s\S]*queueDrainAttemptInFlightBySessionKey\.delete\(drainSessionKey\)/s,
    "queue drain should delegate start guards and lock only the captured session key being drained",
  );

  assert.match(
    conversationFlowSource,
    /const baseSessionKey = expectedSessionKey \?\? deps\.sessionKeys\.currentSessionQueueKey\(\);\s*const targetSessionId = deps\.sessionKeys\.sessionIdForQueueKey\(baseSessionKey\);[\s\S]*const expectedWorkspaceId =[\s\S]*deps\.sessionKeys\.workspaceIdForQueueKey\(baseSessionKey\) \|\| deps\.sessionKeys\.activeWorkspaceId\(\);[\s\S]*expectedSessionKey &&[\s\S]*deps\.sessionKeys\.currentSessionQueueKey\(\) !== expectedSessionKey &&[\s\S]*!targetSessionId/s,
    "immediate sends should target the captured real session key but refuse stale pending queues",
  );

  assert.match(
    flowDrainSource,
    /const submitResult = await controller\.sendPromptImmediate\(start\.item\.draft, \{[\s\S]*reason,[\s\S]*expectedSessionKey: drainSessionKey,[\s\S]*\}\);/,
    "queue drains should pass their captured session key to the immediate send path",
  );

  assert.match(
    flowSendImmediateSource,
    /const promptSendOptions: SessionSendOptionsBase & \{[\s\S]*clientMessageId,[\s\S]*origin,[\s\S]*source,[\s\S]*\.\.\.\(targetSessionId \? \{ targetSessionId \} : \{\}\),[\s\S]*\.\.\.\(options\.sendTraceId \? \{ sendTraceId: options\.sendTraceId \} : \{\}\),[\s\S]*deps\.transport\.sendPromptAsync\(draft, promptSendOptions\)/s,
    "queue drains should pass their captured target session, source, and trace id to the parent send path",
  );

  assert.match(
    flowSendImmediateSource,
    /if \(\s*options\.expectedSessionKey &&\s*deps\.sessionKeys\.currentSessionQueueKey\(\) !== options\.expectedSessionKey\s*\) \{\s*return submitResult;\s*\}[\s\S]*deps\.runState\.startRun\(/,
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
    conversationFlowSource,
    /export const remapPendingQueueToSession = <T>\([\s\S]*const pendingQueue = current\[pending\] \?\? \[\];[\s\S]*const existingRealQueue = current\[real\] \?\? \[\];[\s\S]*\[real\]: \[\.\.\.existingRealQueue, \.\.\.pendingQueue\],[\s\S]*\};/s,
    "pending queue remap should append pending drafts behind any existing real-session queue",
  );
  assert.match(
    sessionSource,
    /setQueuedDraftsBySessionKey\(\(current\) =>\s*remapPendingQueueToSessionRecord\(current, pendingKey, sessionKey\),\s*\);/s,
    "session view should wire pending queue remaps through the conversation-flow helper",
  );

  assert.match(
    conversationFlowSource,
    /export const remapQueuePausedToSession = \([\s\S]*const pendingPaused = Boolean\(current\[pending\]\);[\s\S]*return \{[\s\S]*\[real\]: pendingPaused \|\| Boolean\(current\[real\]\),[\s\S]*\};/s,
    "pending queue pause state should remap to the real-session key without clearing an existing real pause",
  );
  assert.match(
    sessionSource,
    /setQueuePausedAfterStopBySessionKey\(\(current\) =>\s*remapQueuePausedToSession\(current, pendingKey, sessionKey\),\s*\);/s,
    "session view should wire pending pause remaps through the conversation-flow helper",
  );
});

test("session queue keys follow the UI conversation workspace scope", () => {
  assert.match(
    source,
    /activeUiConversationRef\?: UiConversationRef;/,
    "session props should accept the UI conversation scope used by the app-level selection controller",
  );

  assert.match(
    conversationFlowSource,
    /export const resolveActiveUiConversationWorkspaceId = \(\{[\s\S]*activeUiConversationRef\?\.workspaceId\?\.trim\(\) \|\| activeWorkspaceId \|\| "default";/,
    "session queue keys should prefer the visible conversation workspace over the active workspace fallback",
  );

  assert.match(
    conversationFlowSource,
    /export const resolveWorkspaceIdForSessionQueue = \([\s\S]*ref\.sessionId\?\.trim\(\)[\s\S]*ref\.conversationId\?\.trim\(\)[\s\S]*ref\.opencodeSessionId\?\.trim\(\)[\s\S]*return ref\.workspaceId\?\.trim\(\) \|\| resolveActiveUiConversationWorkspaceId\(context\);[\s\S]*\};/s,
    "real session queue keys should stay anchored to the scoped visible conversation across send-time workspace activation",
  );

  assert.match(
    sessionSource,
    /const activeUiConversationWorkspaceId = \(\) =>\s*resolveActiveUiConversationWorkspaceId\(queueKeyContext\(\)\);[\s\S]*const workspaceIdForSessionQueue = \(sessionId: string\) =>\s*resolveWorkspaceIdForSessionQueue\(queueKeyContext\(\), sessionId\);/s,
    "session view should wire scoped queue key resolution through the conversation-flow helper",
  );

  assert.match(
    appViewPropsSource,
    /activeUiConversationRef: activeUiConversationRef\(\),/,
    "app should pass the scoped visible conversation identity into SessionView",
  );
});

test("normal sends from a browsed real session pass the current scoped target session", () => {
  assert.match(
    conversationFlowSource,
    /const baseSessionKey = expectedSessionKey \?\? deps\.sessionKeys\.currentSessionQueueKey\(\);\s*const targetSessionId = deps\.sessionKeys\.sessionIdForQueueKey\(baseSessionKey\);/s,
    "normal sends should derive targetSessionId from the current scoped session key when no expected queue key is provided",
  );

  assert.doesNotMatch(
    source,
    /const targetSessionId = expectedSessionKey \? sessionIdForQueueKey\(expectedSessionKey\) : null;/,
    "normal sends from historical scoped sessions must not drop targetSessionId to null",
  );

  assert.match(
    flowSendImmediateSource,
    /const promptSendOptions: SessionSendOptionsBase & \{[\s\S]*source,[\s\S]*\.\.\.\(targetSessionId \? \{ targetSessionId \} : \{\}\),[\s\S]*deps\.transport\.sendPromptAsync\(draft, promptSendOptions\)/s,
    "the resolved target session and source should be forwarded to the app send path",
  );
});

test("accepted first pending submit captures and remaps the pending queue key", () => {
  assert.match(
    source,
    /const \[pendingQueueKeyAwaitingSessionIdByBaseKey, setPendingQueueKeyAwaitingSessionIdByBaseKey\] =\s*createSignal<Record<string, string>>\(\{\}\);/,
    "session view should retain a captured pending queue key until a real session id is available",
  );

  assert.match(
    flowSendImmediateSource,
    /const handoffScope = resolvePendingSessionHandoffScope\(\{[\s\S]*baseSessionKey,[\s\S]*targetSessionId,[\s\S]*pendingSessionQueueKey: deps\.sessionKeys\.pendingSessionQueueKey\(\),[\s\S]*createPendingSessionInstanceId: deps\.identity\.createPendingSessionInstanceId,[\s\S]*\}\);[\s\S]*pendingSessionBaseKeyBeforeHandoff,[\s\S]*sessionKey,[\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*= handoffScope;[\s\S]*deps\.pendingHandoff\.setPendingQueueKeyAwaitingSessionIdForBaseKey\([\s\S]*pendingSessionBaseKeyBeforeHandoff,[\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*\);[\s\S]*const materializePendingHandoffToSession = \([\s\S]*handoff: MaterializedSessionHandoff \| null \| undefined,[\s\S]*materializationClientMessageId = clientMessageId,[\s\S]*resolvePendingSessionHandoffMaterialization\(\{[\s\S]*pendingSessionBaseKeyBeforeHandoff,[\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*clientMessageId: materializationClientMessageId,[\s\S]*handoff,[\s\S]*\}\);[\s\S]*materializedPendingSessionTarget\.current = \{[\s\S]*sessionId: materializedSessionId,[\s\S]*sessionKey: materializedSessionKey,[\s\S]*\};[\s\S]*deps\.pendingHandoff\.setPendingQueueKeyAwaitingSessionIdForBaseKey\([\s\S]*pendingSessionBaseKey,[\s\S]*materializedSessionKey,[\s\S]*\);[\s\S]*deps\.pendingHandoff\.remapPendingQueueToSession\([\s\S]*pendingSessionKey,[\s\S]*materializedSessionId,[\s\S]*materializedSessionKey,[\s\S]*\);/s,
    "sendPromptImmediate should capture the pending queue key before await and remap it after an accepted first submit only from the captured handoff",
  );
  assert.match(
    conversationFlowSource,
    /const pendingSessionMaterializationFlightByKey = new Map<[\s\S]*PendingSessionMaterializationFlight[\s\S]*>\(\);/s,
    "conversation flow should retain one in-flight materialization per pending session key",
  );
  assert.match(
    flowSendImmediateSource,
    /const existingFlight = pendingSessionMaterializationFlightByKey\.get\([\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*\);[\s\S]*const outcome = await existingFlight\.promise;[\s\S]*const materializedTarget = materializePendingHandoffToSession\([\s\S]*outcome\.handoff,[\s\S]*outcome\.handoff\.clientMessageId\?\.trim\(\) \|\| clientMessageId,[\s\S]*\);[\s\S]*transportTargetSessionId = materializedTarget\.sessionId;/s,
    "queued first sends should await and adopt the same pending-session handoff instead of creating another conversation",
  );
  assert.doesNotMatch(
    flowSendImmediateSource,
    /materializedSessionIdFromHandoff \?\? deps\.sessionKeys\.selectedSessionId\(\)\?\.trim\(\)/,
    "accepted first-submit materialization must not guess from the currently selected session",
  );
  assert.match(
    flowSendImmediateSource,
    /queueKeysShareWorkspace\([\s\S]*pendingSessionKey[\s\S]*materializedSessionKey[\s\S]*sendPromptImmediate:materialized-handoff:blocked-workspace-mismatch/s,
    "accepted first-submit materialization should reject cross-workspace handoffs",
  );

  assert.match(
    queueDrainControllerSource,
    /options\.handleSelectedSessionChanged\(\{[\s\S]*pendingBaseKey,[\s\S]*pendingKey,[\s\S]*sessionStatusById: options\.sessionStatusById\(\),[\s\S]*\}\);/s,
    "queue drain controller should notify the owner when the selected session id arrives in a later reactive update",
  );
  assert.match(
    conversationFlowSource,
    /if \([\s\S]*pendingKey[\s\S]*!isPendingSessionInstanceKey\(selectedSessionId\)[\s\S]*queueKeysShareWorkspace\(deps\.sessionKeys\.workspaceIdForQueueKey, pendingKey, sessionKey\)[\s\S]*deps\.pendingHandoff\.remapPendingQueueToSession\(pendingKey, selectedSessionId\);[\s\S]*deps\.pendingHandoff\.clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingBaseKey, pendingKey\);[\s\S]*blocked-workspace-mismatch/s,
    "conversation-flow controller should remap pending queues only when the materialized session is in the same workspace",
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
    conversationFlowSource,
    /if \(accepted\) return \{ kind: "remove", sessionKey: queuedDraftSessionKey \};/,
    "accepted pending queue drains should resolve to removing the sent item from whichever queue currently contains it",
  );
  assert.match(
    flowDrainSource,
    /const result = resolveQueueDrainCompletionAction\(\{[\s\S]*queuedDraftSessionKey: deps\.queue\.resolveQueueKeyForQueuedDraft\([\s\S]*drainSessionKey,[\s\S]*start\.item\.id,[\s\S]*\),[\s\S]*\}\);[\s\S]*if \(result\.kind === "remove"\) \{[\s\S]*deps\.queue\.updateQueueForSessionKey\([\s\S]*result\.sessionKey,[\s\S]*\(queue\) => removeQueuedDraft\(queue, start\.item\.id\),[\s\S]*\);[\s\S]*\}/s,
    "conversation flow should apply accepted queue-drain removal to the queue key resolved by the helper",
  );
});

test("failed first pending submit restores remapped queued drafts to the pending key", () => {
  assert.match(
    conversationFlowSource,
    /export const restoreMaterializedQueueToPending = <T>\([\s\S]*const materializedQueue = current\[real\] \?\? \[\];[\s\S]*const existingPendingQueue = current\[pending\] \?\? \[\];[\s\S]*\[pending\]: \[\.\.\.existingPendingQueue, \.\.\.materializedQueue\],[\s\S]*\};/s,
    "session view should be able to move queued follow-up drafts back from the materialized session key",
  );
  assert.match(
    sessionSource,
    /setQueuedDraftsBySessionKey\(\(current\) =>\s*restoreMaterializedQueueToPendingRecord\(current, pendingKey, sessionKey\),\s*\);/s,
    "session view should wire materialized queue restores through the conversation-flow helper",
  );

  assert.match(
    conversationFlowSource,
    /let materializedSessionIdToRestore: string \| null = null;[\s\S]*const result = markMatchingPendingSubmittedDraftFailed\(\{[\s\S]*materializedSessionIdFromHandoff,[\s\S]*\}\);[\s\S]*materializedSessionIdToRestore = result\.materializedSessionIdToRestore;[\s\S]*deps\.pendingHandoff\.restoreMaterializedQueueToPending\([\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*materializedSessionIdToRestore,[\s\S]*\);/s,
    "failed pending submit should restore any remapped queued drafts before returning to the pending draft route",
  );
});

test("rejected pending queue drain updates the remapped item key", () => {
  assert.match(
    flowDrainSource,
    /if \(\s*shouldRestoreQueuedDraftForStalePendingDrain\(\{[\s\S]*currentSessionKey: deps\.sessionKeys\.currentSessionQueueKey\(\),[\s\S]*drainSessionKey,[\s\S]*drainSessionId: deps\.sessionKeys\.sessionIdForQueueKey\(drainSessionKey\),[\s\S]*\}\)\s*\) \{[\s\S]*const queuedSessionKey = deps\.queue\.resolveQueueKeyForQueuedDraft\([\s\S]*drainSessionKey,[\s\S]*start\.item\.id,[\s\S]*\);[\s\S]*markQueuedDraftQueued\(queue, start\.item\.id\)/s,
    "queued fallback before send should restore the item in whichever queue currently contains it",
  );

  assert.match(
    conversationFlowSource,
    /return \{ kind: "mark-error", sessionKey: queuedDraftSessionKey \};/,
    "rejected active queue drains should resolve to mark-error on the current owner key",
  );
  assert.match(
    flowDrainSource,
    /else \{[\s\S]*deps\.queue\.updateQueueForSessionKey\([\s\S]*result\.sessionKey,[\s\S]*\(queue\) =>[\s\S]*markQueuedDraftError\([\s\S]*queue,[\s\S]*start\.item\.id,[\s\S]*deps\.runtime\.error\(\) \?\? deps\.feedback\.tr\("session\.connect_server_to_attach"\),[\s\S]*\),[\s\S]*\);[\s\S]*\}/s,
    "rejected queue drains should mark the remapped queued item as error instead of updating the stale pending key",
  );
});

test("app prompt send accepts an explicit target session without freezing model bootstrap", () => {
  const sendStart = sendWorkflowSource.indexOf("async function sendPrompt");
  const targetCapture = sendWorkflowSource.indexOf("const explicitTargetSessionId = deps.isPendingSessionInstanceKey(", sendStart);
  const bridgePrepare = sendWorkflowSource.indexOf("conversationRunCompatibilityBridge.prepare({", targetCapture);
  const bridgeSubmit = sendWorkflowSource.indexOf("conversationRunCompatibilityBridge.submit({", bridgePrepare);
  const bridgeSource = conversationRunCompatibilityBridgeSource();

  assert.notEqual(sendStart, -1, "app sendPrompt should exist");
  assert.ok(targetCapture > sendStart, "sendPrompt should accept a captured target session id");
  assert.match(
    sendWorkflowSource.slice(targetCapture, bridgePrepare),
    /let sessionID = explicitTargetSessionId \|\| selectedRealSessionId;/,
    "sendPrompt should prefer an explicit target session over implicit active-workspace selection",
  );
  assert.ok(bridgePrepare > targetCapture, "compatibility bridge prepare should run after the explicit target is captured");
  assert.ok(bridgeSubmit > bridgePrepare, "compatibility bridge submit should run after prepare for the compatibility run path");
  assert.match(
    sendWorkflowSource.slice(bridgePrepare, bridgeSubmit),
    /sendTargetWorkspace,/,
    "sendPrompt should pass the snapshotted target workspace into compatibility bridge prepare",
  );
  assert.match(
    sendWorkflowSource.slice(bridgeSubmit),
    /sendTargetWorkspace,/,
    "sendPrompt should pass the snapshotted target workspace into compatibility bridge submit",
  );
  assert.match(
    bridgeSource,
    /await deps\.prepareSendRuntimeForSend\(\s*"sendPrompt",\s*input\.sendPreflight,\s*\);[\s\S]*const c = deps\.routedClientForSendTarget\(input\.sendTargetWorkspace\);/,
    "compatibility bridge should prepare the target runtime before reading its routed client",
  );
  assert.match(
    bridgeSource,
    /const model =\s*input\.modelOverride \?\? deps\.modelForSession\(materializedSessionID\);[\s\S]*const agent = deps\.agentForSession\(sessionID\);/,
    "compatibility bridge should resolve model and agent after the prepared compatibility handoff begins",
  );
});

test("queued edit lifecycle restores editing items and drains idle saves", () => {
  assert.match(
    conversationFlowSource,
    /restoreEditingQueuedDraft: \(sessionKey, id\) => \{\s*if \(!id\) return;\s*deps\.queue\.updateQueueForSessionKey\(sessionKey, \(queue\) => restoreQueuedDraftAfterEditing\(queue, id\)\);\s*\}/,
    "conversation-flow controller should restore an editing queued draft to its original state",
  );

  assert.match(
    conversationFlowSource,
    /const currentEditingId = deps\.queue\.editingQueuedDraftId\(\);\s*if \(currentEditingId && currentEditingId !== id\) \{\s*controller\.restoreEditingQueuedDraft\(deps\.sessionKeys\.currentSessionQueueKey\(\), currentEditingId\);\s*\}/,
    "editing a second queued item should restore the previous editing item in the conversation-flow controller",
  );

  assert.match(
    sessionSource,
    /const handleEditQueuedDraft = \(id: string\) => \{\s*sessionFlowFacade\.handleEditQueuedDraft\(id\);\s*\};[\s\S]*const handleCancelQueuedDraft = \(id: string\) => \{\s*sessionFlowFacade\.handleCancelQueuedDraft\(id\);\s*\};[\s\S]*const handleRetryQueuedDraft = \(id: string\) => \{\s*sessionFlowFacade\.handleRetryQueuedDraft\(id\);\s*\};[\s\S]*const handleMoveQueuedDraft = \(id: string, targetIndex: number\) => \{\s*sessionFlowFacade\.handleMoveQueuedDraft\(id, targetIndex\);\s*\};/s,
    "session view queue edit callbacks should delegate to the session flow facade",
  );

  assert.match(
    conversationFlowSource,
    /handleSessionSwitchEditState: \(previousSessionId\) => \{\s*const previousEditingQueuedDraftId = deps\.queue\.editingQueuedDraftId\(\);[\s\S]*controller\.restoreEditingQueuedDraft\([\s\S]*deps\.sessionKeys\.sessionQueueKeyForSessionId\(previousSessionId\),[\s\S]*previousEditingQueuedDraftId,[\s\S]*\);[\s\S]*deps\.composer\.clearComposerDraftForSession\(previousSessionId\);[\s\S]*deps\.queue\.setEditingQueuedDraftId\(null\);[\s\S]*deps\.transcriptEdit\.setEditingTranscriptMessageId\(null\);[\s\S]*\}/,
    "switching sessions should restore the previous queued edit item and clear its composer draft in the controller",
  );
  assert.match(
    queueDrainControllerSource,
    /options\.handleSelectedSessionChanged\(\{[\s\S]*previousSessionId,[\s\S]*\}\);/s,
    "queue drain controller selected-session effect should delegate edit-state cleanup through the controller facade",
  );
  assert.match(
    conversationFlowSource,
    /handleSelectedSessionChanged: \([\s\S]*\) => \{[\s\S]*controller\.handleSessionSwitchEditState\(previousSessionId\);/s,
    "selected-session controller should run edit-state cleanup before queue handoff decisions",
  );

  assert.match(
    flowHandleSendSource,
    /if \(!deps\.runState\.showRunIndicator\(\) && !deps\.queue\.queuePausedForSessionKey\(sessionKey\)\) \{\s*void controller\.drainNextQueuedDraft\("normal", sessionKey\);\s*\}/,
    "saving an edited queued draft while idle should resume draining",
  );
});

test("queued message retry stays scoped to the local queue head", () => {
  assert.match(
    conversationFlowSource,
    /handleRetryQueuedDraft: \(id\) => \{\s*const sessionKey = deps\.sessionKeys\.currentSessionQueueKey\(\);\s*const queue = deps\.queue\.queuedDrafts\(\);[\s\S]*if \(!item \|\| item\.state !== "error" \|\| queue\[0\]\?\.id !== id\) return false;[\s\S]*markQueuedDraftQueued\(queue, id\)[\s\S]*void controller\.drainNextQueuedDraft\("normal", sessionKey\);/s,
    "Retry should only release a local error head and drain its captured session",
  );
  assert.match(
    sessionSource,
    /<QueuedMessageList[\s\S]*onRetry=\{handleRetryQueuedDraft\}[\s\S]*onMove=\{handleMoveQueuedDraft\}/s,
    "the session view should pass retry only to the local queued-message list",
  );
});

test("edited queued send-now marks the edited item sending before awaiting handoff", () => {
  assert.match(
    flowHandleSendSource,
    /const sessionKey = deps\.sessionKeys\.currentSessionQueueKey\(\);\s*const wasPaused = deps\.queue\.queuePausedForSessionKey\(sessionKey\);\s*const editedItem = deps\.queue\.queuedDrafts\(\)\.find\(\(item\) => item\.id === editingId\);\s*const clientMessageId = deps\.identity\.createClientMessageId\(\);[\s\S]*?deps\.queue\.updateQueueForSessionKey\(sessionKey, \(queue\) =>\s*markQueuedDraftSending\([\s\S]*?updateQueuedDraft\(queue, editingId, draft, deps\.identity\.now\(\), \{\s*clientMessageId,[\s\S]*?\}\),[\s\S]*?\),\s*\);[\s\S]*?const submitResult = await controller\.sendPromptImmediate\(draft, \{\s*reason: "send-now",\s*expectedSessionKey: sessionKey,\s*clientMessageId,\s*restoreDraftOnFailure: false,[\s\S]*?modelOverride: options\.modelOverride,\s*onDraftTransferred: acknowledgeDraftTransfer,\s*\}\);/s,
    "edited queued send-now should persist the edited draft into a sending queue item and release the composer before awaiting handoff",
  );
});

test("edited queued send-now marks the edited item error when handoff is rejected", () => {
  assert.match(
    flowHandleSendSource,
    /const submitResult = await controller\.sendPromptImmediate\(draft, \{\s*reason: "send-now",\s*expectedSessionKey: sessionKey,\s*clientMessageId,\s*restoreDraftOnFailure: false,[\s\S]*?modelOverride: options\.modelOverride,\s*onDraftTransferred: acknowledgeDraftTransfer,\s*\}\);\s*const resultSessionKey = deps\.queue\.resolveQueueKeyForQueuedDraft\(sessionKey, editingId\);\s*if \(!sessionSubmitWasAccepted\(submitResult\)\) \{\s*deps\.queue\.updateQueueForSessionKey\(resultSessionKey, \(queue\) =>\s*markQueuedDraftError\(\s*queue,\s*editingId,\s*submitResult\.message \?\? deps\.runtime\.error\(\) \?\? deps\.feedback\.tr\("session\.connect_server_to_attach"\),\s*\),\s*\);\s*return submitResult;\s*\}\s*deps\.queue\.updateQueueForSessionKey\(resultSessionKey, \(queue\) => removeQueuedDraft\(queue, editingId\)\);[\s\S]*if \(wasPaused\) \{\s*deps\.queue\.setQueuePausedForSessionKey\(sessionKey, false\);\s*\}/s,
    "edited queued send-now should update whichever queue contains the edited item after a pending remap",
  );
});

test("cancelRun marks the current queue paused before aborting", () => {
  const cancelStart = conversationFlowSource.indexOf("cancelRun: async () => {");
  const pauseCall = conversationFlowSource.indexOf("deps.queue.setQueuePausedForSessionKey(sessionKey, true);", cancelStart);
  const abortCall = conversationFlowSource.indexOf("await deps.runControl.abortSession(selectedSessionId);", cancelStart);

  assert.notEqual(cancelStart, -1, "cancelRun should exist");
  assert.ok(pauseCall > cancelStart, "cancelRun should pause the current queue");
  assert.ok(abortCall > pauseCall, "queue pause should happen before the abort request resolves");
  assert.match(
    sessionSource,
    /const cancelRun = async \(\) => \{\s*await sessionFlowFacade\.cancelRun\(\);\s*\};/,
    "session view cancel callback should delegate to the session flow facade",
  );
});

test("queued message list renders above the composer", () => {
  const queueList = source.indexOf("<QueuedMessageList");
  const composer = source.indexOf("<Composer", queueList);

  assert.ok(queueList !== -1, "session should render the queued message list");
  assert.ok(composer > queueList, "queued message list should render above the composer");
});
