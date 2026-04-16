import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./feedback-modal.tsx", import.meta.url), "utf8");

test("feedback modal exposes accessible dialog semantics", () => {
  assert.match(source, /role="dialog"/, "feedback modal should expose dialog semantics");
  assert.match(source, /aria-modal="true"/, "feedback modal should mark the dialog as modal");
  assert.match(source, /aria-labelledby=\{titleId\}/, "feedback modal should label the dialog via its heading");
  assert.match(source, /<h3 id=\{titleId\}/, "feedback modal heading should provide the dialog label target");
  assert.match(source, /tabIndex=\{-1\}/, "feedback modal container should be programmatically focusable");
});

test("feedback modal closes on Escape and traps focus inside the dialog", () => {
  assert.match(source, /event\.key === "Escape"/, "feedback modal should listen for Escape");
  assert.match(source, /event\.key !== "Tab"/, "feedback modal should intercept Tab navigation");
  assert.match(source, /window\.addEventListener\("keydown", handleKeyDown, true\)/, "feedback modal should register a capturing keydown handler while open");
  assert.match(source, /querySelectorAll<HTMLElement>\(FOCUSABLE_SELECTOR\)/, "feedback modal should discover focusable elements inside the dialog");
  assert.match(source, /dialogRef\.contains\(activeElement\)/, "feedback modal should keep focus within the dialog boundary");
  assert.match(source, /firstFocusable\.focus\(\)|lastFocusable\.focus\(\)/, "feedback modal should wrap focus between the first and last tabbable controls");
});

test("feedback modal cleans up scheduled initial focus when closing", () => {
  assert.match(source, /const focusFrame = requestAnimationFrame\(/, "feedback modal should keep a handle for the scheduled initial focus");
  assert.match(source, /cancelAnimationFrame\(focusFrame\)/, "feedback modal should cancel the scheduled focus frame during cleanup");
  assert.match(source, /let focusFrameCancelled = false|let isFocusFrameActive = true/, "feedback modal should guard the focus callback against stale execution");
});
