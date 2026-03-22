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
  const appleSigningIdentity = options.appleSigningIdentity ?? readOption("APPLE_SIGNING_IDENTITY");
  const appleCertificate = options.appleCertificate ?? readOption("APPLE_CERTIFICATE");
  const appleCertificatePassword =
    options.appleCertificatePassword ?? readOption("APPLE_CERTIFICATE_PASSWORD");
  const appleNotaryApiKeyId = options.appleNotaryApiKeyId ?? readOption("APPLE_API_KEY");
  const appleNotaryApiIssuerId = options.appleNotaryApiIssuerId ?? readOption("APPLE_API_ISSUER");
  const appleNotaryApiKeyPath = options.appleNotaryApiKeyPath ?? readOption("APPLE_API_KEY_PATH");
  const appleNotaryApiKeyBase64 =
    options.appleNotaryApiKeyBase64 ?? readOption("APPLE_NOTARY_API_KEY_P8_BASE64");
  const allowUnsignedMacos = parseBool(
    options.allowUnsignedMacos ?? readOption("ALLOW_UNSIGNED_MACOS", "false"),
  );
  const macosNotarize = parseBool(options.macosNotarize ?? readOption("MACOS_NOTARIZE", "false"));

  if (!hasValue(updaterPrivateKey) || !hasValue(updaterPrivateKeyPassword)) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD are required for updater releases.",
    );
  }

  const appleSigningReady =
    hasValue(appleSigningIdentity) && hasValue(appleCertificate) && hasValue(appleCertificatePassword);
  const appleNotaryReady =
    (hasValue(appleNotaryApiKeyId) &&
      hasValue(appleNotaryApiIssuerId) &&
      hasValue(appleNotaryApiKeyPath)) ||
    hasValue(appleNotaryApiKeyBase64);

  if (osType !== "macos") {
    return {
      updaterSigningReady: true,
      appleSigningReady,
      appleNotaryReady,
      allowUnsignedMacos,
      macosNotarize,
      macosBuildMode: "not-applicable",
      shouldBuildSignedMacos: false,
      shouldBuildUnsignedMacos: false,
      shouldNotarizeMacos: false,
    };
  }

  if (macosNotarize) {
    if (!appleSigningReady) {
      throw new Error(
        "APPLE_SIGNING_IDENTITY, APPLE_CERTIFICATE, and APPLE_CERTIFICATE_PASSWORD are required when macOS notarization is enabled.",
      );
    }
    if (!appleNotaryReady) {
      throw new Error(
        "APPLE_NOTARY_API_KEY_P8_BASE64 or the resolved APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH trio are required when macOS notarization is enabled.",
      );
    }
  }

  let macosBuildMode = "signed";
  if (appleSigningReady) {
    macosBuildMode = macosNotarize ? "signed-notarized" : "signed";
  } else if (allowUnsignedMacos) {
    macosBuildMode = "unsigned";
  } else {
    throw new Error(
      "APPLE_SIGNING_IDENTITY, APPLE_CERTIFICATE, and APPLE_CERTIFICATE_PASSWORD are required unless unsigned macOS releases are explicitly enabled.",
    );
  }

  return {
    updaterSigningReady: true,
    appleSigningReady,
    appleNotaryReady,
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
