import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

test("staging failure blocks send with an explicit error and no draft clear", () => {
  const stagingStart = appSource.indexOf(
    "const stagedDraft = await stageAttachmentsIntoSessionDirectory(resolvedDraft, sessionID);",
  );
  const stagingEnd = appSource.indexOf("const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();");
  assert.notEqual(stagingStart, -1, "staging call should exist in send flow");
  assert.notEqual(stagingEnd, -1, "send flow should continue after staging call");
  const stagingWindow = appSource.slice(stagingStart, stagingEnd);

  assert.match(
    stagingWindow,
    /const stagedDraft = await stageAttachmentsIntoSessionDirectory\(resolvedDraft, sessionID\);\s*resolvedDraft = stagedDraft;\s*\} catch \(error\) \{\s*setError\(error instanceof Error \? error\.message : safeStringify\(error\)\);\s*return;\s*\}/s,
    "send flow should hard-fail when attachment staging fails",
  );

  assert.doesNotMatch(
    stagingWindow,
    /setPrompt\(""\)|setAttachments\(\[\]\)/,
    "staging failure should not clear the composer before aborting",
  );
});

test("composer keeps dropped files as attachment chips", () => {
  assert.match(
    composerSource,
    /setAttachments\(\(current: ComposerAttachment\[\]\) => \[\.\.\.current, \.\.\.next\]\);/,
    "composer should keep dropped files as attachment chips",
  );

  assert.doesNotMatch(
    composerSource,
    /insertUnsupportedFileLinks\(/,
    "composer should not auto-insert file links for dropped files",
  );
});
