import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

test("composer disables send while the session view is still globally busy", () => {
  assert.match(
    composerSource,
    /const sendDisabled = createMemo\(\(\) => !hasDraftContent\(\) \|\| props\.busy\);/,
    "composer should derive a disabled send state from empty drafts and global busy transitions",
  );

  assert.match(
    composerSource,
    /<button[\s\S]*disabled=\{sendDisabled\(\)\}/,
    "send button should stay disabled until busy reconnect/bootstrap work finishes",
  );
});
