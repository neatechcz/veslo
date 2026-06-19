import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("opt-in automatic updater download starts in automatic mode", () => {
  assert.match(source, /if \(!updateAutoDownload\(\)\) return;[\s\S]*?downloadUpdate\(\{\s*automatic: true\s*\}/);
  assert.match(
    source,
    /downloadUpdate\(\{\s*automatic: true\s*\}\)\.catch\(e => reportError\(e, "updates\.download"\)\)/,
  );
});

test("app schedules retry timers for failed automatic updater downloads", () => {
  assert.match(source, /if \(state\.state !== "downloading"\) return;/);
  assert.match(source, /if \(state\.retry\?\.kind !== "scheduled"\) return;/);
  assert.match(source, /const delayMs = Math\.max\(0, state\.retry\.nextRetryAt - Date\.now\(\)\);/);
  assert.match(
    source,
    /const timeout = window\.setTimeout\(\(\) => \{[\s\S]*downloadUpdate\(\{[\s\S]*automatic: true,[\s\S]*retryAttempt: state\.retry\.retryAttempt,[\s\S]*refreshBeforeDownload: true,[\s\S]*\}\)\.catch\(e => reportError\(e, "updates\.download\.retry"\)\);[\s\S]*\}, delayMs\);/,
  );
  assert.match(source, /onCleanup\(\(\) => window\.clearTimeout\(timeout\)\);/);
});
