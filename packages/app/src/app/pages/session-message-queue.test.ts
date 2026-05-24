import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

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
    /if \(queuePaused\(\) && !sendNow\) \{\s*appendDraftToCurrentQueue\(draft\);\s*setQueuePausedForCurrentSession\(false\);\s*void drainNextQueuedDraft\("normal"\);\s*return true;\s*\}/s,
    "plain Enter while paused should append, unpause, and start draining the first queued item",
  );
});

test("paused send-now unpauses only after accepted immediate send", () => {
  assert.match(
    source,
    /const accepted = await sendPromptImmediate\(draft, \{ reason: "send-now" \}\);\s*if \(accepted && wasPaused\) \{\s*setQueuePausedForCurrentSession\(false\);\s*\}\s*return accepted;/s,
    "send-now while paused should unpause only after the immediate send is accepted",
  );
});

test("idle transition drains only after a non-idle status and only when queue is not paused", () => {
  assert.match(
    source,
    /createEffect\(\s*on\(\s*\(\) => props\.sessionStatus,\s*\(status, previousStatus\) => \{\s*if \(previousStatus === undefined \|\| previousStatus === "idle" \|\| status !== "idle"\) return;\s*if \(queuePaused\(\)\) return;\s*void drainNextQueuedDraft\("queue-drain"\);/s,
    "idle transitions should drain only after a previous non-idle status and while not paused",
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
