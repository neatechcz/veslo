import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appViewPropsSource = readFileSync(new URL("../../../app-view-props.ts", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");
const sessionPageSource = readFileSync(new URL("../../../pages/session.tsx", import.meta.url), "utf8");
const sessionSendWorkflowSource = readFileSync(new URL("../../../pages/session-send-workflow.ts", import.meta.url), "utf8");
const stagingSource = readFileSync(new URL("../../../pages/session-attachment-staging.ts", import.meta.url), "utf8");

test("send flow snapshots pending draft context before materializing a real session", () => {
  const sendStart = sessionSendWorkflowSource.indexOf("async function sendPrompt");
  const sessionTarget = sessionSendWorkflowSource.indexOf("const explicitTargetSessionId = deps.isPendingSessionInstanceKey(", sendStart);
  const pendingSnapshot = sessionSendWorkflowSource.indexOf("const pendingDraftSendState = (() => {", sessionTarget);
  const pendingKey = sessionSendWorkflowSource.indexOf('const pendingDraftKey = (deps.activePendingDraftKey() ?? "").trim();', pendingSnapshot);
  const sessionCreate = sessionSendWorkflowSource.indexOf("createSessionAndOpen(initialSessionTitle", pendingSnapshot);

  assert.notEqual(sendStart, -1, "sendPrompt should exist");
  assert.ok(sessionTarget > sendStart, "send flow should resolve the target session before pending draft snapshot");
  assert.match(
    sessionSendWorkflowSource.slice(sessionTarget, pendingSnapshot),
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

  assert.doesNotMatch(composerSource, /insertUnsupportedFileLinks\(/, "composer should not auto-insert file links for dropped files");
});

test("composer exposes send result so the parent can handle failed handoff state", () => {
  assert.match(
    composerSource,
    /onSend: \(draft: ComposerDraft, options\?: ComposerSendOptions\) => Promise<ComposerSendResult>;/,
    "composer onSend contract should expose the typed submit result",
  );
});

test("composer clears transferred drafts through the revision-owned handoff", () => {
  assert.match(
    composerSource,
    /const sendDisabled = createMemo\(\(\) =>\s*props\.recoveryBlocked === true \|\| !hasDraftContent\(\) \|\| \(props\.busy && !props\.isStreaming\)\s*\);/,
    "global busy should only disable send outside streaming/run-indicator mode, except an explicit recovery block",
  );

  assert.match(
    composerSource,
    /if \(options\.sendNow && sendNowPending\(\)\) return;/,
    "send-now debounce should remain before the submitted draft is cleared",
  );

  assert.match(
    composerSource,
    /if \(text\.startsWith\("\/"\)\) \{[\s\S]*draft\.command = \{ name: commandName, arguments: argTokens\.join\(" "\) \};[\s\S]*\}[\s\S]*recordHistory\(draft\);\s*const submittedDraft = draft;/,
    "slash command detection and history recording should still happen before snapshot handoff",
  );

  assert.match(
    composerSource,
    /const submittedRevision = draftHandoffController\.beginSubmission\(\);[\s\S]*onDraftTransferred: \(\) => \{[\s\S]*draftHandoffController\.acknowledgeTransfer\(\s*submittedRevision,[\s\S]*sendResult = await sendPromise;[\s\S]*draftHandoffController\.applyResult\(/,
    "composer should allow synchronous ownership transfer and guard delayed result clearing with one submitted revision",
  );

  assert.match(
    composerSource,
    /const parentDraftRevision = props\.draftRevision;[\s\S]*const externalAttachments = props\.initialDraft\.attachments \?\? \[\];[\s\S]*const currentAttachments = untrack\(\(\) => attachments\(\)\);[\s\S]*if \(!attachmentsMatch\) \{\s*setAttachments\(externalAttachments\.map\(\(attachment\) => \(\{ \.\.\.attachment \}\)\)\);/,
    "parent draft revisions should reconcile attachment-only clears without subscribing to local attachment edits",
  );

  assert.match(
    composerSource,
    /sendPromise = props\.onSend\(submittedDraft, sendOptions\);[\s\S]*finally \{[\s\S]*finishSending\(\);[\s\S]*setActiveSendTraceId\(null\);/,
    "counter-based local sending and active trace state should be released after the handoff promise settles",
  );

  assert.doesNotMatch(composerSource, /restoreSubmittedDraft\(submittedDraft\)/, "failed handoff should not restore the submitted draft into the composer");
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
    appViewPropsSource,
    /const sessionProps = \{[\s\S]*?get vesloServerWorkspaceId\(\) \{[\s\S]*?return vesloServerWorkspaceId\(\);/s,
    "session view should use the real Veslo workspace signal, not a devtools-only fallback that can point at the wrong workspace",
  );
});
