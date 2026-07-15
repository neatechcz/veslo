import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const scriptPath = resolve(
  import.meta.dirname,
  "./verify-windows-msi-installed.ps1",
);
const source = readFileSync(scriptPath, "utf8");

test(
  "installed Windows MSI verifier parses in Windows PowerShell",
  { skip: process.platform !== "win32" },
  () => {
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      "$tokens = $null",
      "$errors = $null",
      "[void][System.Management.Automation.Language.Parser]::ParseFile('" +
        escapedPath +
        "', [ref]$tokens, [ref]$errors)",
      "if ($errors.Count) { $errors | ForEach-Object { Write-Error $_; }; exit 1 }",
    ].join("; ");

    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
      },
    );
  },
);

test(
  "installed Windows MSI verifier rejects wildcard input before an MSI transaction",
  { skip: process.platform !== "win32" },
  () => {
    const evidenceRoot = mkdtempSync(
      resolve(tmpdir(), "veslo-msi-installed-verifier-"),
    );
    const summaryPath = resolve(evidenceRoot, "summary.json");
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
          "-Scenario",
          "clean",
          "-MsiPath",
          "*.msi",
          "-ReleaseTag",
          "test",
          "-Commit",
          "0123456789abcdef",
          "-SummaryPath",
          summaryPath,
        ],
        {
          cwd: resolve(import.meta.dirname, "../.."),
          encoding: "utf8",
          stdio: "pipe",
        },
      );
    } catch (caught) {
      error = caught;
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }

    assert.ok(error, "wildcard MSI input must fail");
    const output = [error.message, error.stdout, error.stderr]
      .map(String)
      .join("\n");
    assert.match(
      output,
      /MsiPath must be an exact literal path to one MSI; wildcards are not allowed/,
    );
  },
);

test("installed Windows MSI verifier keeps the real-install contract explicit", () => {
  for (const fragment of [
    '"clean-no-wsl"',
    '"normal-second-start"',
    '"forced-runtime-second-start"',
    '"foreign-listener"',
    '"updater"',
    '"26.6.26"',
    "& msiexec.exe /i",
    "& msiexec.exe /a",
    "/L*V",
    "veslo-server-runtime.json",
    "veslo-server-state.json",
    '"/status"',
    '"/document-runtime/status"',
    '"desktop-bootstrap:ready"',
    '"desktop-bootstrap-ready.json"',
    "Get-FreshBootstrapReadyDiagnostic",
    "MainWindowHandle",
    "Get-WebView2State",
    "Get-WslState",
    "Get-MsiCustomActions",
    "Assert-WslSandboxPayloadExcluded",
    "Assert-WslSandboxCustomActionsExcluded",
    "Assert-NoHostRuntimes",
    "Assert-PayloadMatchesMsi",
    "Get-NetTCPConnection",
    "Assert-NoInstalledVesloRuntimeProcess",
    '"veslo-server.exe"',
    "$workingDirectory = New-OwnedTemporaryDirectory",
    "Start-Process -FilePath $appPath -WorkingDirectory $workingDirectory -PassThru",
    "C:\\ProgramData\\veslo-updater-msi.log",
    "UpdaterLogNotBeforeUtc",
    "Production updater MSI log predates the declared updater transaction",
    "wslSandboxCustomActionsExcluded",
    "-RequireNoWslSandboxPayload",
    "taskkill.exe /pid $Process.Id /t /f",
    '"^(E2E_|VESLO_|VITE_|OPENCODE_)"',
  ]) {
    assert.equal(
      source.includes(fragment),
      true,
      "missing installed-MSI verifier contract: " + fragment,
    );
  }

  assert.equal(
    source.includes("tauri-pilot"),
    false,
    "final MSI verifier must not rely on Tauri Pilot",
  );
  assert.match(source, /MsiPath must be an exact literal path to one MSI/);
  assert.match(source, /Installed payload SHA-256 mismatch/);
  assert.match(source, /The verifier will not terminate an unowned/);
  assert.match(source, /VESLO_DOCUMENT_RUNTIME_MODULE/);
});

test("upgrade scenario installs and verifies both baseline and candidate MSI", () => {
  const upgradeStart = source.indexOf('if ($Scenario -eq "upgrade")');
  const baselineInstall = source.indexOf(
    "$summary.install.baseline = Invoke-MsiInstall",
    upgradeStart,
  );
  const baselineVerification = source.indexOf(
    "Assert-PayloadMatchesMsi -Expected $summary.msi.baseline.expectedPayload",
    baselineInstall,
  );
  const candidateInstall = source.indexOf(
    "$summary.install.candidate = Invoke-MsiInstall",
    baselineVerification,
  );

  assert.ok(upgradeStart >= 0, "upgrade branch is missing");
  assert.ok(
    baselineInstall > upgradeStart,
    "upgrade must install the baseline MSI first",
  );
  assert.ok(
    baselineVerification > baselineInstall,
    "upgrade must verify the installed baseline payload",
  );
  assert.ok(
    candidateInstall > baselineVerification,
    "upgrade must install the candidate MSI after baseline verification",
  );
});

test("installed-MSI verifier requires elevation before the first MSI transaction", () => {
  const candidatePath = source.indexOf(
    '$candidateMsiPath = Get-ExactMsiPath -Path $MsiPath',
  );
  const elevationGuard = source.indexOf("Assert-Administrator", candidatePath);
  const firstExtraction = source.indexOf("Get-ExtractedMsiPayloadSnapshot", candidatePath);

  assert.ok(candidatePath >= 0, "candidate MSI path resolution is missing");
  assert.ok(
    elevationGuard > candidatePath && elevationGuard < firstExtraction,
    "elevation must be checked before administrative MSI extraction",
  );
});

test("installed-MSI verifier rejects WSL setup from the candidate MSI before install", () => {
  const candidateAudit = source.indexOf(
    "$candidateMsiCustomActions = @(Get-MsiCustomActions -Path $candidateMsiPath)",
  );
  const customActionGuard = source.indexOf(
    "Assert-WslSandboxCustomActionsExcluded -CustomActions $candidateMsiCustomActions",
    candidateAudit,
  );
  const candidateExtraction = source.indexOf(
    "Get-ExtractedMsiPayloadSnapshot -Path $candidateMsiPath",
    customActionGuard,
  );
  const payloadGuard = source.indexOf(
    "-RequireNoWslSandboxPayload",
    candidateExtraction,
  );
  const candidateInstall = source.indexOf(
    "$summary.install.candidate = Invoke-MsiInstall",
    payloadGuard,
  );

  assert.ok(candidateAudit >= 0, "candidate CustomAction audit is missing");
  assert.ok(customActionGuard > candidateAudit, "candidate WSL CustomAction guard is missing");
  assert.ok(candidateExtraction > customActionGuard, "candidate payload extraction is missing");
  assert.ok(payloadGuard > candidateExtraction, "candidate payload WSL guard is missing");
  assert.ok(candidateInstall > payloadGuard, "candidate WSL checks must run before /i");
});

test("installed-MSI verifier prefers the durable bootstrap marker over the rotating spool", () => {
  const markerRead = source.indexOf(
    '$markerPath = Join-Path $spool "desktop-bootstrap-ready.json"',
  );
  const spoolFallback = source.indexOf(
    'foreach ($file in Get-ChildItem -LiteralPath $spool -Filter "*.jsonl"',
    markerRead,
  );

  assert.ok(markerRead >= 0, "durable bootstrap marker read is missing");
  assert.ok(spoolFallback > markerRead, "rotating spool must remain only a fallback");
});

test("updater scenario requires fresh evidence from the real updater transaction", () => {
  const updaterStart = source.indexOf('function Get-UpdaterLogEvidence');
  const freshnessGuard = source.indexOf(
    'Production updater MSI log predates the declared updater transaction',
    updaterStart,
  );
  const updaterInvocation = source.indexOf(
    'Get-UpdaterLogEvidence -Path $UpdaterLogPath -NotBeforeUtc $UpdaterLogNotBeforeUtc',
  );

  assert.ok(updaterStart >= 0, "updater evidence function is missing");
  assert.ok(freshnessGuard > updaterStart, "updater log freshness guard is missing");
  assert.ok(updaterInvocation >= 0, "updater scenario does not pass its freshness boundary");
});
