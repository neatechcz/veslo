import assert from "node:assert/strict";
import test from "node:test";

import { deriveSessionRunPresentation } from "../../pages/session-run-presentation.js";
import { resolveEscapeStopShortcut } from "../../pages/session-shortcuts.js";

const shortcutInput = (showRunIndicator: boolean, confirmationPending = false) => ({
  key: "Escape",
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  commandPaletteOpen: false,
  searchOpen: false,
  showRunIndicator,
  abortBusy: false,
  confirmationPending,
});

test("Escape derives Stop availability from the same lifecycle presentation as the footer", () => {
  const active = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: { status: "blocked", stale: false, waitReason: "model_retry_no_output" },
    local: { started: true, hasBegun: true, optimisticSending: false, responseStarted: false },
  });
  const idle = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: { status: "completed", stale: false },
    local: { started: false, hasBegun: false, optimisticSending: false, responseStarted: false },
  });

  assert.equal(active.showIndicator, true);
  assert.equal(active.abortable, true);
  assert.equal(resolveEscapeStopShortcut(shortcutInput(active.showIndicator)), "request-confirmation");
  assert.equal(idle.showIndicator, false);
  assert.equal(idle.abortable, false);
  assert.equal(resolveEscapeStopShortcut(shortcutInput(idle.showIndicator)), "ignore");
});
