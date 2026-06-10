import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../../pages/session.tsx", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");
const messageListSource = readFileSync(new URL("../../../components/session/message-list.tsx", import.meta.url), "utf8");

test("session center body uses 960px max width in wide mode", () => {
  assert.match(
    sessionSource,
    /const chatBodyWidthClass = centerColumnWidthClass\("max-w-\[960px\]"\);/,
    "chat body should be capped at 960px while still using full available width below the cap",
  );
});

test("composer width is capped at 960px instead of compact 325px", () => {
  assert.match(
    composerSource,
    /const composerWidthClass = createMemo\(\(\) => "max-w-\[960px\]"\);/,
    "composer should share the same 960px center cap to avoid overly narrow middle input",
  );
  assert.doesNotMatch(
    composerSource,
    /max-w-\[325px\]/,
    "composer should not clamp to the old 325px compact width",
  );
});

test("assistant message bubbles use a 960px max width cap", () => {
  assert.match(
    messageListSource,
    /max-w-\[960px\]/,
    "assistant message containers should use the wider 960px cap",
  );
  assert.doesNotMatch(
    messageListSource,
    /max-w-\[760px\]/,
    "assistant message containers should not use the previous 760px cap",
  );
});
