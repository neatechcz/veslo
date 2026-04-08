import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveDesktopAuthSeedFromEnv,
  resolveE2EDesktopAuthSnapshotPath,
  writeDesktopAuthSeedFile,
} from "./desktop-auth-seed.js";

test("resolveDesktopAuthSeedFromEnv builds a seed from raw auth env values", () => {
  const seed = resolveDesktopAuthSeedFromEnv({
    VESLO_E2E_DEN_AUTH_JSON: JSON.stringify({
      denApiBase: "https://den-control-plane-veslo.onrender.com",
      token: "seed-token",
      orgId: "org_123",
      user: { id: "user_123", email: "seed@example.com" },
      org: { id: "org_123", slug: "seed-org" },
    }),
    VESLO_E2E_DEN_KEEP_SIGNED_IN: "true",
    VESLO_E2E_LANGUAGE: "en",
    VESLO_E2E_ONBOARDING_COMPLETE: "1",
  });

  assert.deepEqual(seed, {
    authJson: JSON.stringify({
      denApiBase: "https://den-control-plane-veslo.onrender.com",
      token: "seed-token",
      orgId: "org_123",
      user: { id: "user_123", email: "seed@example.com" },
      org: { id: "org_123", slug: "seed-org" },
    }),
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
    source: "e2e-env",
  });
});

test("writeDesktopAuthSeedFile writes the extended snapshot schema into the isolated e2e home", () => {
  const opencodeHome = mkdtempSync(join(tmpdir(), "veslo-e2e-auth-seed-"));
  const snapshotPath = resolveE2EDesktopAuthSnapshotPath(opencodeHome);

  writeDesktopAuthSeedFile(snapshotPath, {
    authJson: "{\"token\":\"seed-token\"}",
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
    source: "e2e-env",
  });

  const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.version, 1);
  assert.equal(parsed.authJson, "{\"token\":\"seed-token\"}");
  assert.equal(parsed.keepSignedIn, true);
  assert.equal(parsed.language, "en");
  assert.equal(parsed.onboardingComplete, true);
  assert.equal(parsed.source, "e2e-env");
  assert.equal(typeof parsed.updatedAt, "number");
});

test("resolveDesktopAuthSeedFromEnv can import an existing snapshot file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "veslo-e2e-auth-seed-file-"));
  const sourcePath = join(tempDir, "den-auth.json");
  writeFileSync(sourcePath, JSON.stringify({
    version: 1,
    authJson: "{\"token\":\"from-file\"}",
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
    updatedAt: Date.now(),
    source: "desktop-runtime",
  }));

  const seed = resolveDesktopAuthSeedFromEnv({
    VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: sourcePath,
  });

  assert.deepEqual(seed, {
    authJson: "{\"token\":\"from-file\"}",
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
    source: "desktop-runtime",
  });
});
