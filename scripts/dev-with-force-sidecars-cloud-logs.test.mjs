import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./dev-with-force-sidecars-cloud-logs.mjs", import.meta.url), "utf8");

test("force-sidecar cloud-log dev helper keeps production Den debug-log ingest as optional live path", () => {
  assert.match(
    source,
    /const CLOUD_LOG_INGEST_URL = "https:\/\/api\.veslo\.work\/v1\/internal\/debug-logs";/,
  );
  assert.match(source, /const readOptionalCloudLogIngestToken/);
  assert.match(source, /if \(cloudLogIngestToken\) \{/);
  assert.match(source, /runtimeLoggingEnv\.VESLO_LOG_INGEST_URL = CLOUD_LOG_INGEST_URL;/);
});

test("force-sidecar cloud-log dev helper preflights internal ingest only when a token is present", () => {
  assert.match(source, /await runCloudLogIngestPreflight\(cloudLogIngestToken\);/);
  assert.match(source, /cloud log ingest preflight failed: HTTP \$\{response\.status\}/);
  assert.match(source, /fetch\(CLOUD_LOG_INGEST_URL,/);
  assert.match(source, /Authorization: `Bearer \$\{token\}`/);
  assert.match(source, /"Idempotency-Key": batchId/);
  assert.match(source, /timestamp: Date\.now\(\) \* 1_000_000/);
  assert.match(source, /acceptedBatchIds\?\.includes\(batchId\)/);
  assert.match(source, /no internal ingest token; live internal debug-log upload is disabled/);
});

test("force-sidecar cloud-log dev helper checks desktop dump auth without blocking macOS launch", () => {
  assert.match(source, /const diagnosticDumpUploadScript = resolve\(repoRoot, "scripts", "upload-diagnostic-dump\.mjs"\);/);
  assert.match(source, /runDiagnosticDumpAuthPreflight\(\);/);
  assert.match(source, /\[diagnosticDumpUploadScript, "--check-auth"\]/);
  assert.match(source, /diagnostic dump auth is not ready before launch; continuing/);
  assert.match(source, /the desktop runtime may need to start once to migrate\/create ~\/\.veslo\/den-auth\.json/);
  assert.match(source, /the final trace upload will retry after dev exits/);
  assert.doesNotMatch(source, /requireSuccess\(status\);/);
  assert.doesNotMatch(source, /missing VESLO_LOG_INGEST_TOKEN/);
});

test("force-sidecar cloud-log dev helper uploads the local trace mirror after dev exits", () => {
  assert.match(source, /mkdirSync\(traceMirrorDir, \{ recursive: true \}\)/);
  assert.match(source, /const traceMirrorFile = resolve\(traceMirrorDir, "send-workflow-trace\.cloud\.ndjson"\);/);
  assert.match(source, /deriveTraceChannelFile\(traceMirrorFile, "ui"\)/);
  assert.match(source, /deriveTraceChannelFile\(traceMirrorFile, "server"\)/);
  assert.match(source, /deriveTraceChannelFile\(traceMirrorFile, "orchestrator"\)/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: traceMirrorFile/);
  assert.match(source, /const uploadStatus = uploadTraceMirrors\(\);/);
  assert.match(source, /\[diagnosticDumpUploadScript, traceMirror\.path\]/);
  assert.match(source, /VESLO_DIAGNOSTIC_DUMP_KIND: traceMirror\.kind/);
});
