import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("createSessionAndOpen does not abort session creation solely because the health preflight timed out", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const openNewSessionWithDirectory = async () =>");
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");

  const createSessionAndOpenSource = source.slice(start, end);
  assert.doesNotMatch(
    createSessionAndOpenSource,
    /throw new Error\(t\("app\.connection_lost", currentLocale\(\)\)\);/,
    "createSessionAndOpen should fall through to session.create when the health probe is flaky instead of failing the send immediately",
  );
});
