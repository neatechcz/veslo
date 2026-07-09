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
  assert.match(sessionSource, /Show when=\{props\.aiAccessBlockedReason\}/);
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
    /import\s+\{\s*isAiAccessLoadingMessage\s*\}\s+from\s+"..\/lib\/ai-access";/,
    "conversation flow should classify transient loading by helper",
  );
  assert.match(
    flowSendImmediateSource,
    /const aiAccessSubmitBlockedReason = isAiAccessLoadingMessage\(aiAccessBlockedReason, deps\.feedback\.tr\)\s*\?\s*null\s*:\s*aiAccessBlockedReason;/,
    "transient loading should not depend on English display text",
  );
  assert.match(
    flowSendImmediateSource,
    /if \(aiAccessSubmitBlockedReason\) \{/,
    "only permanent ai access failures should block submit inside the conversation flow",
  );
});

test("transient ai access loading disables composer send before the draft is released", () => {
  assert.match(
    source,
    /import\s+\{\s*isAiAccessLoadingMessage\s*\}\s+from\s+"..\/lib\/ai-access";/,
    "session should distinguish transient ai access loading from permanent admin blocks",
  );
  assert.match(
    source,
    /const aiAccessLoading = createMemo\(\(\) => isAiAccessLoadingMessage\(props\.aiAccessBlockedReason, tr\)\);/,
    "session should expose localized transient ai access loading as a readiness state",
  );
  assert.match(
    source,
    /<Composer[\s\S]*busy=\{props\.busy \|\| aiAccessLoading\(\)\}[\s\S]*onSend=\{handleSendPrompt\}/,
    "composer should stay locked while managed ai access is still loading so it cannot clear the first prompt draft",
  );
});
