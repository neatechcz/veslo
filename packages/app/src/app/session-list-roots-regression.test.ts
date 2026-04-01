import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

const TARGET_FILES = [
  resolve(CURRENT_DIR, "app.tsx"),
  resolve(CURRENT_DIR, "context/session.ts"),
];

test("session.list calls do not force roots=false filtering", () => {
  const forbidden = /session\.list\(\s*\{[^}]*\broots\s*:\s*false/gs;
  for (const filePath of TARGET_FILES) {
    const source = readFileSync(filePath, "utf8");
    assert.equal(
      forbidden.test(source),
      false,
      `Unexpected roots=false in ${filePath}`,
    );
  }
});
