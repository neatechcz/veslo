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
    /const stagedAttachments = await stageAttachmentsIntoSessionDirectory\(resolvedDraft, sessionID\);\s*const routedDraft = routeStagedAttachmentsForModel\(\{[\s\S]*?\}\);\s*if \(routedDraft\.error\) \{\s*restorePendingDraftAfterSendFailure\(\);\s*setError\(routedDraft\.error\);\s*return false;\s*\}\s*resolvedDraft = routedDraft\.draft;\s*promptSystem = routedDraft\.system;\s*\} catch \(error\) \{\s*restorePendingDraftAfterSendFailure\(\);\s*setError\(error instanceof Error \? error\.message : safeStringify\(error\)\);\s*return false;\s*\}/s,
    "send flow should hard-fail when attachment staging fails",
  );

  assert.doesNotMatch(
    stagingWindow,
    /setPrompt\(""\)|setAttachments\(\[\]\)/,
    "staging failure should not clear the composer before aborting",
  );
});

test("send flow snapshots pending draft context before materializing a real session", () => {
  const sendStart = appSource.indexOf("async function sendPrompt");
  const sessionTarget = appSource.indexOf("let sessionID = options.targetSessionId?.trim() || selectedSessionId();", sendStart);
  const pendingSnapshot = appSource.indexOf("const pendingDraftSendState = (() => {", sessionTarget);
  const pendingKey = appSource.indexOf("const pendingDraftKey = (activePendingDraftKey() ?? \"\").trim();", pendingSnapshot);
  const sessionCreate = appSource.indexOf("sessionID = (await createSessionAndOpen()) ?? selectedSessionId();", pendingSnapshot);

  assert.notEqual(sendStart, -1, "sendPrompt should exist");
  assert.ok(sessionTarget > sendStart, "send flow should resolve the target session before pending draft snapshot");
  assert.ok(pendingSnapshot > sessionTarget, "send flow should snapshot pending draft identity");
  assert.ok(pendingKey > pendingSnapshot, "pending draft snapshot should capture active pending draft key");
  assert.ok(sessionCreate > pendingSnapshot, "pending draft snapshot should happen before creating the real session");
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

test("composer exposes send result so failed handoff can restore the submitted draft", () => {
  assert.match(
    composerSource,
    /onSend: \(draft: ComposerDraft, options\?: ComposerSendOptions\) => Promise<boolean>;/,
    "composer onSend contract should expose send success/failure",
  );
});

test("composer locks and visually clears the submitted draft while send handoff is pending", () => {
  assert.match(
    composerSource,
    /const submitLocked = createMemo\(\(\) => sending\(\)\);/,
    "composer should derive submit locking from its scoped send state",
  );

  assert.match(
    composerSource,
    /const sendDisabled = createMemo\(\(\) => !hasDraftContent\(\) \|\| props\.busy \|\| submitLocked\(\)\);/,
    "send disabled state should include the local submit lock",
  );

  assert.match(
    composerSource,
    /contentEditable=\{!submitLocked\(\)\}[\s\S]*aria-disabled=\{submitLocked\(\) \? "true" : "false"\}/,
    "the editor should become non-editable and expose disabled state while the submitted draft is locked",
  );

  assert.match(
    composerSource,
    /const restoreSubmittedDraft = \(draft: ComposerDraft\) => \{[\s\S]*props\.onDraftChange\(draft\);[\s\S]*\};/,
    "failed handoff should restore the original draft instead of leaving the cleared composer",
  );

  assert.match(
    composerSource,
    /const submittedDraft = draft;[\s\S]*setSending\(true\);[\s\S]*setAttachments\(\[\]\);[\s\S]*setEditorText\(""\);[\s\S]*sent = await props\.onSend\(submittedDraft, options\);[\s\S]*if \(!sent\) \{[\s\S]*restoreSubmittedDraft\(submittedDraft\);[\s\S]*setSending\(false\);[\s\S]*return;[\s\S]*\}/s,
    "composer should clear visually during handoff, then restore on rejected handoff",
  );

  assert.match(
    composerSource,
    /const handleEditorInput = \(\) => \{\s*if \(submitLocked\(\)\) return;/,
    "locked submitted drafts should ignore editor input events",
  );

  assert.match(
    composerSource,
    /const handlePaste = \(event: ClipboardEvent\) => \{\s*if \(submitLocked\(\)\) \{\s*event\.preventDefault\(\);[\s\S]*return;[\s\S]*\}/,
    "locked submitted drafts should reject paste mutations",
  );
});

test("session page enables attachments only when Veslo server is connected", () => {
  assert.match(
    sessionPageSource,
    /const attachmentsEnabled = createMemo\(\(\) => \{\s*return props\.vesloServerStatus === "connected"\s*&& Boolean\(props\.vesloServerClient\);\s*\}\);/s,
    "attachment UI availability should depend on live Veslo connectivity, not on whether workspace resolution has already completed",
  );
});

test("session props do not borrow devtools workspace fallbacks for attachment gating", () => {
  assert.match(
    appSource,
    /const sessionProps = \(\) => \(\{[\s\S]*?vesloServerWorkspaceId: vesloServerWorkspaceId\(\),/s,
    "session view should use the real Veslo workspace signal, not a devtools-only fallback that can point at the wrong workspace",
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
    /if \(routedDraft\.error\) \{\s*restorePendingDraftAfterSendFailure\(\);\s*setError\(routedDraft\.error\);\s*return false;\s*\}/s,
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
