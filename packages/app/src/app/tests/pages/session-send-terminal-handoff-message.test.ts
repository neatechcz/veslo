import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import cs from "../../../i18n/locales/cs.js";
import en from "../../../i18n/locales/en.js";

const sendWorkflow = readFileSync(
  new URL("../../pages/session-send-workflow.ts", import.meta.url),
  "utf8",
);
const sessionPage = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");

test("a blocked historical predecessor reports its own localized message", () => {
  assert.match(
    sendWorkflow,
    /error\.code === "terminal_handoff_recovery_required"[\s\S]{0,160}session\.run_terminal_handoff_unresolved/,
  );
});

test("the blocked-submit message reuses the key the recovery notice already renders", () => {
  // Both entry points must say the same thing; otherwise a rejected submit and
  // the notice that follows it would describe the same state differently.
  assert.match(sessionPage, /recoveryNotice\(\) === "terminal-handoff-unresolved"/);
  assert.match(sessionPage, /tr\("session\.run_terminal_handoff_unresolved"\)/);
});

test("the message key is translated in every shipped locale", () => {
  for (const [name, locale] of [["cs", cs], ["en", en]] as const) {
    const value = (locale as Record<string, string>)["session.run_terminal_handoff_unresolved"];
    assert.equal(typeof value, "string", `${name} is missing the key`);
    assert.ok(value.trim().length > 0, `${name} has an empty translation`);
  }
});
