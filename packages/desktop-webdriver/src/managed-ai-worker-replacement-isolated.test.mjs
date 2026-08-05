import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseIsolatedManagedAiWorkerReplacementArguments } from "./managed-ai-worker-replacement-isolated.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("isolated worker replacement owns the fixture and refuses caller-supplied runtime targets", () => {
  const input = parseIsolatedManagedAiWorkerReplacementArguments([]);
  assert.match(input.workspace, /WebDriver Managed AI Workspace/);
  assert.throws(
    () => parseIsolatedManagedAiWorkerReplacementArguments(["runtime-info.json"]),
    /owns its fixture, workspace, and desktop runtime/,
  );
});

test("isolated worker replacement holds a real provider response before replacing only the server worker", () => {
  const source = readFileSync(resolve(__dirname, "./scenarios/managed-ai-worker-replacement-isolated.mjs"), "utf8");
  assert.match(source, /fixture\.waitForAttempts\(2, \{ timeoutMs: 90_000 \}\)/);
  assert.match(source, /restartVesloServerWorker/);
  assert.match(source, /runtime-auth-reprime/);
  assert.match(source, /fixture\.releaseHeldResponses/);
  assert.match(source, /outputs\.length !== 1/);
});
