import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../components/session/composer.tsx", import.meta.url), "utf8");

test("composer records focus and draft diagnostics locally without tracing draft content", () => {
  assert.match(source, /uiEffectTrace\.record\("ui-composer:mount", \{[\s\S]*editorInstanceId/s);
  assert.match(source, /uiEffectTrace\.record\("ui-focus:intent", \{ editorInstanceId, reason \}\)/);
  assert.match(source, /uiEffectTrace\.record\("ui-focus:changed", \{ editorInstanceId, focused: true \}\)/);
  assert.match(source, /authorized: reason !== null,[\s\S]*authorizationReason: reason,/s);
  assert.match(source, /window\.addEventListener\("pointerdown", authorizePointerFocusChange, true\)/);
  assert.match(source, /uiEffectTrace\.record\("ui-draft:mutation", \{[\s\S]*reason: "external-sync",[\s\S]*previousLength:[\s\S]*nextLength:/s);
  assert.match(source, /data-composer-editor-instance=\{editorInstanceId\}/);
  assert.doesNotMatch(source, /uiEffectTrace\.record\([\s\S]*prompt: value/s);
});

test("composer reports only actionable focus and external-sync incidents", () => {
  assert.match(source, /reportIncident\("draft-external-sync-while-focused", \{ editorInstanceId \}\)/);
  assert.match(source, /reportIncident\("composer-disposed-while-focused", \{ editorInstanceId \}\)/);
});
