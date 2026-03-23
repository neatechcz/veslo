import assert from "node:assert/strict";
import test from "node:test";

import { createOnboardingLanguageGate } from "./onboarding-language-gate.js";

test("prompts for language when no preference exists yet", () => {
  const gate = createOnboardingLanguageGate(() => false);
  assert.equal(gate.shouldPrompt(), true);
});

test("does not prompt when a persisted language preference exists", () => {
  const gate = createOnboardingLanguageGate(() => true);
  assert.equal(gate.shouldPrompt(), false);
});

test("does not prompt again after language was confirmed in this run", () => {
  const gate = createOnboardingLanguageGate(() => false);
  assert.equal(gate.shouldPrompt(), true);
  gate.markConfirmed();
  assert.equal(gate.shouldPrompt(), false);
});

test("reset re-enables prompt when language is not persisted", () => {
  const gate = createOnboardingLanguageGate(() => false);
  gate.markConfirmed();
  assert.equal(gate.shouldPrompt(), false);
  gate.reset();
  assert.equal(gate.shouldPrompt(), true);
});
