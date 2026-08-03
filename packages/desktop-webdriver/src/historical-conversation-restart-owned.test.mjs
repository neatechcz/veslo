import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseOwnedHistoricalConversationRestartArguments } from "./historical-conversation-restart-owned.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("owned historical restart scenario requires explicit prompts and starts both runtime phases", () => {
  const parsed = parseOwnedHistoricalConversationRestartArguments([
    "--workspace", "Disposable workspace",
    "--seed-message", "seed",
    "--interlude-message", "interlude",
    "--continuation-message", "continuation",
  ]);
  assert.equal(parsed.workspace, "Disposable workspace");
  assert.throws(
    () => parseOwnedHistoricalConversationRestartArguments(["runtime-info.json"]),
    /starts both desktop runtimes/,
  );
  const source = readFileSync(resolve(__dirname, "./historical-conversation-restart-owned.mjs"), "utf8");
  assert.match(source, /seedHistoricalConversationScenario/);
  assert.match(source, /stopOwnedLiveWebDriverRuntime\(firstRuntime\)/);
  assert.match(source, /continueHistoricalConversationScenario/);
  assert.match(source, /verifyHistoricalConversationArtifact/);
  const waitsSource = readFileSync(resolve(__dirname, "./scenario-kit/waits.mjs"), "utf8");
  assert.match(waitsSource, /waitForWorkspaceVisible\(browser, workspaceLabel, timeout = 90_000\)/);
});
