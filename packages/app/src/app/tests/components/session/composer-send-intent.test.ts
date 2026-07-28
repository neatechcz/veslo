import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createComposerDraftHandoffController } from "../../../components/session/composer-draft-handoff.js";

const composerSource = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../../i18n/locales/zh.ts", import.meta.url), "utf8");

test("composer exports send intent options and passes them to onSend", () => {
  assert.match(
    composerSource,
    /export type ComposerSendOptions = \{\s*sendNow\?: boolean;\s*source\?: "button" \| "enter" \| "ctrl-enter";\s*sendTraceId\?: string;\s*implicitSkillCommandPolicy\?: "confirm" \| "allow" \| "disable";\s*onDraftTransferred\?: \(\) => void;\s*\};/,
    "composer should export the send intent options contract",
  );

  assert.match(
    composerSource,
    /onSend: \(draft: ComposerDraft, options\?: ComposerSendOptions\) => Promise<ComposerSendResult>;/,
    "composer onSend should accept optional send intent options and return a typed result",
  );

  const handlerStart = composerSource.indexOf("const sendDraft = async (");
  const submittedDraftIndex = composerSource.indexOf("const submittedDraft = draft;", handlerStart);
  const onSendIndex = composerSource.indexOf("sendPromise = props.onSend(submittedDraft, sendOptions);", handlerStart);
  const awaitIndex = composerSource.indexOf("sendResult = await sendPromise;", handlerStart);
  assert.notEqual(handlerStart, -1, "sendDraft should exist");
  assert.notEqual(submittedDraftIndex, -1, "sendDraft should capture the draft being submitted");
  assert.notEqual(onSendIndex, -1, "sendDraft should pass the send intent through to onSend");
  assert.notEqual(awaitIndex, -1, "sendDraft should await the parent send promise");
  assert.ok(submittedDraftIndex < onSendIndex && onSendIndex < awaitIndex);
});

test("composer creates a trace id before parent send handoff", () => {
  const handlerStart = composerSource.indexOf("const sendDraft = async (");
  const traceIdIndex = composerSource.indexOf("makeComposerSendTraceId()", handlerStart);
  const onSendIndex = composerSource.indexOf("sendPromise = props.onSend(submittedDraft, sendOptions);", handlerStart);

  assert.notEqual(handlerStart, -1, "sendDraft should exist");
  assert.ok(traceIdIndex > handlerStart, "sendDraft should create a send trace id");
  assert.ok(onSendIndex > traceIdIndex, "trace id should exist before the parent send handoff");
  assert.match(
    composerSource,
    /recordSendWorkflowTrace\("composer", event, safePayload\);/,
    "composer send trace entries should use the shared native workflow trace sink",
  );
  assert.doesNotMatch(
    composerSource,
    /logUiEvent\("send-trace"/,
    "composer must not duplicate the shared workflow trace over Tauri IPC",
  );
});

test("composer routes transfer and result clears through one revision guard", () => {
  const handlerStart = composerSource.indexOf("const sendDraft = async (");
  const onSendIndex = composerSource.indexOf("sendPromise = props.onSend(submittedDraft, sendOptions);", handlerStart);
  const awaitIndex = composerSource.indexOf("sendResult = await sendPromise;", handlerStart);
  const transferIndex = composerSource.indexOf("draftHandoffController.acknowledgeTransfer", handlerStart);
  const resultIndex = composerSource.indexOf("draftHandoffController.applyResult", handlerStart);

  assert.notEqual(handlerStart, -1, "sendDraft should exist");
  assert.notEqual(onSendIndex, -1, "sendDraft should call onSend");
  assert.notEqual(awaitIndex, -1, "sendDraft should await the typed send result");
  assert.ok(transferIndex < onSendIndex, "the transfer callback must be installed before onSend");
  assert.ok(awaitIndex < resultIndex, "a non-transferred result must still pass through the revision guard");
  assert.equal((composerSource.match(/const clearSubmittedDraft =/g) ?? []).length, 1);
});

test("composer recognizes a storage-key handoff as an authorized prompt sync", () => {
  assert.match(
    composerSource,
    /storageKeyTransitionAuthorizesPromptSync = true;[\s\S]*authorizedStorageKeyTransition: storageKeyTransitionAuthorizesPromptSync,[\s\S]*parentConditionalClearAuthorizesPromptSync,[\s\S]*document\.activeElement === editorRef[\s\S]*!storageKeyTransitionAuthorizesPromptSync[\s\S]*!parentConditionalClearAuthorizesPromptSync/s,
  );
});

test("composer does not report an exact parent conditional clear as focused draft loss", () => {
  assert.match(
    composerSource,
    /const parentConditionalClearAuthorizesPromptSync = Boolean\([\s\S]*props\.draftStorageKey === pendingParentConditionalClear\.storageKey[\s\S]*props\.draftRevision === pendingParentConditionalClear\.nextRevision,[\s\S]*!parentConditionalClearAuthorizesPromptSync[\s\S]*pendingParentConditionalClear = parentClear;/s,
    "an applied parent revision clear should be recorded as authorized rather than as an external focused-editor incident",
  );
});

test("debounced draft writes retain the storage key captured at edit time", () => {
  assert.match(
    composerSource,
    /let scheduledDraftStorageKey: string \| null = null;[\s\S]*scheduledDraftStorageKey = props\.draftStorageKey;[\s\S]*const storageKey = scheduledDraftStorageKey \?\? props\.draftStorageKey;[\s\S]*scheduledDraftStorageKey = null;[\s\S]*props\.onDraftChange\(storageKey,/s,
    "a delayed write must use the key captured before a target/session remap",
  );
});

test("draft transfer clears exactly once and delayed outcomes cannot clear a newer revision", () => {
  const controller = createComposerDraftHandoffController();
  const submission = controller.beginSubmission();
  let clearCount = 0;

  assert.equal(controller.acknowledgeTransfer(submission, () => { clearCount += 1; return true; }), true);
  assert.equal(controller.acknowledgeTransfer(submission, () => { clearCount += 1; return true; }), false);
  controller.markDraftChanged();
  assert.equal(controller.applyResult(submission, "clear", () => { clearCount += 1; return true; }), false);
  assert.equal(controller.applyResult(submission, "mark-failed", () => { clearCount += 1; return true; }), false);
  assert.equal(clearCount, 1);
});

test("non-transferred clear results apply only to the submitted revision", () => {
  const controller = createComposerDraftHandoffController();
  const blockedSubmission = controller.beginSubmission();
  let clearCount = 0;
  assert.equal(controller.applyResult(blockedSubmission, "keep", () => { clearCount += 1; return true; }), false);

  const staleSubmission = controller.beginSubmission();
  controller.markDraftChanged();

  assert.equal(controller.applyResult(staleSubmission, "clear", () => { clearCount += 1; return true; }), false);
  const currentSubmission = controller.beginSubmission();
  assert.equal(controller.applyResult(currentSubmission, "clear", () => { clearCount += 1; return true; }), true);
  assert.equal(controller.applyResult(currentSubmission, "clear", () => { clearCount += 1; return true; }), false);
  assert.equal(clearCount, 1);
});

test("composer distinguishes queued Enter sends from immediate Ctrl+Enter sends", () => {
  const altEnterIndex = composerSource.indexOf("event.altKey");
  const ctrlEnterIndex = composerSource.indexOf('source: "ctrl-enter"');
  const plainEnterIndex = composerSource.indexOf('source: "enter"');
  assert.ok(altEnterIndex >= 0, "Alt+Enter newline handling should remain present");
  assert.ok(ctrlEnterIndex > altEnterIndex, "Ctrl+Enter send handling should run after Alt+Enter newline handling");
  assert.ok(plainEnterIndex > ctrlEnterIndex, "Plain Enter send handling should run after Ctrl+Enter send handling");

  assert.match(
    composerSource,
    /if \(props\.recoveryBlocked\) return;[\s\S]*if \(props\.busy && !props\.isStreaming\) return;[\s\S]*if \(event\.ctrlKey \|\| event\.metaKey\) \{[\s\S]*?void sendDraft\(\{ sendNow: true, source: "ctrl-enter" \}\);/s,
    "Ctrl+Enter and Meta+Enter should request immediate send only outside a recovery block and non-streaming busy state",
  );

  assert.match(
    composerSource,
    /if \(event\.key === "Enter"\) \{[\s\S]*?void sendDraft\(\{ sendNow: false, source: "enter" \}\);[\s\S]*?\}/s,
    "plain Enter should queue the message rather than interrupting immediately",
  );

  assert.match(
    composerSource,
    /if \(props\.recoveryBlocked\) return;[\s\S]*if \(props\.busy && !props\.isStreaming\) return;/,
    "plain Enter should still reach onSend while streaming, but not during explicit recovery",
  );
});

test("composer exposes button intents for queue and streaming send-now", () => {
  assert.match(
    composerSource,
    /data-testid="session-composer-input"[\s\S]*contentEditable=\{!submitLocked\(\)\}/,
    "the editable composer should expose a stable automation selector",
  );

  assert.match(
    composerSource,
    /void sendDraft\(\{ sendNow: false, source: "button" \}\);/,
    "normal send button should queue by default and identify the button source",
  );

  assert.match(
    composerSource,
    /translate\("session\.queue_message_label"\)/,
    "normal send button should use the localized queue label",
  );
  assert.match(
    composerSource,
    /data-testid="session-composer-send-button"[\s\S]*void sendDraft\(\{ sendNow: false, source: "button" \}\);/,
    "the normal send button should expose a stable automation selector",
  );

  assert.match(
    composerSource,
    /when=\{props\.isStreaming\}[\s\S]*data-testid="session-composer-stop-button"[\s\S]*onClick=\{\(\) => props\.onStop\(\)\}[\s\S]*translate\("session\.stop_label"\)/s,
    "streaming UI should expose a stable localized Stop affordance",
  );
  assert.match(
    composerSource,
    /<Show when=\{hasDraftContent\(\)\}>[\s\S]*void sendDraft\(\{ sendNow: true, source: "button" \}\);[\s\S]*title=\{translate\("session\.send_now_title"\)\}[\s\S]*aria-label=\{translate\("session\.send_now_label"\)\}/s,
    "streaming UI should keep Stop and add a localized send-now affordance when draft content exists",
  );

  assert.match(
    composerSource,
    /const \[sendNowPending, setSendNowPending\] = createSignal\(false\);/,
    "send-now should have scoped pending state separate from streaming send state",
  );

  assert.match(
    composerSource,
    /if \(options\.sendNow && sendNowPending\(\)\) return;/,
    "send-now submissions should debounce while the previous send-now call is pending",
  );

  assert.match(
    composerSource,
    /finally \{[\s\S]*setActiveSendTraceId\(null\);[\s\S]*if \(options\.sendNow\) setSendNowPending\(false\);[\s\S]*\}/,
    "send-now pending state should reset after the onSend promise settles",
  );

  assert.doesNotMatch(
    composerSource,
    /#1b29ff/i,
    "composer primary actions should not bypass the shared cyan accent token",
  );
  assert.equal(
    composerSource.match(/bg-dls-accent text-\[#001932\]/g)?.length ?? 0,
    3,
    "queued, pending, and send-now composer actions should use readable cyan token styling",
  );
  assert.match(
    composerSource,
    /hover:bg-\[var\(--dls-accent-hover\)\]/,
    "enabled composer actions should use the shared accent hover token",
  );
});

test("composer shows Escape confirmation on the streaming stop button", () => {
  assert.match(
    composerSource,
    /stopShortcutConfirmPending\?: boolean;/,
    "composer should accept the Escape stop confirmation state from the session view",
  );

  assert.match(
    composerSource,
    /props\.stopShortcutConfirmPending[\s\S]*translate\("session\.stop_escape_confirm_label"\)[\s\S]*translate\("session\.stop_label"\)/,
    "streaming stop button should expose a localized confirmation title before falling back to Stop",
  );

  assert.match(
    composerSource,
    /when=\{props\.stopShortcutConfirmPending\}[\s\S]*fallback=\{<Square size=\{14\} fill="currentColor" \/>\}[\s\S]*>Esc<\/span>/,
    "streaming stop button should replace the square icon with the Esc confirmation label",
  );
});

test("composer send intent labels are localized", () => {
  assert.match(enSource, /"session\.send_now_label": "Send now"/);
  assert.match(enSource, /"session\.send_now_title": "Steer agent now"/);
  assert.match(enSource, /"session\.queue_message_label": "Queue message"/);
  assert.match(enSource, /"session\.stop_escape_confirm_label": "Press Esc again to stop"/);

  assert.match(csSource, /"session\.send_now_label": "Poslat hned"/);
  assert.match(csSource, /"session\.send_now_title": "Nasměrovat agenta teď"/);
  assert.match(csSource, /"session\.queue_message_label": "Zařadit zprávu"/);
  assert.match(csSource, /"session\.stop_escape_confirm_label": "Dalším Esc zastavíte běh"/);

  assert.match(zhSource, /"session\.send_now_label": "立即发送"/);
  assert.match(zhSource, /"session\.send_now_title": "立即引导代理"/);
  assert.match(zhSource, /"session\.queue_message_label": "加入队列"/);
  assert.match(zhSource, /"session\.stop_escape_confirm_label": "再次按 Esc 停止"/);
});
