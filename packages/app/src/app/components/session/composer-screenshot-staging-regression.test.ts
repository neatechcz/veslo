import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
const sessionPageSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");

test("staging failure blocks send with an explicit error and no draft clear", () => {
  const stagingStart = appSource.indexOf(
    "const stagedAttachments = await stageAttachmentsIntoSessionDirectory(resolvedDraft, sessionID);",
  );
  const stagingEnd = appSource.indexOf("const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();");
  assert.notEqual(stagingStart, -1, "staging call should exist in send flow");
  assert.notEqual(stagingEnd, -1, "send flow should continue after staging call");
  const stagingWindow = appSource.slice(stagingStart, stagingEnd);

  assert.match(
    stagingWindow,
    /const stagedAttachments = await stageAttachmentsIntoSessionDirectory\(resolvedDraft, sessionID\);\s*const routedDraft = routeStagedAttachmentsForModel\(\{[\s\S]*?\}\);\s*if \(routedDraft\.error\) \{\s*setError\(routedDraft\.error\);\s*return false;\s*\}\s*resolvedDraft = routedDraft\.draft;\s*promptSystem = routedDraft\.system;\s*\} catch \(error\) \{\s*setError\(error instanceof Error \? error\.message : safeStringify\(error\)\);\s*return false;\s*\}/s,
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

test("composer awaits send confirmation before clearing draft and attachments", () => {
  assert.match(
    composerSource,
    /onSend: \(draft: ComposerDraft\) => Promise<boolean>;/,
    "composer onSend contract should expose send success/failure",
  );

  assert.match(
    composerSource,
    /const sent = await props\.onSend\(draft\);\s*if \(!sent\) return;\s*setSlashOpen\(false\);\s*setSlashQuery\(""\);\s*setAttachments\(\[\]\);\s*setEditorText\(""\);/s,
    "composer should clear draft state only after send succeeds",
  );
});

test("session page enables attachments only when Veslo server is connected", () => {
  assert.match(
    sessionPageSource,
    /const attachmentsEnabled = createMemo\(\(\) => \{\s*return props\.vesloServerStatus === "connected"\s*&& Boolean\(props\.vesloServerClient\)\s*&& Boolean\(props\.vesloServerWorkspaceId\?\.trim\(\)\);\s*\}\);/s,
    "attachment UI availability should require the same client and workspace prerequisites as attachment staging",
  );
});

test("send flow blocks screenshot analysis on non-vision models instead of relying on a hidden read fallback", () => {
  assert.match(
    appSource,
    /const routedDraft = routeStagedAttachmentsForModel\(\{\s*draft: resolvedDraft,\s*stagedAttachments,\s*model,\s*providers: providers\(\),\s*\}\);/s,
    "send flow should route staged attachments using the selected model capabilities",
  );

  assert.match(
    appSource,
    /if \(routedDraft\.error\) \{\s*setError\(routedDraft\.error\);\s*return false;\s*\}/s,
    "non-vision screenshot sends should fail with a visible error before the prompt runs",
  );

  assert.doesNotMatch(
    appSource,
    /stagedPaths\.join\("\\n"\)/,
    "staged screenshot filenames should not be appended directly into prompt text",
  );

  assert.match(
    appSource,
    /for \(const attachment of draft\.attachments\) \{\s*parts\.push\(\{\s*type: "file",\s*url: attachment\.dataUrl,\s*filename: attachment\.name,\s*mime: attachment\.mimeType,/s,
    "prompt building should still include staged image attachments as file parts",
  );
});
