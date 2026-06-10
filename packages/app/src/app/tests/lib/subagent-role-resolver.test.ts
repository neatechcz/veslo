import assert from "node:assert/strict";
import test from "node:test";

import { classifySubagentRoleDeterministic } from "../../lib/subagent-decoration-model.js";
import { resolveSubagentRole } from "../../lib/subagent-role-resolver.js";

test("uses the AI classifier result when it returns valid JSON", async () => {
  let deterministicCalls = 0;
  const next = await resolveSubagentRole(
    {
      locale: "en",
      prompt: "Choose a role for spreadsheet extraction",
      timeoutMs: 50,
    },
    {
      runAiClassifier: async () =>
        JSON.stringify({
          role_key: "  Spreadsheet Extractor  ",
          role_label: "  Spreadsheet Extractor  ",
          first_name: "  Eve  ",
        }),
      classifyDeterministic: () => {
        deterministicCalls++;
        return {
          roleKey: "fallback",
          roleLabel: "Fallback",
          firstName: "Fallback",
        };
      },
    },
  );

  assert.deepEqual(next, {
    roleKey: "spreadsheet-extractor",
    roleLabel: "Spreadsheet Extractor",
    firstName: "Eve",
  });
  assert.equal(deterministicCalls, 0);
});

test("falls back to the deterministic classifier on timeout", async () => {
  let deterministicCalls = 0;
  const next = await resolveSubagentRole(
    {
      locale: "cs",
      prompt: "Choose a role for document editing",
      timeoutMs: 10,
    },
    {
      runAiClassifier: () => new Promise<string>(() => {}),
      classifyDeterministic: () => {
        deterministicCalls++;
        return {
          roleKey: "docx-editor",
          roleLabel: "Document Editor",
          firstName: "Anna",
        };
      },
    },
  );

  assert.deepEqual(next, {
    roleKey: "docx-editor",
    roleLabel: "Document Editor",
    firstName: "Anna",
  });
  assert.equal(deterministicCalls, 1);
});

test("falls back to the deterministic classifier on invalid AI JSON", async () => {
  let deterministicCalls = 0;
  const next = await resolveSubagentRole(
    {
      locale: "en",
      prompt: "Choose a role for slide edits",
      timeoutMs: 50,
    },
    {
      runAiClassifier: async () =>
        JSON.stringify({
          role_key: "  ",
          role_label: "Presentation Editor",
          first_name: "",
        }),
      classifyDeterministic: () => {
        deterministicCalls++;
        return {
          roleKey: "pptx-editor",
          roleLabel: "Presentation Editor",
          firstName: "Eve",
        };
      },
    },
  );

  assert.deepEqual(next, {
    roleKey: "pptx-editor",
    roleLabel: "Presentation Editor",
    firstName: "Eve",
  });
  assert.equal(deterministicCalls, 1);
});

test("uses fallback prompt for deterministic fallback so instruction text does not force web-research", async () => {
  const instructionPrompt = [
    "Return ONLY one JSON object with keys role_key, role_label, first_name.",
    "No markdown, no explanation.",
    "Language for role_label and first_name: Czech.",
    "Prefer stable role keys from this set when relevant:",
    "web-research, spreadsheet-processing, document-editing, slides-processing, coding, data-analysis, general-assistant",
    "role_key must be lowercase kebab-case ASCII.",
    "",
    "Subagent session title: process two excel sheets in parallel",
    "Parent session title: Finance summary",
  ].join("\n");

  const next = await resolveSubagentRole(
    {
      locale: "cs",
      prompt: instructionPrompt,
      fallbackPrompt: "process two excel sheets in parallel\nFinance summary",
      timeoutMs: 10,
    },
    {
      runAiClassifier: () => new Promise<string>(() => {}),
      classifyDeterministic: classifySubagentRoleDeterministic,
    },
  );

  assert.deepEqual(next, {
    roleKey: "spreadsheet-processing",
    roleLabel: "Zpracování tabulek",
    firstName: "Ema",
  });
});
