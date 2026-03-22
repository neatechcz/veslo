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

test("non-macOS releases only require updater signing", () => {
  const result = resolveReleaseSigning({
    osType: "windows",
    updaterPrivateKey: "private-key",
    updaterPrivateKeyPassword: "secret",
    allowUnsignedMacos: false,
    macosNotarize: false,
  });

  assert.equal(result.macosBuildMode, "not-applicable");
  assert.equal(result.shouldBuildSignedMacos, false);
  assert.equal(result.shouldBuildUnsignedMacos, false);
});

test("workflow routes signing through the release signing resolver", () => {
  const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/release-macos-aarch64.yml");
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /allow_unsigned_macos:/);
  assert.match(workflow, /release-signing\.mjs/);
  assert.match(workflow, /shouldBuildUnsignedMacos/);
});
