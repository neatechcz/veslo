import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../../app.tsx", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");
const sessionPageSource = readFileSync(new URL("../../../pages/session.tsx", import.meta.url), "utf8");

test("staging failure blocks send with an explicit error and no draft clear", () => {
  const stagingStart = appSource.indexOf(
    '"sendPrompt:stage-attachments"',
  );
  const stagingEnd = appSource.indexOf("const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();");
  assert.notEqual(stagingStart, -1, "staging call should exist in send flow");
  assert.notEqual(stagingEnd, -1, "send flow should continue after staging call");
  const stagingWindow = appSource.slice(stagingStart, stagingEnd);

  assert.match(
    stagingWindow,
    /stageAttachmentsIntoSessionDirectory\(resolvedDraft, sessionID, sendPreflight\)[\s\S]*const routedDraft = routeStagedAttachmentsForModel\(\{[\s\S]*if \(routedDraft\.error\) \{[\s\S]*restorePendingDraftAfterSendFailure\(\);[\s\S]*setError\(routedDraft\.error\);[\s\S]*stopSendPromptBusy\(\);[\s\S]*return false;[\s\S]*\} catch \(error\) \{[\s\S]*restorePendingDraftAfterSendFailure\(\);[\s\S]*setError\(error instanceof Error \? error\.message : safeStringify\(error\)\);[\s\S]*stopSendPromptBusy\(\);[\s\S]*return false;/s,
    "send flow should hard-fail when attachment staging or routing fails",
  );

  assert.doesNotMatch(
    stagingWindow,
    /setPrompt\(""\)|setAttachments\(\[\]\)/,
    "staging failure should not clear the composer before aborting",
  );
});

test("send flow snapshots pending draft context before materializing a real session", () => {
  const sendStart = appSource.indexOf("async function sendPrompt");
  const sessionTarget = appSource.indexOf("const explicitTargetSessionId = isPendingSessionInstanceId(options.targetSessionId)", sendStart);
  const pendingSnapshot = appSource.indexOf("const pendingDraftSendState = (() => {", sessionTarget);
  const pendingKey = appSource.indexOf("const pendingDraftKey = (activePendingDraftKey() ?? \"\").trim();", pendingSnapshot);
  const sessionCreate = appSource.indexOf(
    "createSessionAndOpen(initialSessionTitle",
    pendingSnapshot,
  );

  assert.notEqual(sendStart, -1, "sendPrompt should exist");
  assert.ok(sessionTarget > sendStart, "send flow should resolve the target session before pending draft snapshot");
  assert.match(
    appSource.slice(sessionTarget, pendingSnapshot),
    /let sessionID = explicitTargetSessionId \|\| selectedRealSessionId;/,
    "send flow should preserve the explicit target session before pending draft snapshot",
  );
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

test("composer exposes send result so the parent can handle failed handoff state", () => {
  assert.match(
    composerSource,
    /onSend: \(draft: ComposerDraft, options\?: ComposerSendOptions\) => Promise<boolean>;/,
    "composer onSend contract should keep exposing send success/failure",
  );
});

test("composer clears the submitted draft and releases the editor before send handoff settles", () => {
  assert.match(
    composerSource,
    /const sendDisabled = createMemo\(\(\) => !hasDraftContent\(\) \|\| \(props\.busy && !props\.isStreaming\)\);/,
    "global busy should only disable send outside streaming/run-indicator mode",
  );

  assert.match(
    composerSource,
    /if \(options\.sendNow && sendNowPending\(\)\) return;/,
    "send-now debounce should remain before the submitted draft is cleared",
  );

  assert.match(
    composerSource,
    /if \(text\.startsWith\("\/"\)\) \{[\s\S]*draft\.command = \{ name: commandName, arguments: argTokens\.join\(" "\) \};[\s\S]*\}\s*\}\s*recordHistory\(draft\);\s*const submittedDraft = draft;/,
    "slash command detection and history recording should still happen before snapshot handoff",
  );

  assert.match(
    composerSource,
    /const submittedDraft = draft;[\s\S]*setSending\(true\);[\s\S]*setMentionOpen\(false\);\s*setMentionQuery\(""\);\s*setSlashOpen\(false\);\s*setSlashQuery\(""\);[\s\S]*setAttachments\(\[\]\);[\s\S]*setEditorText\(""\);[\s\S]*props\.onDraftChange\(\{[\s\S]*mode: submittedDraft\.mode,[\s\S]*parts: \[\],[\s\S]*attachments: \[\],[\s\S]*text: "",[\s\S]*resolvedText: "",[\s\S]*\}\);/,
    "composer should clear the editor and immediately emit an empty draft after snapshotting the submitted draft",
  );

  assert.match(
    composerSource,
    /sendPromise = props\.onSend\(submittedDraft, options\);[\s\S]*setSending\(false\);[\s\S]*sent = await sendPromise;/,
    "local sending should be released before awaiting the handoff promise",
  );

  assert.doesNotMatch(
    composerSource,
    /restoreSubmittedDraft\(submittedDraft\)/,
    "failed handoff should not restore the submitted draft into the composer",
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
    /if \(routedDraft\.error\) \{[\s\S]*restorePendingDraftAfterSendFailure\(\);[\s\S]*setError\(routedDraft\.error\);[\s\S]*stopSendPromptBusy\(\);[\s\S]*return false;[\s\S]*\}/s,
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
