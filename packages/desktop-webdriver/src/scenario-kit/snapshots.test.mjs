import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, "./snapshots.mjs"), "utf8");

test("snapshots capture diagnostic UI state without collecting transcript or page source", () => {
  assert.match(source, /workspaceCount/);
  assert.match(source, /operationalError/);
  assert.match(source, /runtimeReadiness/);
  assert.match(source, /serverStatus/);
  assert.doesNotMatch(source, /session-transcript-viewport/);
  assert.doesNotMatch(source, /document\.documentElement/);
});
