import assert from "node:assert/strict";
import test from "node:test";

import { createUiEffectTrace } from "../../lib/ui-effect-trace.js";

test("UI effect trace keeps normal events local and persists one bounded incident window", () => {
  let now = 10_000;
  let scheduled: (() => void) | undefined;
  const persisted: Array<Record<string, unknown>> = [];
  const trace = createUiEffectTrace({
    enabled: () => true,
    now: () => now,
    schedule: (callback) => {
      scheduled = callback;
    },
    persist: (payload) => persisted.push(payload),
  });

  trace.record("ui-focus:changed", { editorInstanceId: "editor_1", focused: true });
  now += 100;
  trace.reportIncident("composer-focus-lost", { editorInstanceId: "editor_1" });
  now += 250;
  trace.record("ui-effect:run", { owner: "composer.prompt-sync" });

  assert.equal(persisted.length, 0, "normal trace events must not invoke IPC persistence");
  assert.ok(scheduled, "an incident should schedule exactly one delayed batch");
  scheduled?.();

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.kind, "composer-focus-lost");
  assert.equal(persisted[0]?.windowMs, 5_000);
  assert.equal((persisted[0]?.entries as Array<{ event: string }>).length, 3);
});

test("UI effect trace is inert while disabled", () => {
  let scheduled = false;
  const trace = createUiEffectTrace({
    enabled: () => false,
    schedule: () => {
      scheduled = true;
    },
    persist: () => assert.fail("disabled trace must not persist"),
  });

  trace.record("ui-focus:changed", { focused: true });
  trace.reportIncident("composer-focus-lost");

  assert.equal(scheduled, false);
});
