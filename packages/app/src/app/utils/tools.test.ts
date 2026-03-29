import assert from "node:assert/strict";
import test from "node:test";

import { compactHumanStepText, summarizeStep } from "./tools.js";

const FULL_DIRECTORY_PROMPT =
  "Dej mi přístup do adresáře /Users/vaclavsoukup/AI agent projects/Veslo/packages/app/src/app/components/session";

test("compactHumanStepText preserves full directory paths in human-facing prompts", () => {
  assert.equal(compactHumanStepText(FULL_DIRECTORY_PROMPT, 24), FULL_DIRECTORY_PROMPT);
});

test("summarizeStep keeps full directory paths in bash descriptions", () => {
  const summary = summarizeStep({
    type: "tool",
    tool: "bash",
    state: {
      input: {
        description: FULL_DIRECTORY_PROMPT,
      },
      status: "pending",
    },
  } as any);

  assert.equal(summary.title, FULL_DIRECTORY_PROMPT);
  assert.ok(!summary.title.includes("..."));
});
