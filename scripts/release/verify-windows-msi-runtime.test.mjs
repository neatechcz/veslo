import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const scriptPath = resolve(import.meta.dirname, "./verify-windows-msi-runtime.ps1");
const source = readFileSync(scriptPath, "utf8");

test("Windows MSI runtime verifier parses in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  const escapedPath = scriptPath.replaceAll("'", "''");
  const command = [
    "$tokens = $null",
    "$errors = $null",
    "[void][System.Management.Automation.Language.Parser]::ParseFile('" + escapedPath + "', [ref]$tokens, [ref]$errors)",
    "if ($errors.Count) { $errors | ForEach-Object { Write-Error $_; }; exit 1 }",
  ].join("; ");

  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });
});

test("Windows MSI runtime verifier rejects wildcard input before touching Windows Installer", { skip: process.platform !== "win32" }, () => {
  let error = null;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-MsiPath",
        "*.msi",
      ],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        stdio: "pipe",
      },
    );
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "wildcard MSI input must fail");
  const output = [error.message, error.stdout, error.stderr].map(String).join("\n");
  assert.match(output, /MsiPath must be an exact literal path to one MSI; wildcards are not allowed/);
});

test("Windows MSI runtime verifier keeps the final-artifact contract explicit", () => {
  for (const fragment of [
    "WindowsInstaller.Installer",
    "& msiexec.exe /a",
    "/L*V",
    '("TARGETDIR=" + $destination)',
    "-EncodedCommand",
    "probe-veslo-server-document-runtime.mjs",
    "veslo-node.exe",
    "chrome-devtools-mcp-package",
    "taskkill.exe",
    "Get-FileHash",
    "Get-WindowsAuthenticodeSha256",
    "windows-authenticode-hash.mjs",
    "Compiled document-runtime probe",
    'Join-Path ([System.IO.Path]::GetTempPath()) "v"',
    "Assert-WslSandboxPayloadExcluded",
    "Assert-WslSandboxCustomActionsExcluded",
    "SELECT `Action`, `Type`, `Source`, `Target` FROM `CustomAction`",
    "windows-wsl2-sandbox-provision.ps1",
    "wsl2-prerequisite-installer.ps1",
  ]) {
    assert.equal(source.includes(fragment), true, "missing verifier contract: " + fragment);
  }

  assert.match(source, /MsiPath must be an exact literal path to one MSI/);
  assert.match(source, /Chrome DevTools MCP bundled-runtime probe/);
});
