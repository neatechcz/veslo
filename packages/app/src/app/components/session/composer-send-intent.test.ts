import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../i18n/locales/zh.ts", import.meta.url), "utf8");

test("composer exports send intent options and passes them to onSend", () => {
  assert.match(
    composerSource,
    /export type ComposerSendOptions = \{\s*sendNow\?: boolean;\s*source\?: "button" \| "enter" \| "ctrl-enter";\s*\};/,
    "composer should export the send intent options contract",
  );

  assert.match(
    composerSource,
    /onSend: \(draft: ComposerDraft, options\?: ComposerSendOptions\) => Promise<boolean>;/,
    "composer onSend should accept optional send intent options",
  );

  assert.match(
    composerSource,
    /const submittedDraft = draft;[\s\S]*sent = await props\.onSend\(submittedDraft, options\);/s,
    "sendDraft should pass the send intent through to onSend",
  );
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
    /if \(props\.busy && !props\.isStreaming\) return;[\s\S]*if \(event\.ctrlKey \|\| event\.metaKey\) \{[\s\S]*?void sendDraft\(\{ sendNow: true, source: "ctrl-enter" \}\);/s,
    "Ctrl+Enter and Meta+Enter should request immediate send only after non-streaming busy state is excluded",
  );

  assert.match(
    composerSource,
    /if \(event\.key === "Enter"\) \{[\s\S]*?void sendDraft\(\{ sendNow: false, source: "enter" \}\);[\s\S]*?\}/s,
    "plain Enter should queue the message rather than interrupting immediately",
  );

  assert.match(
    composerSource,
    /if \(props\.busy && !props\.isStreaming\) return;/,
    "plain Enter should still reach onSend while streaming so the parent can queue it",
  );
});

test("composer exposes button intents for queue and streaming send-now", () => {
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
    /when=\{props\.isStreaming\}[\s\S]*props\.onStop\(\)[\s\S]*translate\("session\.stop_label"\)[\s\S]*<Show when=\{hasDraftContent\(\)\}>[\s\S]*void sendDraft\(\{ sendNow: true, source: "button" \}\);[\s\S]*translate\("session\.send_now_title"\)[\s\S]*translate\("session\.send_now_label"\)/s,
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
    /finally \{\s*if \(options\.sendNow\) setSendNowPending\(false\);\s*\}/,
    "send-now pending state should reset after the onSend promise settles",
  );
});

test("composer send intent labels are localized", () => {
  assert.match(enSource, /"session\.send_now_label": "Send now"/);
  assert.match(enSource, /"session\.send_now_title": "Steer agent now"/);
  assert.match(enSource, /"session\.queue_message_label": "Queue message"/);

  assert.match(csSource, /"session\.send_now_label": "Poslat hned"/);
  assert.match(csSource, /"session\.send_now_title": "Nasměrovat agenta teď"/);
  assert.match(csSource, /"session\.queue_message_label": "Zařadit zprávu"/);

  assert.match(zhSource, /"session\.send_now_label": "立即发送"/);
  assert.match(zhSource, /"session\.send_now_title": "立即引导代理"/);
  assert.match(zhSource, /"session\.queue_message_label": "加入队列"/);
});
