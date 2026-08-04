import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseHistoricalIdleSuspendArguments } from "./historical-idle-suspend-owned.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("owned idle-suspend scenario accepts only explicit workspace and prompt inputs", () => {
  const parsed = parseHistoricalIdleSuspendArguments([
    "--workspace", "Disposable workspace",
    "--seed-message", "Reply with exactly: seed",
    "--continuation-message", "Reply with exactly: continuation",
  ]);
  assert.equal(parsed.workspace, "Disposable workspace");
  assert.throws(
    () => parseHistoricalIdleSuspendArguments(["runtime-info.json"]),
    /owns its desktop runtime/,
  );
});

test("idle-suspend scenario uses the normal dispose boundary and requires direct observed exit evidence", () => {
  const source = readFileSync(resolve(__dirname, "./scenarios/historical-conversation-roundtrip.mjs"), "utf8");
  const control = readFileSync(resolve(__dirname, "./scenario-kit/orchestrator-control.mjs"), "utf8");
  assert.match(source, /disposeDirectWorkspaceEngine/);
  assert.match(source, /suspension\.childKind !== "direct"/);
  assert.match(source, /suspension\.childExitObserved !== true/);
  assert.match(source, /requireSingleSubmitContract/);
  assert.match(control, /\/instances\/\$\{encodeURIComponent\(workspace\.id\)\}\/dispose/);
  assert.doesNotMatch(control, /\/e2e\//);
});
