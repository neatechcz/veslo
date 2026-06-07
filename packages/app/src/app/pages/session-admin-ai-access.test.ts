import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session blocks prompt sending when admin-managed ai access is unavailable", () => {
  assert.match(source, /if\s*\(props\.aiAccessBlockedReason\)\s*\{/s);
  assert.match(source, /setToastMessage\(props\.aiAccessBlockedReason\)/);
  assert.match(source, /Show when=\{props\.aiAccessBlockedReason\}/);
  assert.doesNotMatch(source, /ProviderAuthModal/);
});

test("ai access blocking keeps the submitted draft as a failed pending message", () => {
  const handlerStart = source.indexOf("const sendPromptImmediate = async (");
  const pendingCreate = source.indexOf("createPendingSubmittedDraft({", handlerStart);
  const aiAccessBlock = source.indexOf("if (props.aiAccessBlockedReason) {", handlerStart);
  const aiAccessBranchEnd = source.indexOf("return false;", aiAccessBlock);
  const aiAccessBranch = source.slice(aiAccessBlock, aiAccessBranchEnd);

  assert.notEqual(handlerStart, -1, "sendPromptImmediate should exist");
  assert.ok(pendingCreate > handlerStart, "normal sends should create pending submit state");
  assert.ok(
    aiAccessBlock > pendingCreate,
    "ai access blocking should happen after the pending submit message exists because Composer has already released the draft",
  );
  assert.match(
    aiAccessBranch,
    /markMatchingPendingSubmitFailed\(props\.aiAccessBlockedReason\);/,
    "ai access blocking should leave the submitted draft visible as a failed pending message",
  );
});

test("transient ai access loading disables composer send before the draft is released", () => {
  assert.match(
    source,
    /import\s+\{\s*AI_ACCESS_LOADING_MESSAGE\s*\}\s+from\s+"..\/lib\/ai-access";/,
    "session should distinguish transient ai access loading from permanent admin blocks",
  );
  assert.match(
    source,
    /const aiAccessLoading = createMemo\(\(\) => props\.aiAccessBlockedReason === AI_ACCESS_LOADING_MESSAGE\);/,
    "session should expose transient ai access loading as a readiness state",
  );
  assert.match(
    source,
    /<Composer[\s\S]*busy=\{props\.busy \|\| aiAccessLoading\(\)\}[\s\S]*onSend=\{handleSendPrompt\}/,
    "composer should stay locked while managed ai access is still loading so it cannot clear the first prompt draft",
  );
});
