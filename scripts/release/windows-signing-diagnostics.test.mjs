import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflowPath = resolve(
  import.meta.dirname,
  "../../.github/workflows/build-windows-msi.yml",
);

test("Windows signing diagnostics isolate authentication and signing layers", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /name:\s*Windows Signing Diagnostics/);
  assert.match(workflow, /auth_mode:\s*\[default-chain, azure-cli-only\]/);
  assert.match(workflow, /azure\/artifact-signing-action@v2/);
  assert.match(workflow, /az account get-access-token --resource https:\/\/codesigning\.azure\.net/);
  assert.match(workflow, /VESLO_WINDOWS_SIGNING_TIMEOUT_SECONDS:\s*"120"/);
  assert.match(workflow, /VESLO_WINDOWS_SIGNING_MAX_ATTEMPTS:\s*"1"/);
  assert.match(workflow, /timeout:\s*120/);
  assert.match(workflow, /SigningProbe[^\s]*\.exe/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.doesNotMatch(workflow, /tauri build/i);
  assert.doesNotMatch(workflow, /release upload/i);
});
