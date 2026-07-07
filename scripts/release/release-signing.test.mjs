import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parseBool, resolveReleaseSigning } from "./release-signing.mjs";

test("parseBool accepts common truthy and falsey values", () => {
  assert.equal(parseBool(true), true);
  assert.equal(parseBool("true"), true);
  assert.equal(parseBool("1"), true);
  assert.equal(parseBool("yes"), true);
  assert.equal(parseBool(false), false);
  assert.equal(parseBool("false"), false);
  assert.equal(parseBool("0"), false);
  assert.equal(parseBool(""), false);
});

test("requires updater signing secrets for any updater release", () => {
  assert.throws(
    () =>
      resolveReleaseSigning({
        updaterPrivateKey: "",
        updaterPrivateKeyPassword: "",
        allowUnsignedMacos: false,
        macosNotarize: false,
      }),
    /TAURI_SIGNING_PRIVATE_KEY/i,
  );
});

test("resolves signed macOS mode when Apple signing secrets are present", () => {
  const result = resolveReleaseSigning({
    updaterPrivateKey: "private-key",
    updaterPrivateKeyPassword: "secret",
    appleSigningIdentity: "Developer ID Application: Example",
    appleCertificate: "base64-cert",
    appleCertificatePassword: "cert-password",
    allowUnsignedMacos: false,
    macosNotarize: false,
  });

  assert.equal(result.appleSigningReady, true);
  assert.equal(result.macosBuildMode, "signed");
  assert.equal(result.shouldBuildUnsignedMacos, false);
});

test("resolves unsigned macOS mode only when explicitly enabled", () => {
  const result = resolveReleaseSigning({
    osType: "macos",
    updaterPrivateKey: "private-key",
    updaterPrivateKeyPassword: "secret",
    allowUnsignedMacos: true,
    macosNotarize: false,
  });

  assert.equal(result.appleSigningReady, false);
  assert.equal(result.macosBuildMode, "unsigned");
  assert.equal(result.shouldBuildUnsignedMacos, true);
});

test("rejects unsigned macOS mode in strict releases", () => {
  assert.throws(
    () =>
      resolveReleaseSigning({
        osType: "macos",
        updaterPrivateKey: "private-key",
        updaterPrivateKeyPassword: "secret",
        allowUnsignedMacos: false,
        macosNotarize: false,
      }),
    /APPLE_SIGNING_IDENTITY|unsigned macOS/i,
  );
});

test("requires notary secrets when notarization is requested", () => {
  assert.throws(
    () =>
      resolveReleaseSigning({
        osType: "macos",
        updaterPrivateKey: "private-key",
        updaterPrivateKeyPassword: "secret",
        appleSigningIdentity: "Developer ID Application: Example",
        appleCertificate: "base64-cert",
        appleCertificatePassword: "cert-password",
        allowUnsignedMacos: false,
        macosNotarize: true,
      }),
    /APPLE_NOTARY_API_KEY_P8_BASE64|notar/i,
  );
});

test("accepts App Store Connect API key notarization secrets", () => {
  const result = resolveReleaseSigning({
    osType: "macos",
    updaterPrivateKey: "private-key",
    updaterPrivateKeyPassword: "secret",
    appleSigningIdentity: "Developer ID Application: Example",
    appleCertificate: "base64-cert",
    appleCertificatePassword: "cert-password",
    appleNotaryApiKeyId: "key-id",
    appleNotaryApiIssuerId: "issuer-id",
    appleNotaryApiKeyPath: "/tmp/AuthKey.p8",
    allowUnsignedMacos: false,
    macosNotarize: true,
  });

  assert.equal(result.appleNotaryReady, true);
  assert.equal(result.appleNotaryAuthMode, "api-key");
  assert.equal(result.macosBuildMode, "signed-notarized");
  assert.equal(result.shouldNotarizeMacos, true);
});

test("accepts Apple ID app-specific password notarization secrets", () => {
  const result = resolveReleaseSigning({
    osType: "macos",
    updaterPrivateKey: "private-key",
    updaterPrivateKeyPassword: "secret",
    appleSigningIdentity: "Developer ID Application: Example",
    appleCertificate: "base64-cert",
    appleCertificatePassword: "cert-password",
    appleId: "developer@example.com",
    applePassword: "app-specific-password",
    appleTeamId: "TEAM123456",
    allowUnsignedMacos: false,
    macosNotarize: true,
  });

  assert.equal(result.appleNotaryReady, true);
  assert.equal(result.appleNotaryAuthMode, "apple-id");
  assert.equal(result.macosBuildMode, "signed-notarized");
  assert.equal(result.shouldNotarizeMacos, true);
});

test("non-macOS releases only require updater signing", () => {
  const result = resolveReleaseSigning({
    osType: "linux",
    updaterPrivateKey: "private-key",
    updaterPrivateKeyPassword: "secret",
    allowUnsignedMacos: false,
    macosNotarize: false,
  });

  assert.equal(result.macosBuildMode, "not-applicable");
  assert.equal(result.shouldBuildSignedMacos, false);
  assert.equal(result.shouldBuildUnsignedMacos, false);
  assert.equal(result.windowsSigningReady, false);
});

test("windows releases require Azure signing configuration", () => {
  assert.throws(
    () =>
      resolveReleaseSigning({
        osType: "windows",
        updaterPrivateKey: "private-key",
        updaterPrivateKeyPassword: "secret",
        allowUnsignedMacos: false,
        macosNotarize: false,
      }),
    /AZURE_CLIENT_ID|AZURE_ARTIFACT_SIGNING_ENDPOINT/i,
  );
});

test("windows releases resolve when Azure signing configuration is present", () => {
  const result = resolveReleaseSigning({
    osType: "windows",
    updaterPrivateKey: "private-key",
    updaterPrivateKeyPassword: "secret",
    azureClientId: "client-id",
    azureTenantId: "tenant-id",
    azureSubscriptionId: "subscription-id",
    azureArtifactSigningEndpoint: "https://plc.codesigning.azure.net/",
    azureArtifactSigningAccountName: "VesloSign",
    azureArtifactSigningCertProfileName: "veslo-public-trust",
    allowUnsignedMacos: false,
    macosNotarize: false,
  });

  assert.equal(result.windowsSigningReady, true);
  assert.equal(result.macosBuildMode, "not-applicable");
});

test("workflow routes signing through the release signing resolver", () => {
  const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/release-macos-aarch64.yml");
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /allow_unsigned_macos:/);
  assert.match(workflow, /release-signing\.mjs/);
  assert.match(workflow, /shouldBuildUnsignedMacos/);
  assert.match(workflow, /publish-tauri-windows:/);
  assert.match(workflow, /azure\/login@/);
  assert.match(workflow, /Artifact Signing dlib package/);
  assert.match(workflow, /tauri\.windows\.release\.conf\.json/);
  assert.match(workflow, /appleNotaryAuthMode/);
  assert.match(workflow, /Validate notary API key/);
  assert.match(workflow, /Build signed macOS bundle for notarization/);
  assert.match(workflow, /Notarize, staple, and re-sign macOS assets/);
  assert.match(workflow, /Upload notarized macOS release assets/);
  assert.match(workflow, /notarize-macos-assets\.sh/);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG"/);
  assert.match(workflow, /veslo-macos-release-assets/);
  assert.match(workflow, /app_tar_asset_path="\$asset_dir\/veslo-desktop-darwin-\$\{asset_arch\}\.app\.tar\.gz"/);
  assert.match(workflow, /cp "\$\{\{ steps\.macos_assets\.outputs\.app_tar_path \}\}" "\$app_tar_asset_path"/);
  assert.doesNotMatch(workflow, /app_tar_path \}\}#veslo-desktop-darwin/);
  assert.match(workflow, /timeout-minutes:\s*35/);
  assert.match(workflow, /APPLE_API_KEY: \$\{\{ secrets\.APPLE_NOTARY_API_KEY_ID \}\}/);
  assert.match(workflow, /APPLE_API_KEY_PATH: \$\{\{ env\.NOTARY_KEY_PATH \}\}/);
  assert.match(workflow, /APPLE_ID: \$\{\{ secrets\.APPLE_NOTARY_APPLE_ID \}\}/);
  assert.match(workflow, /APPLE_NOTARY_APPLE_ID/);
  assert.match(workflow, /APPLE_NOTARY_APP_SPECIFIC_PASSWORD/);
  assert.match(workflow, /APPLE_TEAM_ID/);
});

test("manual macOS notarization script staples the DMG and preserves updater artifacts", () => {
  const scriptPath = resolve(import.meta.dirname, "./notarize-macos-assets.sh");
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /xcrun notarytool submit/);
  assert.match(script, /--timeout "\$notary_timeout"/);
  assert.match(script, /> "\$output_json"/);
  assert.match(script, /2> "\$output_log"/);
  assert.match(script, /notarytool info "\$submission_id"/);
  assert.match(script, /xcrun stapler staple "\$dmg_path"/);
  assert.match(script, /codesign --verify --deep --strict --verbose=2 "\$app_path"/);
  assert.match(script, /codesign --force --sign "\$APPLE_SIGNING_IDENTITY" "\$dmg_path"/);
  assert.match(script, /submit_notary "\$dmg_path" "dmg"/);
  assert.match(script, /app_tar_sig_path=\$app_tar_sig_path/);
});

test("prerelease workflow supports Apple ID macOS notarization", () => {
  const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/prerelease.yml");
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /Resolve macOS signing/);
  assert.match(workflow, /release-signing\.mjs/);
  assert.match(workflow, /appleNotaryAuthMode/);
  assert.match(workflow, /Validate notary API key/);
  assert.match(workflow, /Build \+ upload \(notarized, App Store Connect API key\)/);
  assert.match(workflow, /Build \+ upload \(notarized, Apple ID\)/);
  assert.match(workflow, /APPLE_API_KEY: \$\{\{ secrets\.APPLE_NOTARY_API_KEY_ID \}\}/);
  assert.match(workflow, /APPLE_API_KEY_PATH: \$\{\{ env\.NOTARY_KEY_PATH \}\}/);
  assert.match(workflow, /APPLE_ID: \$\{\{ secrets\.APPLE_NOTARY_APPLE_ID \}\}/);
  assert.match(workflow, /APPLE_NOTARY_APPLE_ID/);
  assert.match(workflow, /APPLE_NOTARY_APP_SPECIFIC_PASSWORD/);
  assert.match(workflow, /APPLE_TEAM_ID/);
});

test("all Windows desktop workflows route bundles through Azure Artifact Signing", () => {
  const workflowPaths = [
    "../../.github/workflows/build-desktop.yml",
    "../../.github/workflows/build-windows-msi.yml",
    "../../.github/workflows/prerelease.yml",
    "../../.github/workflows/release-macos-aarch64.yml",
  ];

  for (const workflowPath of workflowPaths) {
    const workflow = readFileSync(resolve(import.meta.dirname, workflowPath), "utf8");

    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /environment:\s*release-signing/);
    assert.match(workflow, /release-signing\.mjs/);
    assert.match(workflow, /azure\/login@/);
    assert.match(workflow, /Artifact Signing dlib package/);
    assert.match(workflow, /veslo-artifact-signing-metadata\.json/);
    assert.match(workflow, /tauri\.windows\.release\.conf\.json/);
    assert.match(workflow, /Verify Windows signatures/);
    assert.match(workflow, /Get-AuthenticodeSignature/);
  }
});

test("Windows Tauri sign command uses explicit arguments for the signing script", () => {
  const configPath = resolve(
    import.meta.dirname,
    "../../packages/desktop/src-tauri/tauri.windows.release.conf.json",
  );
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const signCommand = config.bundle.windows.signCommand;

  assert.equal(signCommand.cmd, "pwsh");
  assert.deepEqual(signCommand.args, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "../../../scripts/release/windows-sign.ps1",
    "%1",
  ]);
});

test("Windows signing PowerShell script declares parameters before executable statements", () => {
  const scriptPath = resolve(import.meta.dirname, "../../scripts/release/windows-sign.ps1");
  const script = readFileSync(scriptPath, "utf8");
  const statements = script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.match(statements[0], /^param\(/);
  assert.match(statements.join("\n"), /Set-StrictMode -Version Latest/);
});

test("Windows signing PowerShell script skips bundled JSON sidecar manifests", () => {
  const scriptPath = resolve(import.meta.dirname, "../../scripts/release/windows-sign.ps1");
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /versions\.json\*/);
  assert.match(script, /opencode-managed-deps\.json\*/);
  assert.match(script, /Skipping signing for non-executable sidecar manifest/);
  assert.match(script, /exit 0/);
});

test("Windows signing PowerShell script bounds Azure signing hangs and retries", () => {
  const scriptPath = resolve(import.meta.dirname, "../../scripts/release/windows-sign.ps1");
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /VESLO_WINDOWS_SIGNING_TIMEOUT_SECONDS/);
  assert.match(script, /VESLO_WINDOWS_SIGNING_MAX_ATTEMPTS/);
  assert.match(script, /System\.Diagnostics\.ProcessStartInfo/);
  assert.match(script, /ArgumentList\.Add/);
  assert.match(script, /WaitForExit\(\$timeoutMs\)/);
  assert.match(script, /Stop-Process/);
  assert.match(script, /timed out after \$timeoutSeconds seconds/);
  assert.match(script, /retrying/);
});

test("release checklist documents Windows signing timeout controls", () => {
  const checklistPath = resolve(import.meta.dirname, "../../RELEASE.md");
  const checklist = readFileSync(checklistPath, "utf8");

  assert.match(checklist, /VESLO_WINDOWS_SIGNING_TIMEOUT_SECONDS/);
  assert.match(checklist, /VESLO_WINDOWS_SIGNING_MAX_ATTEMPTS/);
  assert.match(checklist, /Azure Artifact Signing request/);
});

test("release docs require Developer ID certificate signing for every macOS release", () => {
  const requiredText = [
    "Every distributed macOS build must be signed with the Apple Developer ID Application certificate.",
    "Do not use `allow_unsigned_macos=true` or `ALLOW_UNSIGNED_MACOS=true` for production, beta, prerelease, staging, or tester-distributed macOS builds.",
    "Notarization can be disabled only when notarization credentials are unavailable; certificate signing must still remain enabled.",
    "codesign --verify --deep --strict --verbose=2",
    "Developer ID Application: Neatech s.r.o. (D7XT3SG9WA)",
  ];
  const docs = [
    "../../RELEASE.md",
    "../../docs/dev/release-skill.md",
    "../../.opencode/commands/release.md",
    "../../.opencode/skills/release/SKILL.md",
    "../../.opencode/skills/veslo-release/SKILL.md",
    "../../.claude/skills/veslo-release/SKILL.md",
  ];

  for (const docPath of docs) {
    const doc = readFileSync(resolve(import.meta.dirname, docPath), "utf8");
    for (const text of requiredText) {
      assert.match(doc, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${docPath} missing ${text}`);
    }
  }
});

test("Windows signing workflows allow slow Azure signing responses", () => {
  const workflowPaths = [
    {
      path: "../../.github/workflows/build-desktop.yml",
      timeoutSeconds: 900,
      maxAttempts: 2,
    },
    {
      path: "../../.github/workflows/build-windows-msi.yml",
      timeoutSeconds: 900,
      maxAttempts: 2,
    },
    {
      path: "../../.github/workflows/prerelease.yml",
      timeoutSeconds: 900,
      maxAttempts: 2,
    },
    {
      path: "../../.github/workflows/release-macos-aarch64.yml",
      timeoutSeconds: 1800,
      maxAttempts: 3,
    },
  ];

  for (const workflowPath of workflowPaths) {
    const workflow = readFileSync(resolve(import.meta.dirname, workflowPath.path), "utf8");

    assert.match(
      workflow,
      new RegExp(`VESLO_WINDOWS_SIGNING_TIMEOUT_SECONDS:\\s*${workflowPath.timeoutSeconds}`),
    );
    assert.match(
      workflow,
      new RegExp(`VESLO_WINDOWS_SIGNING_MAX_ATTEMPTS:\\s*${workflowPath.maxAttempts}`),
    );
  }
});

test("Windows workflows use the shared Artifact Signing dlib package installer", () => {
  const installerPath = resolve(
    import.meta.dirname,
    "../../scripts/release/install-artifact-signing-client-tools.ps1",
  );
  const installer = readFileSync(installerPath, "utf8");
  const workflowPaths = [
    "../../.github/workflows/build-desktop.yml",
    "../../.github/workflows/build-windows-msi.yml",
    "../../.github/workflows/prerelease.yml",
    "../../.github/workflows/release-macos-aarch64.yml",
  ];

  assert.match(installer, /nuget\.exe/);
  assert.match(installer, /Microsoft\.ArtifactSigning\.Client/);
  assert.match(installer, /Azure\.CodeSigning\.Dlib\.dll/);
  assert.match(installer, /VESLO_ARTIFACT_SIGNING_DLIB_PATH/);

  for (const workflowPath of workflowPaths) {
    const workflow = readFileSync(resolve(import.meta.dirname, workflowPath), "utf8");

    assert.match(workflow, /timeout-minutes:\s*10/);
    assert.match(workflow, /install-artifact-signing-client-tools\.ps1/);
  }
});
