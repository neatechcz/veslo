import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareDesktopAuthSeed,
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

test("resolveDesktopAuthSeedFromEnv tolerates a UTF-8 BOM in snapshot files", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "veslo-e2e-auth-seed-bom-"));
  const sourcePath = join(tempDir, "den-auth.json");
  writeFileSync(
    sourcePath,
    `\uFEFF${JSON.stringify({
      version: 1,
      authJson: "{\"token\":\"from-bom\"}",
      keepSignedIn: true,
      language: "en",
      onboardingComplete: true,
      updatedAt: Date.now(),
      source: "desktop-runtime",
    })}`,
  );

  const seed = resolveDesktopAuthSeedFromEnv({
    VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: sourcePath,
  });

  assert.deepEqual(seed, {
    authJson: "{\"token\":\"from-bom\"}",
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
    source: "desktop-runtime",
  });
});

test("prepareDesktopAuthSeed preserves an existing custom-profile snapshot when preserveExisting is enabled", () => {
  const opencodeHome = mkdtempSync(join(tmpdir(), "veslo-e2e-auth-preserve-"));
  const snapshotPath = resolveE2EDesktopAuthSnapshotPath(opencodeHome);
  writeDesktopAuthSeedFile(snapshotPath, {
    authJson: "{\"token\":\"keep-me\"}",
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
    source: "desktop-runtime",
  });

  try {
    const preparedPath = prepareDesktopAuthSeed(opencodeHome, {}, { preserveExisting: true });
    assert.equal(preparedPath, snapshotPath);

    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    assert.equal(parsed.authJson, "{\"token\":\"keep-me\"}");
    assert.equal(parsed.source, "desktop-runtime");
  } finally {
    rmSync(opencodeHome, { recursive: true, force: true });
  }
});

test("prepareDesktopAuthSeed clears an existing snapshot by default when no replacement seed is provided", () => {
  const opencodeHome = mkdtempSync(join(tmpdir(), "veslo-e2e-auth-clear-"));
  const snapshotPath = resolveE2EDesktopAuthSnapshotPath(opencodeHome);
  writeDesktopAuthSeedFile(snapshotPath, {
    authJson: "{\"token\":\"stale\"}",
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
    source: "desktop-runtime",
  });

  try {
    prepareDesktopAuthSeed(opencodeHome, {});
    assert.equal(existsSync(snapshotPath), false);
  } finally {
    rmSync(opencodeHome, { recursive: true, force: true });
  }
});
