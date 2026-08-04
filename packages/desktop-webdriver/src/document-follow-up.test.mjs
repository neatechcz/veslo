import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseFirstSessionDocumentFollowUpArguments } from "./first-session-document-follow-up.mjs";
import { parseExistingSessionDocumentFollowUpArguments } from "./existing-session-document-follow-up.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("document scenarios require explicit runtime, workspace, and message inputs", () => {
  const first = parseFirstSessionDocumentFollowUpArguments([
    "runtime-info.json",
    "--workspace", "Disposable workspace",
    "--document-message", "Read the document",
    "--follow-up-message", "Continue",
  ]);
  assert.equal(first.workspace, "Disposable workspace");
  const existing = parseExistingSessionDocumentFollowUpArguments([
    "runtime-info.json",
    "--workspace", "Disposable workspace",
    "--seed-message", "Seed",
    "--document-message", "Read the document",
    "--follow-up-message", "Continue",
  ]);
  assert.equal(existing.seedMessage, "Seed");
  assert.throws(
    () => parseFirstSessionDocumentFollowUpArguments([
      "runtime-info.json",
      "--workspace", "A",
      "--document-message", "line one\nline two",
      "--follow-up-message", "Continue",
    ]),
    /single-line/,
  );
});

test("document scenarios share one committed fixture and assert identity, absence, submit, and turn contracts", () => {
  const scenario = readFileSync(resolve(__dirname, "./scenarios/document-follow-up.mjs"), "utf8");
  const fixture = readFileSync(resolve(__dirname, "../fixtures/continuation-document.txt"), "utf8");
  assert.match(fixture, /VSLO-DOCUMENT-CONTINUATION-2026-08-04/);
  assert.match(scenario, /attachComposerFile/);
  assert.match(scenario, /waitForCanonicalIdentityAdoption/);
  assert.match(scenario, /beginUiWarningCapture/);
  assert.match(scenario, /pattern: "synchron"/);
  assert.match(scenario, /requireSingleSubmitContract/);
  assert.match(scenario, /outputs\.length !== 1/);
  assert.match(scenario, /existingSession \? "existing" : "new"/);
});
