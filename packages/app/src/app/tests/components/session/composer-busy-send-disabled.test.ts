import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");

test("composer disables send for recovery blocks and global busy only outside streaming mode", () => {
  assert.match(
    composerSource,
    /const submitLocked = createMemo\(\(\) => props\.recoveryBlocked === true \|\| \(sending\(\) && !props\.isStreaming\)\);/,
    "composer should block submit only for a recovery block or a pre-run local handoff",
  );

  assert.match(
    composerSource,
    /const sendDisabled = createMemo\(\(\) =>\s*props\.recoveryBlocked === true \|\| !hasDraftContent\(\) \|\| \(props\.busy && !props\.isStreaming\)\s*\);/,
    "composer should allow queueing while streaming but block the explicit connection-recovery state",
  );

  assert.match(
    composerSource,
    /<button[\s\S]*disabled=\{sendDisabled\(\)\}/,
    "send button disabled state should use the derived send-disabled memo",
  );

  assert.match(
    composerSource,
    /if \(\s*props\.recoveryBlocked \|\|\s*\(sending\(\) && !props\.isStreaming\) \|\|\s*\(props\.busy && !props\.isStreaming\)\s*\) \{[\s\S]*recordSendTrace\("sendButton:blocked"/,
    "send button click guard should block the explicit recovery state without changing streaming queueing",
  );

  assert.doesNotMatch(
    composerSource,
    /if \(sending\(\) \|\| props\.busy\) \{/,
    "streaming busy should not block send button clicks",
  );
});
