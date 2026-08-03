import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseHistoricalExistingContinuationArguments } from "./historical-existing-continuation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("existing historical continuation requires one explicit visible target", () => {
  const parsed = parseHistoricalExistingContinuationArguments([
    "runtime-info.json", "--workspace", "Disposable workspace", "--session-id", "session-1", "--continuation-message", "continue",
  ]);
  assert.equal(parsed.sessionId, "session-1");
  assert.throws(
    () => parseHistoricalExistingContinuationArguments(["runtime-info.json", "--workspace", "A", "--session-id", "B"]),
    /Missing required --continuation-message/,
  );
  const source = readFileSync(resolve(__dirname, "./scenarios/historical-conversation-roundtrip.mjs"), "utf8");
  assert.match(source, /executeExistingHistoricalContinuationScenario/);
  assert.match(source, /historical\.existing\.transcript-present/);
});
