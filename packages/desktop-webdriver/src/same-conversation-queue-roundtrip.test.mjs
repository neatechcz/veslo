import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseSameConversationQueueRoundtripArguments } from "./same-conversation-queue-roundtrip.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenarioSource = readFileSync(resolve(__dirname, "./scenarios/same-conversation-queue-roundtrip.mjs"), "utf8");
const waitsSource = readFileSync(resolve(__dirname, "./scenario-kit/waits.mjs"), "utf8");

test("same-conversation queue roundtrip requires explicit one-line inputs", () => {
  const parsed = parseSameConversationQueueRoundtripArguments([
    "runtime-info.json",
    "--workspace", "Workspace A",
    "--first-message", "first",
    "--second-message", "second",
  ]);
  assert.equal(parsed.workspace, "Workspace A");
  assert.equal(parsed.thirdMessage, null);
  assert.equal(
    parseSameConversationQueueRoundtripArguments([
      "runtime-info.json",
      "--workspace", "Workspace A",
      "--first-message", "first",
      "--second-message", "second",
      "--third-message", "third",
    ]).thirdMessage,
    "third",
  );
  assert.equal(
    parseSameConversationQueueRoundtripArguments([
      "runtime-info.json", "--workspace", "Workspace A", "--first-message", "first", "--second-message", "second",
      "--third-message", "third", "--third-after-settle-ms", "2000",
    ]).thirdAfterSettleMs,
    2000,
  );
  assert.throws(
    () => parseSameConversationQueueRoundtripArguments(["runtime-info.json", "--workspace", "A"]),
    /Missing required --first-message/,
  );
  assert.throws(
    () => parseSameConversationQueueRoundtripArguments([
      "runtime-info.json", "--workspace", "A", "--first-message", "one\ntwo", "--second-message", "three",
    ]),
    /single-line/,
  );
});

test("same-conversation queue roundtrip submits later messages while the first run is active", () => {
  assert.match(scenarioSource, /queue\.first\.run-started/);
  assert.match(scenarioSource, /queue\.second\.submit-while-running/);
  assert.match(scenarioSource, /queue\.third\.submit-while-running/);
  assert.match(scenarioSource, /queue\.third\.submit-after-settle/);
  assert.match(scenarioSource, /queue\.visible-outputs/);
  assert.match(scenarioSource, /messages\.length/);
  assert.match(scenarioSource, /waitForVisibleAssistantOutputCount/);
  assert.match(scenarioSource, /queue\.no-terminal-assistant-error/);
  assert.match(scenarioSource, /waitForNoVisibleAssistantError/);
  assert.match(scenarioSource, /queueComposerMessageWithEnter/);
  assert.match(waitsSource, /Expected \$\{expectedAdditionalCount\} new visible assistant outputs/);
  assert.match(waitsSource, /Visible assistant error/);
});
