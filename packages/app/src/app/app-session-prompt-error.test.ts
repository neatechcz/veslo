import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("prompt send failures set the visible session error state before recording the synthetic error turn", () => {
  const catchStart = source.indexOf("    } catch (e) {", source.indexOf('finishPerf(perfEnabled, "session.prompt", "done"'));
  const finallyStart = source.indexOf("    } finally {", catchStart);
  assert.notEqual(catchStart, -1, "sendPrompt catch block should exist");
  assert.notEqual(finallyStart, -1, "sendPrompt finally block should exist");

  const catchBlock = source.slice(catchStart, finallyStart);
  assert.match(
    catchBlock,
    /const message = e instanceof Error \? e\.message : safeStringify\(e\);[\s\S]*setError\(addOpencodeCacheHint\(message\)\);[\s\S]*sessionStore\.appendSessionErrorTurn\(sessionID, addOpencodeCacheHint\(message\)\);/s,
    "sendPrompt catch should drive props.error so the run footer enters a terminal failed state",
  );
});
