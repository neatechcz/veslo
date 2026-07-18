import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./dev-with-force-sidecars.mjs", import.meta.url), "utf8");

test("force-sidecar dev helper mirrors workflow traces into .tmp", () => {
  assert.match(source, /mkdirSync\(traceMirrorDir, \{ recursive: true \}\)/);
  assert.match(
    source,
    /const traceMirrorFile = resolve\(traceMirrorDir, "send-workflow-trace\.ndjson"\)/,
  );
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: traceMirrorFile/);
});

test("force-sidecar dev helper starts each run with only its trace mirrors cleared", () => {
  assert.match(source, /const traceMirrorFiles = \[[\s\S]*"ui", "server", "orchestrator"/);
  assert.match(source, /for \(const file of traceMirrorFiles\) rmSync\(file, \{ force: true \}\)/);
  assert.match(
    source,
    /run\(\["-C", "packages\/desktop", "prepare:sidecar", "--", "--force"\]\);[\s\S]*clearTraceMirrors\(\);[\s\S]*run\(\["dev", \.\.\.process\.argv\.slice\(2\)\], runtimeLoggingEnv\);/,
  );
});

test("force-sidecar dev helper enables bounded UI-effect diagnostics", () => {
  assert.match(source, /VITE_VESLO_SESSION_UI_MUTATION_TRACE: "1"/);
  assert.match(source, /VITE_VESLO_UI_EFFECT_TRACE: "1"/);
});
