#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseBool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readOption(name, fallback = "") {
  return process.env[name] ?? fallback;
}

export function resolveReleaseSigning(options = {}) {
  const osType = String(options.osType ?? readOption("OS_TYPE", "macos")).trim().toLowerCase() || "macos";
  const updaterPrivateKey = options.updaterPrivateKey ?? readOption("TAURI_SIGNING_PRIVATE_KEY");
  const updaterPrivateKeyPassword =
    options.updaterPrivateKeyPassword ?? readOption("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
  const azureClientId = options.azureClientId ?? readOption("AZURE_CLIENT_ID");
  const azureTenantId = options.azureTenantId ?? readOption("AZURE_TENANT_ID");
  const azureSubscriptionId = options.azureSubscriptionId ?? readOption("AZURE_SUBSCRIPTION_ID");
  const azureArtifactSigningEndpoint =
    options.azureArtifactSigningEndpoint ?? readOption("AZURE_ARTIFACT_SIGNING_ENDPOINT");
  const azureArtifactSigningAccountName =
    options.azureArtifactSigningAccountName ?? readOption("AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME");
  const azureArtifactSigningCertProfileName =
    options.azureArtifactSigningCertProfileName ?? readOption("AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME");
  const appleSigningIdentity = options.appleSigningIdentity ?? readOption("APPLE_SIGNING_IDENTITY");
  const appleCertificate = options.appleCertificate ?? readOption("APPLE_CERTIFICATE");
  const appleCertificatePassword =
    options.appleCertificatePassword ?? readOption("APPLE_CERTIFICATE_PASSWORD");
  const appleNotaryApiKeyId = options.appleNotaryApiKeyId ?? readOption("APPLE_API_KEY");
  const appleNotaryApiIssuerId = options.appleNotaryApiIssuerId ?? readOption("APPLE_API_ISSUER");
  const appleNotaryApiKeyPath = options.appleNotaryApiKeyPath ?? readOption("APPLE_API_KEY_PATH");
  const appleNotaryApiKeyBase64 =
    options.appleNotaryApiKeyBase64 ?? readOption("APPLE_NOTARY_API_KEY_P8_BASE64");
  const appleId = options.appleId ?? readOption("APPLE_ID");
  const applePassword = options.applePassword ?? readOption("APPLE_PASSWORD");
  const appleTeamId = options.appleTeamId ?? readOption("APPLE_TEAM_ID");
  const allowUnsignedMacos = parseBool(
    options.allowUnsignedMacos ?? readOption("ALLOW_UNSIGNED_MACOS", "false"),
  );
  const macosNotarize = parseBool(options.macosNotarize ?? readOption("MACOS_NOTARIZE", "true"));

  if (!hasValue(updaterPrivateKey) || !hasValue(updaterPrivateKeyPassword)) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD are required for updater releases.",
    );
  }

  const windowsSigningReady =
    hasValue(azureClientId) &&
    hasValue(azureTenantId) &&
    hasValue(azureSubscriptionId) &&
    hasValue(azureArtifactSigningEndpoint) &&
    hasValue(azureArtifactSigningAccountName) &&
    hasValue(azureArtifactSigningCertProfileName);

  if (osType === "windows" && !windowsSigningReady) {
    throw new Error(
      "AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, AZURE_ARTIFACT_SIGNING_ENDPOINT, AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME, and AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME are required for Windows release signing.",
    );
  }

  const appleSigningReady =
    hasValue(appleSigningIdentity) && hasValue(appleCertificate) && hasValue(appleCertificatePassword);
  const appleNotaryApiKeyCredentialReady =
    hasValue(appleNotaryApiKeyId) &&
    hasValue(appleNotaryApiIssuerId) &&
    (hasValue(appleNotaryApiKeyPath) || hasValue(appleNotaryApiKeyBase64));
  const appleNotaryApiKeyReady = appleNotaryApiKeyCredentialReady;
  const appleIdNotaryReady = hasValue(appleId) && hasValue(applePassword) && hasValue(appleTeamId);
  const appleNotaryAuthMode = appleNotaryApiKeyReady ? "api-key" : appleIdNotaryReady ? "apple-id" : "none";
  const appleNotaryReady = appleNotaryAuthMode !== "none";

  if (osType !== "macos") {
    return {
      updaterSigningReady: true,
      windowsSigningReady,
      appleSigningReady,
      appleNotaryReady,
      appleNotaryAuthMode,
      allowUnsignedMacos,
      macosNotarize,
      macosBuildMode: "not-applicable",
      shouldBuildSignedMacos: false,
      shouldBuildUnsignedMacos: false,
      shouldNotarizeMacos: false,
    };
  }

  if (allowUnsignedMacos) {
    throw new Error(
      "Unsigned macOS releases are not allowed. Every distributed macOS release must be signed, notarized, and stapled.",
    );
  }

  if (!macosNotarize) {
    throw new Error(
      "macOS releases must be notarized. Set MACOS_NOTARIZE=true and provide Apple notarization credentials.",
    );
  }

  if (!appleSigningReady) {
    throw new Error(
      "APPLE_SIGNING_IDENTITY, APPLE_CERTIFICATE, and APPLE_CERTIFICATE_PASSWORD are required for macOS notarized releases.",
    );
  }

  if (!appleNotaryReady) {
    throw new Error(
      "APPLE_API_KEY/APPLE_API_ISSUER and APPLE_NOTARY_API_KEY_P8_BASE64 or APPLE_API_KEY_PATH, or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID are required for macOS notarized releases.",
    );
  }

  const macosBuildMode = "signed-notarized";

  return {
    updaterSigningReady: true,
    appleSigningReady,
    appleNotaryReady,
    appleNotaryAuthMode,
    allowUnsignedMacos,
    macosNotarize,
    macosBuildMode,
    shouldBuildSignedMacos: macosBuildMode === "signed" || macosBuildMode === "signed-notarized",
    shouldBuildUnsignedMacos: macosBuildMode === "unsigned",
    shouldNotarizeMacos: macosBuildMode === "signed-notarized",
  };
}

function writeOutputs(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(result).map(([key, value]) => `${key}=${value}`);

  if (outputPath) {
    appendFileSync(outputPath, `${lines.join("\n")}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function main() {
  writeOutputs(resolveReleaseSigning());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
