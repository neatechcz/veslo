import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pages/session-send-workflow.ts", import.meta.url), "utf8");

test("prompt send failures only update the still-displayed conversation error state", () => {
  const catchStart = source.indexOf("    } catch (e) {", source.indexOf('deps.finishPerf(perfEnabled, "session.prompt", "done"'));
  const finallyStart = source.indexOf("    } finally {", catchStart);
  assert.notEqual(catchStart, -1, "sendPrompt catch block should exist");
  assert.notEqual(finallyStart, -1, "sendPrompt finally block should exist");

  const catchBlock = source.slice(catchStart, finallyStart);
  assert.match(
    catchBlock,
    /const message = e instanceof Error \? e\.message : deps\.safeStringify\(e\);[\s\S]*reportSendErrorToDisplayedTarget\(message\);/s,
    "sendPrompt catch should route failure UI through the displayed conversation guard",
  );

  const helperStart = source.indexOf("    const reportSendErrorToDisplayedTarget = (message: string) => {");
  const helperEnd = source.indexOf("    const model = deps.modelForSession(sessionID);", helperStart);
  assert.notEqual(helperStart, -1, "displayed-target error helper should exist");
  assert.notEqual(helperEnd, -1, "displayed-target error helper should end before model resolution");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.match(
    helperSource,
    /if \(!sendTargetStillDisplayed\(\)\) \{[\s\S]*deps\.recordSendTrace\("sendPrompt:error-skipped-stale-display"[\s\S]*return;[\s\S]*\}[\s\S]*const hintedMessage = deps\.addOpencodeCacheHint\(message\);[\s\S]*deps\.setError\(hintedMessage\);[\s\S]*deps\.sessionStoreAppendSessionErrorTurn\(sessionID, hintedMessage\);/s,
    "stale sends should not write the active error banner or synthetic error turn",
  );
});
