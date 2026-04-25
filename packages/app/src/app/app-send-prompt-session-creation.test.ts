import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("sendPrompt keeps the session id returned by createSessionAndOpen before prompting", () => {
  assert.match(
    source,
    /let sessionID = selectedSessionId\(\);\s*if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:create-session-needed"\);\s*sessionID = \(await createSessionAndOpen\(\)\) \?\? selectedSessionId\(\);\s*\}\s*if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:blocked-no-session"\);\s*return false;\s*\}/s,
    "sendPrompt should use the session id returned by createSessionAndOpen so the first prompt is not dropped while selection state catches up",
  );
});
