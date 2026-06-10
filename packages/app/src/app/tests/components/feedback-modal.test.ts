import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../components/feedback-modal.tsx", import.meta.url), "utf8");
const modalShellSource = readFileSync(new URL("../../components/modal-shell.tsx", import.meta.url), "utf8");
const modalFocusSource = readFileSync(new URL("../../components/use-modal-focus.ts", import.meta.url), "utf8");
const modalErrorSource = readFileSync(new URL("../../components/modal-error.tsx", import.meta.url), "utf8");

test("feedback modal exposes accessible dialog semantics", () => {
  assert.match(modalShellSource, /role=\{props\.role \?\? "dialog"\}/, "shared modal shell should expose dialog semantics");
  assert.match(modalShellSource, /aria-modal="true"/, "shared modal shell should mark the dialog as modal");
  assert.match(source, /ariaLabelledBy=\{titleId\}/, "feedback modal should label the dialog via its heading");
  assert.match(source, /titleId=\{titleId\}/, "feedback modal heading should provide the dialog label target");
  assert.match(source, /tabIndex=\{-1\}/, "feedback modal container should be programmatically focusable");
});

test("feedback modal closes on Escape and traps focus inside the dialog", () => {
  assert.match(source, /useFocusTrap\(/, "feedback modal should use the shared focus trap");
  assert.match(modalFocusSource, /event\.key === "Escape"/, "focus trap should listen for Escape");
  assert.match(modalFocusSource, /event\.key !== "Tab"/, "focus trap should intercept Tab navigation");
  assert.match(modalFocusSource, /window\.addEventListener\("keydown", handleKeyDown, true\)/, "focus trap should register a capturing keydown handler while open");
  assert.match(modalFocusSource, /querySelectorAll<HTMLElement>\(FOCUSABLE_SELECTOR\)/, "focus trap should discover focusable elements inside the dialog");
  assert.match(modalFocusSource, /dialogRef\.contains\(activeElement\)/, "focus trap should keep focus within the dialog boundary");
  assert.match(modalFocusSource, /firstFocusable\.focus\(\)|lastFocusable\.focus\(\)/, "focus trap should wrap focus between the first and last tabbable controls");
});

test("feedback modal cleans up scheduled initial focus when closing", () => {
  assert.match(modalFocusSource, /const frame = requestAnimationFrame\(/, "focus trap should keep a handle for the scheduled initial focus");
  assert.match(modalFocusSource, /cancelAnimationFrame\(frame\)/, "focus trap should cancel the scheduled focus frame during cleanup");
  assert.match(modalFocusSource, /let cancelled = false/, "focus trap should guard the focus callback against stale execution");
});

test("feedback modal blocks duplicate submit activation while persistence is in flight", () => {
  assert.match(source, /submitting: boolean;/, "feedback modal props should expose submitting state from the app shell");
  assert.match(source, /if \(!canSubmit\(\) \|\| props\.submitting\) return;/, "feedback modal submit handler should ignore activations while submitting");
  assert.match(
    source,
    /<Button onClick=\{submit\} disabled=\{props\.submitting \|\| !canSubmit\(\)\}>/,
    "feedback modal submit button should disable while submitting",
  );
});

test("feedback modal renders inline submit errors from the app shell", () => {
  assert.match(source, /error: string \| null;/, "feedback modal props should accept a dedicated inline error message");
  assert.match(source, /<ModalError error=\{props\.error\} \/>/, "feedback modal should render submit errors inline when present");
  assert.match(modalErrorSource, /role="alert"/, "modal error surface should announce failures accessibly");
});

test("feedback modal renders the YouTrack task number after a successful submit", () => {
  assert.match(source, /successIssueId: string \| null;/, "feedback modal props should accept the submitted YouTrack issue id");
  assert.match(source, /feedback\.success_message/, "feedback modal should render localized success copy");
  assert.match(source, /props\.successIssueId/, "feedback modal should include the task number returned by the app shell");
});
