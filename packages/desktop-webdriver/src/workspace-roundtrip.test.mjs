import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertMutationAuthorized, parseWorkspaceRoundtripArguments } from "./workspace-roundtrip.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, "./workspace-roundtrip.mjs"), "utf8");
const composerSource = readFileSync(resolve(__dirname, "./scenario-kit/composer.mjs"), "utf8");
const selectorsSource = readFileSync(resolve(__dirname, "./scenario-kit/selectors.mjs"), "utf8");
const waitsSource = readFileSync(resolve(__dirname, "./scenario-kit/waits.mjs"), "utf8");
const workspaceSource = readFileSync(resolve(__dirname, "./scenario-kit/workspace.mjs"), "utf8");

test("workspace roundtrip requires explicit distinct workspaces and single-line messages", () => {
  const parsed = parseWorkspaceRoundtripArguments([
    "runtime-info.json",
    "--initial-workspace", "Workspace A",
    "--second-workspace", "Workspace B",
    "--first-message", "first",
    "--second-message", "second",
  ]);
  assert.equal(parsed.initialWorkspace, "Workspace A");
  assert.equal(parsed.secondWorkspace, "Workspace B");
  assert.throws(
    () => parseWorkspaceRoundtripArguments(["runtime-info.json", "--initial-workspace", "A"]),
    /Missing required --second-workspace/,
  );
  assert.throws(
    () => parseWorkspaceRoundtripArguments([
      "runtime-info.json", "--initial-workspace", "A", "--second-workspace", "A", "--first-message", "one", "--second-message", "two",
    ]),
    /must differ/,
  );
  assert.throws(
    () => parseWorkspaceRoundtripArguments([
      "runtime-info.json", "--initial-workspace", "A", "--second-workspace", "B", "--first-message", "one\ntwo", "--second-message", "three",
    ]),
    /single-line/,
  );
});

test("workspace roundtrip is opt-in and sends through visible UI controls", () => {
  assert.throws(() => assertMutationAuthorized({}), /WEBDRIVER_ALLOW_MUTATION=1/);
  assert.doesNotThrow(() => assertMutationAuthorized({ WEBDRIVER_ALLOW_MUTATION: "1" }));
  assert.match(source, /runLiveScenario/);
  assert.match(workspaceSource, /data-project-key/);
  assert.match(selectorsSource, /session-composer-input/);
  assert.match(selectorsSource, /session-composer-send-button/);
  assert.match(selectorsSource, /session-run-indicator/);
  assert.match(composerSource, /composer\.addValue\(message\)/);
  assert.match(composerSource, /browser\.execute\(visibleComposerText, selectors\.composerInput\)/);
  assert.match(workspaceSource, /projectNewSession/);
  assert.match(workspaceSource, /composerSessionQueueKey/);
  assert.match(workspaceSource, /visibleComposerSessionQueueKey/);
  assert.match(workspaceSource, /newConversation\.moveTo\(\)/);
  assert.match(workspaceSource, /getClientRects\(\)\.length > 0/);
  assert.match(workspaceSource, /footer composer intentionally omits this/);
  assert.match(workspaceSource, /requireDistinctConversation = false/);
  assert.match(workspaceSource, /nextSessionQueueKey !== previousSessionQueueKey/);
  assert.match(source, /runLiveScenario/);
  assert.doesNotMatch(source, /fetch\([^)]*conversation/i);
  assert.doesNotMatch(source, /spawn\(/);
});
