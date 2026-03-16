import assert from "node:assert/strict";
import test from "node:test";

import { nextAgentModeOnShiftTab, shouldStopRunOnEscape } from "./session-shortcuts.js";

test("stops run on plain Escape when a run is active", () => {
  assert.equal(
    shouldStopRunOnEscape({
      key: "Escape",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      commandPaletteOpen: false,
      searchOpen: false,
      showRunIndicator: true,
      abortBusy: false,
    }),
    true,
  );
});

test("does not stop run when escape should be ignored", () => {
  const cases = [
    { key: "Enter" },
    { defaultPrevented: true },
    { metaKey: true },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { commandPaletteOpen: true },
    { searchOpen: true },
    { showRunIndicator: false },
    { abortBusy: true },
  ];

  for (const current of cases) {
    assert.equal(
      shouldStopRunOnEscape({
        key: "Escape",
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        commandPaletteOpen: false,
        searchOpen: false,
        showRunIndicator: true,
        abortBusy: false,
        ...current,
      }),
      false,
    );
  }
});

test("Shift+Tab cycles agent mode forward", () => {
  assert.equal(
    nextAgentModeOnShiftTab("build", {
      key: "Tab",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      busy: false,
    }),
    "plan",
  );

  assert.equal(
    nextAgentModeOnShiftTab("plan", {
      key: "Tab",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      busy: false,
    }),
    "veslo",
  );

  assert.equal(
    nextAgentModeOnShiftTab("veslo", {
      key: "Tab",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      busy: false,
    }),
    "build",
  );
});

test("Shift+Tab mode cycle ignores unsupported shortcut states", () => {
  const base = {
    key: "Tab",
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    busy: false,
  };

  assert.equal(nextAgentModeOnShiftTab("build", base), "plan");
  assert.equal(nextAgentModeOnShiftTab("build", { ...base, key: "Enter" }), null);
  assert.equal(nextAgentModeOnShiftTab("build", { ...base, shiftKey: false }), null);
  assert.equal(nextAgentModeOnShiftTab("build", { ...base, defaultPrevented: true }), null);
  assert.equal(nextAgentModeOnShiftTab("build", { ...base, ctrlKey: true }), null);
  assert.equal(nextAgentModeOnShiftTab("build", { ...base, metaKey: true }), null);
  assert.equal(nextAgentModeOnShiftTab("build", { ...base, altKey: true }), null);
  assert.equal(nextAgentModeOnShiftTab("build", { ...base, busy: true }), null);
});
