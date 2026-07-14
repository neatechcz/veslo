import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./upload-diagnostic-dump.mjs", import.meta.url), "utf8");

test("diagnostic dump uploader defaults to the signed-in desktop Den endpoint", () => {
  assert.match(source, /const DEFAULT_DESKTOP_DUMP_PATH = "\/v1\/desktop-diagnostic-dumps";/);
  assert.match(source, /resolve\(homedir\(\), "\.veslo", "den-auth\.json"\)/);
  assert.match(source, /readDesktopAuthSnapshot/);
  assert.match(source, /"x-veslo-org-id"\] = target\.orgId/);
});

test("diagnostic dump uploader keeps internal token upload as explicit fallback", () => {
  assert.match(source, /const DEFAULT_INTERNAL_DUMP_URL = "https:\/\/api\.veslo\.work\/v1\/internal\/diagnostic-dumps";/);
  assert.match(source, /VESLO_DIAGNOSTIC_DUMP_AUTH_MODE/);
  assert.match(source, /process\.env\.VESLO_LOG_INGEST_TOKEN\?\.trim\(\)/);
  assert.match(source, /process\.env\.DEN_LOG_INGEST_TOKEN\?\.trim\(\)/);
});

test("diagnostic dump uploader gzip-compresses before upload and passes metadata headers", () => {
  assert.match(source, /createGzip\(\{ level: 6 \}\)/);
  assert.match(source, /"Content-Encoding": "gzip"/);
  assert.match(source, /"x-veslo-dump-kind": kind/);
  assert.match(source, /"x-veslo-dump-source": source/);
  assert.match(source, /"x-veslo-dump-sha256": compressedSha256/);
  assert.match(source, /body: createReadStream\(compressedPath\)/);
  assert.match(source, /duplex: "half"/);
});

test("diagnostic dump uploader has a non-uploading auth check mode", () => {
  assert.match(source, /args\.includes\("--check-auth"\)/);
  assert.match(source, /verifyTargetAuth\(target\)/);
  assert.match(source, /\/v1\/me/);
  assert.match(source, /printTarget\(target\);/);
  assert.match(source, /process\.exit\(0\);/);
});
