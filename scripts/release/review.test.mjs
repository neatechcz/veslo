import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("release review verifies the veslo-code-router dependency pin", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const check = report.checks.find((entry) => entry.label === "Veslo-code-router dependency matches router version");

  assert.ok(check, "expected release review to report the veslo-code-router dependency check");
  assert.equal(check.ok, true);
});
