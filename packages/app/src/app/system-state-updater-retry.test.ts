import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./system-state.ts", import.meta.url), "utf8");

test("system state schedules automatic updater download retries", () => {
  assert.match(source, /resolveAutoDownloadFailureStatus/);
  assert.match(source, /type\s+DownloadUpdateOptions/);
  assert.match(source, /automatic\?:\s*boolean/);
  assert.match(source, /retryAttempt\?:\s*number/);
  assert.match(source, /refreshBeforeDownload\?:\s*boolean/);
});

test("scheduled updater retries refresh the update handle before downloading", () => {
  assert.match(source, /async function refreshPendingUpdateForDownload/);
  assert.match(source, /requireUpdate\?:\s*boolean/);
  assert.match(source, /await check\(\{ timeout: 8_000 \}\)/);
  assert.match(source, /throw new Error\("Update is no longer available\."\)/);
  assert.match(source, /refreshBeforeDownload[\s\S]*refreshPendingUpdateForDownload/);
});

test("manual updater downloads do not enter the automatic retry loop", () => {
  assert.match(source, /if \(optionsDownload\?\.automatic\)/);
  assert.match(source, /resolveAutoDownloadFailureStatus\(\{/);
  assert.match(source, /else[\s\S]*setUpdateStatus\(\{ state: "error"/);
});

test("system state exposes a manual retry entry point", () => {
  assert.match(source, /async function retryUpdateDownload\(\)/);
  assert.match(source, /downloadUpdate\(\{[\s\S]*refreshBeforeDownload: true[\s\S]*\}\)/);
  assert.match(source, /retryUpdateDownload,/);
});
