import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const controllersDir = fileURLToPath(new URL("../../controllers", import.meta.url));
const controllerSourceFiles = readdirSync(controllersDir)
  .filter((entry) => entry.endsWith(".ts"))
  .map((entry) => join(controllersDir, entry));

test("controllers stay UI-framework independent", () => {
  assert.ok(controllerSourceFiles.length > 0, "controller modules should exist");

  const forbiddenImportPatterns = [
    /from\s+["']solid-js["']/,
    /from\s+["']@solidjs\/router["']/,
    /from\s+["']\.\.\/pages\//,
    /from\s+["']\.\.\/components\//,
  ];

  for (const file of controllerSourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const pattern of forbiddenImportPatterns) {
      assert.doesNotMatch(
        source,
        pattern,
        `${basename(file)} should expose pure decisions instead of importing UI/runtime state`,
      );
    }
  }
});

test("every controller module has a colocated controller test file", () => {
  const testsDir = fileURLToPath(new URL(".", import.meta.url));

  for (const file of controllerSourceFiles) {
    const testPath = join(testsDir, `${basename(file, ".ts")}.test.ts`);
    assert.ok(statSync(testPath).isFile(), `${basename(file)} should have a focused unit test`);
  }
});
