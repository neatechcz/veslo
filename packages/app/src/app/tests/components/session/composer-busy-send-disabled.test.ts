import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");

test("composer disables send for global busy only outside streaming mode", () => {
  assert.match(
    composerSource,
    /const sendDisabled = createMemo\(\(\) => !hasDraftContent\(\) \|\| \(props\.busy && !props\.isStreaming\)\);/,
    "composer should allow queueing while streaming/run-indicator mode owns the global busy state",
  );

  assert.match(
    composerSource,
    /<button[\s\S]*disabled=\{sendDisabled\(\)\}/,
    "send button disabled state should use the derived send-disabled memo",
  );

  assert.match(
    composerSource,
    /if \(sending\(\) \|\| \(props\.busy && !props\.isStreaming\)\) \{[\s\S]*recordSendTrace\("sendButton:blocked"/,
    "send button click guard should only block local duplicate submits and non-streaming global busy",
  );

  assert.doesNotMatch(
    composerSource,
    /if \(sending\(\) \|\| props\.busy\) \{/,
    "streaming busy should not block send button clicks",
  );
});
