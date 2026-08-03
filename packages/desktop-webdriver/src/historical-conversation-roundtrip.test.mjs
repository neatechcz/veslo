import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseHistoricalConversationRoundtripArguments } from "./historical-conversation-roundtrip.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenarioSource = readFileSync(resolve(__dirname, "./scenarios/historical-conversation-roundtrip.mjs"), "utf8");

test("historical conversation scenario requires explicit mutation inputs", () => {
  const parsed = parseHistoricalConversationRoundtripArguments([
    "runtime-info.json",
    "--workspace", "Disposable workspace",
    "--seed-message", "seed",
    "--interlude-message", "interlude",
    "--continuation-message", "continuation",
  ]);
  assert.equal(parsed.workspace, "Disposable workspace");
  assert.throws(
    () => parseHistoricalConversationRoundtripArguments([
      "runtime-info.json", "--workspace", "A", "--seed-message", "one\ntwo",
      "--interlude-message", "three", "--continuation-message", "four",
    ]),
    /single-line/,
  );
});

test("historical conversation scenario reopens a visible old sidebar row and rejects foreign transcript projection", () => {
  assert.match(scenarioSource, /historical\.seed\.reopen/);
  assert.match(scenarioSource, /openSidebarSession/);
  assert.match(scenarioSource, /sidebarSessionIdForVisibleText/);
  assert.match(scenarioSource, /waitForHistoricalTranscript/);
  assert.match(scenarioSource, /!messages\.some\(\(text\) => text\.includes\(interludeMessage\)\)/);
  assert.match(scenarioSource, /historical\.continuation\.output/);
  assert.match(scenarioSource, /step\(`\$\{stepPrefix\}\.output`/);
  assert.match(scenarioSource, /submitAndProveSingleAssistantTurn\(context, input\.seedMessage/);
  assert.match(scenarioSource, /submitAndProveSingleAssistantTurn\(context, input\.interludeMessage/);
  assert.match(scenarioSource, /outputs\.length !== 1/);
  assert.match(scenarioSource, /waitForNoVisibleAssistantError/);
  const workspaceSource = readFileSync(resolve(__dirname, "./scenario-kit/workspace.mjs"), "utf8");
  assert.match(workspaceSource, /setWorkspaceConversationListExpanded\(browser, workspaceLabel, true\)/);
  assert.match(workspaceSource, /Historical conversation is not visible in/);
  const launcherSource = readFileSync(resolve(__dirname, "./historical-conversation-roundtrip.mjs"), "utf8");
  assert.match(launcherSource, /verifyHistoricalConversationArtifact\(result\.artifactPath\)/);
  assert.match(launcherSource, /causal\.summary\.outcome !== "passed"/);
});
