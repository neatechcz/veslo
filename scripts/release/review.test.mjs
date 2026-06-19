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

test("release review verifies the Windows MSI version derived from CalVer", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const check = report.checks.find(
    (entry) => entry.label === "Windows MSI version matches derived CalVer mapping",
  );

  assert.ok(check, "expected release review to report the Windows MSI version check");
  assert.equal(check.ok, true);
});

test("release review verifies Windows MSI WSL sandbox provisioning packaging", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const labels = new Set(report.checks.map((entry) => entry.label));

  for (const label of [
    "Windows MSI bundles desktop package manifest for WSL provisioning version pin",
    "Windows MSI bundles WSL sandbox provisioner",
    "Windows MSI bundles WSL sandbox installer wrapper",
    "Windows MSI schedules WSL sandbox provisioning action",
  ]) {
    assert.ok(labels.has(label), `expected release review to report: ${label}`);
    assert.equal(report.checks.find((entry) => entry.label === label)?.ok, true);
  }
});
