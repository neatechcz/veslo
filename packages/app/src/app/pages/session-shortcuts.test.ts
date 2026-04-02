import assert from "node:assert/strict";
import test from "node:test";

import { shouldStopRunOnEscape } from "./session-shortcuts.js";

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
