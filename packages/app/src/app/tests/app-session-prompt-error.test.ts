import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pages/session-send-workflow.ts", import.meta.url), "utf8");

function conversationRunCompatibilityBridgeSubmitSource(): string {
  const fallbackStart = source.indexOf("export function createConversationRunCompatibilityBridge(");
  const submitStart = source.indexOf("  const submit = async", fallbackStart);
  const fallbackEnd = source.indexOf("export function createSessionSendWorkflow(", submitStart);
  assert.ok(submitStart >= 0 && fallbackEnd > submitStart, "compatibility bridge submit source should be present");
  return source.slice(submitStart, fallbackEnd);
}

test("prompt send failures only update the still-displayed conversation error state", () => {
  const fallbackSubmitSource = conversationRunCompatibilityBridgeSubmitSource();
  const catchStart = fallbackSubmitSource.indexOf("    } catch (e) {", fallbackSubmitSource.indexOf('deps.finishPerf(perfEnabled, "session.prompt", "done"'));
  const finallyStart = fallbackSubmitSource.indexOf("    } finally {", catchStart);
  assert.notEqual(catchStart, -1, "compatibility bridge catch block should exist");
  assert.notEqual(finallyStart, -1, "compatibility bridge finally block should exist");

  const catchBlock = fallbackSubmitSource.slice(catchStart, finallyStart);
  assert.match(
    catchBlock,
    /const message = e instanceof Error \? e\.message : deps\.safeStringify\(e\);[\s\S]*input\.reportSendErrorToDisplayedTarget\(message\);/s,
    "compatibility bridge catch should route failure UI through the displayed conversation guard",
  );

  const helperStart = source.indexOf("    const reportSendErrorToDisplayedTarget = (message: string) => {");
  const helperEnd = source.indexOf("    const restorePendingDraftAfterSendFailure = () => {", helperStart);
  assert.notEqual(helperStart, -1, "displayed-target error helper should exist");
  assert.notEqual(helperEnd, -1, "displayed-target error helper should end before pending-draft restore helper");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.match(
    helperSource,
    /if \(!sendTargetStillDisplayed\(\)\) \{[\s\S]*deps\.recordSendTrace\("sendPrompt:error-skipped-stale-display"[\s\S]*return;[\s\S]*\}[\s\S]*const hintedMessage = deps\.addOpencodeCacheHint\(message\);[\s\S]*deps\.setError\(hintedMessage\);[\s\S]*deps\.sessionStoreAppendSessionErrorTurn\(materializedSessionID, hintedMessage\);/s,
    "stale sends should not write the active error banner or synthetic error turn",
  );
});
