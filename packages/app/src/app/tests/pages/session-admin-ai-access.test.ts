import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const conversationFlowSource = readFileSync(new URL("../../pages/session-conversation-flow.ts", import.meta.url), "utf8");
const source = `${sessionSource}\n${conversationFlowSource}`;
const flowSendImmediateStart = conversationFlowSource.indexOf("sendPromptImmediate: async (");
const flowSendImmediateEnd = conversationFlowSource.indexOf("export type RunBaseline", flowSendImmediateStart);
const flowSendImmediateSource = conversationFlowSource.slice(flowSendImmediateStart, flowSendImmediateEnd);

test("session blocks prompt sending when admin-managed ai access is unavailable", () => {
  assert.match(conversationFlowSource, /if\s*\(aiAccessSubmitBlockedReason\)\s*\{/s);
  assert.match(conversationFlowSource, /deps\.feedback\.setToastMessage\(aiAccessSubmitBlockedReason\)/);
  assert.match(sessionSource, /Show when=\{visibleAiAccessBlockedReason\(\)\}/);
  assert.doesNotMatch(source, /ProviderAuthModal/);
});

test("ai access blocking keeps the submitted draft as a failed pending message", () => {
  const handlerStart = 0;
  const pendingCreate = flowSendImmediateSource.indexOf("createPendingSubmittedDraft({", handlerStart);
  const aiAccessBlock = flowSendImmediateSource.indexOf("if (aiAccessSubmitBlockedReason) {", handlerStart);
  const aiAccessBranchEnd = flowSendImmediateSource.indexOf("return false;", aiAccessBlock);
  const aiAccessBranch = flowSendImmediateSource.slice(aiAccessBlock, aiAccessBranchEnd);

  assert.notEqual(flowSendImmediateStart, -1, "sendPromptImmediate should exist in the conversation-flow controller");
  assert.ok(pendingCreate > handlerStart, "normal sends should create pending submit state");
  assert.ok(
    aiAccessBlock > pendingCreate,
    "ai access blocking should happen after the pending submit message exists because Composer has already released the draft",
  );
  assert.match(
    aiAccessBranch,
    /markMatchingPendingSubmitFailed\(aiAccessSubmitBlockedReason\);/,
    "ai access blocking should leave the submitted draft visible as a failed pending message",
  );
});

test("transient ai access loading is not treated as a permanent submit blocker", () => {
  assert.match(
    conversationFlowSource,
    /import\s+\{\s*resolveActionableAiAccessBlockedReason\s*\}\s+from\s+"..\/lib\/ai-access";/,
    "conversation flow should classify actionable AI access blocks by helper",
  );
  assert.match(
    flowSendImmediateSource,
    /const aiAccessSubmitBlockedReason = resolveActionableAiAccessBlockedReason\(\s*aiAccessBlockedReason,\s*deps\.feedback\.tr,\s*\);/s,
    "transient loading should share the same actionable blocked reason helper as visible UI",
  );
  assert.match(
    flowSendImmediateSource,
    /if \(aiAccessSubmitBlockedReason\) \{/,
    "only permanent ai access failures should block submit inside the conversation flow",
  );
});

test("transient ai access loading does not lock the composer", () => {
  assert.match(
    source,
    /import\s+\{[^}]*isAiAccessLoadingMessage[^}]*\}\s+from\s+"..\/lib\/ai-access";/,
    "session should distinguish transient ai access loading from permanent admin blocks",
  );
  assert.match(
    source,
    /const aiAccessLoading = createMemo\(\(\) => isAiAccessLoadingMessage\(props\.aiAccessBlockedReason, tr\)\);/,
    "session should expose localized transient ai access loading as a readiness state",
  );
  assert.match(
    sessionSource,
    /const aiAccessLoadingWithoutMessages = createMemo\(\(\) =>\s*aiAccessLoading\(\) && displayedEffectiveMessages\(\)\.length === 0\s*\);/s,
    "session should keep a trace-only marker for loading before the first transcript message",
  );
  assert.match(
    sessionSource,
    /const composerBusy = createMemo\(\(\) => props\.busy\);/,
    "composer busy should only reflect app/run busy state",
  );
  const centerComposerStart = sessionSource.indexOf('entryPlacement="center"');
  const centerComposerBusy = sessionSource.indexOf("busy={composerBusy()}", centerComposerStart);
  const footerComposerBusy = sessionSource.indexOf("busy={composerBusy()}", centerComposerBusy + 1);
  assert.ok(centerComposerBusy > centerComposerStart, "center composer should use the shared composer busy gate");
  assert.ok(footerComposerBusy > centerComposerBusy, "footer composer should use the shared composer busy gate");
  assert.doesNotMatch(
    sessionSource,
    /busy=\{props\.busy \|\| aiAccessLoading\(\)\}/,
    "transient ai access loading must not globally lock the composer after messages exist",
  );
  assert.doesNotMatch(
    sessionSource,
    /busy=\{[^}]*aiAccessLoading/,
    "transient ai access loading must not disable send from either composer placement",
  );
});

test("transient ai access loading is hidden from the visible session strip", () => {
  assert.match(
    sessionSource,
    /const visibleAiAccessBlockedReason = createMemo\(\(\) =>\s*resolveActionableAiAccessBlockedReason\(props\.aiAccessBlockedReason, tr\)\s*\);/s,
    "session should filter transient loading out of the visible AI access strip",
  );
  assert.match(
    sessionSource,
    /<Show when=\{visibleAiAccessBlockedReason\(\)\}>[\s\S]*\{visibleAiAccessBlockedReason\(\)\}[\s\S]*<\/Show>/,
    "session should still render permanent AI access blocks through the visible reason",
  );
  assert.doesNotMatch(
    sessionSource,
    /<Show when=\{props\.aiAccessBlockedReason\}>/,
    "session should not show the transient loading reason directly",
  );
});

test("session ui trace records ai access composer busy inputs", () => {
  assert.match(
    sessionSource,
    /"appBusy",\s*"composerBusy",\s*"aiAccessLoading",\s*"aiAccessLoadingWithoutMessages",\s*"aiAccessBlockedReason",\s*"visibleAiAccessBlockedReason",/s,
    "state-change tracing should list the composer busy and visible ai access fields",
  );
  assert.match(
    sessionSource,
    /appBusy: state\[\d+\],[\s\S]*composerBusy: state\[\d+\],[\s\S]*aiAccessLoading: state\[\d+\],[\s\S]*aiAccessLoadingWithoutMessages: state\[\d+\],[\s\S]*aiAccessBlockedReason: state\[\d+\],[\s\S]*visibleAiAccessBlockedReason: state\[\d+\],/s,
    "state-change tracing should emit the composer busy and visible ai access values",
  );
});
