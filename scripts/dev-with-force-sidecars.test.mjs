import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./dev-with-force-sidecars.mjs", import.meta.url), "utf8");

test("force-sidecar dev helper mirrors workflow traces into .tmp", () => {
  assert.match(source, /mkdirSync\(traceMirrorDir, \{ recursive: true \}\)/);
  assert.match(
    source,
    /VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: resolve\(traceMirrorDir, "send-workflow-trace\.ndjson"\)/,
  );
});
