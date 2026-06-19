import assert from "node:assert/strict";
import test from "node:test";

import { isEscapeStopShortcutEligible, resolveEscapeStopShortcut, shouldStopRunOnEscape } from "../../pages/session-shortcuts.js";

test("marks plain Escape eligible for stop workflow when a run is active", () => {
  assert.equal(
    isEscapeStopShortcutEligible({
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

test("escape stop shortcut requests confirmation before stopping", () => {
  const base = {
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
  };

  assert.equal(resolveEscapeStopShortcut({ ...base, confirmationPending: false }), "request-confirmation");
  assert.equal(resolveEscapeStopShortcut({ ...base, confirmationPending: true }), "confirm-stop");
});

test("escape stop shortcut ignores ineligible key states before confirmation", () => {
  assert.equal(
    resolveEscapeStopShortcut({
      key: "Escape",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      commandPaletteOpen: false,
      searchOpen: false,
      showRunIndicator: false,
      abortBusy: false,
      confirmationPending: true,
    }),
    "ignore",
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
      isEscapeStopShortcutEligible({
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

test("requests Escape stop confirmation before stopping an active run", () => {
  const base = {
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
  };

  assert.equal(
    resolveEscapeStopShortcut({
      ...base,
      confirmationPending: false,
    }),
    "request-confirmation",
  );

  assert.equal(
    resolveEscapeStopShortcut({
      ...base,
      confirmationPending: true,
    }),
    "confirm-stop",
  );
});

test("ignores Escape stop confirmation when the shortcut is not eligible", () => {
  assert.equal(
    resolveEscapeStopShortcut({
      key: "Escape",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      commandPaletteOpen: true,
      searchOpen: false,
      showRunIndicator: true,
      abortBusy: false,
      confirmationPending: true,
    }),
    "ignore",
  );
});
