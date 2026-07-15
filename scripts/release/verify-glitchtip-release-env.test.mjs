import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const scriptPath = resolve(import.meta.dirname, "./verify-glitchtip-release-env.mjs");
const glitchTipKeys = [
  "VESLO_GLITCHTIP_DSN",
  "VITE_VESLO_GLITCHTIP_DSN",
  "VESLO_GLITCHTIP_ENVIRONMENT",
  "VITE_VESLO_GLITCHTIP_ENVIRONMENT",
  "VESLO_GLITCHTIP_TRACES_SAMPLE_RATE",
  "VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE",
  "VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV",
  "VESLO_GLITCHTIP_SOURCE_MAPS",
  "VESLO_REQUIRE_GLITCHTIP_SOURCE_MAP_UPLOAD",
  "SENTRY_URL",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
];

const envFor = (overrides = {}) => {
  const env = { ...process.env };
  for (const key of glitchTipKeys) {
    delete env[key];
  }
  return { ...env, ...overrides };
};

const runVerifier = (overrides = {}) =>
  spawnSync("node", [scriptPath], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: envFor(overrides),
  });

test("GlitchTip release env verifier warns but passes when non-strict values are missing", () => {
  const result = runVerifier();

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Missing GlitchTip release monitoring env/);
  assert.match(result.stdout, /non-strict build will continue/);
});

test("GlitchTip release env verifier fails closed when strict values are missing", () => {
  const result = runVerifier({ VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV: "1" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing GlitchTip release monitoring env/);
});

test("GlitchTip release env verifier rejects malformed DSN values even outside strict mode", () => {
  const result = runVerifier({
    VESLO_GLITCHTIP_DSN: "http://example.invalid/1",
    VITE_VESLO_GLITCHTIP_DSN: "http://example.invalid/1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VESLO_GLITCHTIP_DSN must use https/);
});

test("GlitchTip release env verifier accepts complete strict release values", () => {
  const result = runVerifier({
    VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV: "1",
    VESLO_GLITCHTIP_DSN: "https://glitchtip.example.invalid/1",
    VITE_VESLO_GLITCHTIP_DSN: "https://glitchtip.example.invalid/1",
    VESLO_GLITCHTIP_ENVIRONMENT: "production",
    VITE_VESLO_GLITCHTIP_ENVIRONMENT: "production",
    VESLO_GLITCHTIP_TRACES_SAMPLE_RATE: "0",
    VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE: "0",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /GlitchTip release monitoring environment is configured/);
});

test("GlitchTip release env verifier fails closed for an incomplete required source-map upload", () => {
  const result = runVerifier({
    VESLO_REQUIRE_GLITCHTIP_SOURCE_MAP_UPLOAD: "1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing GlitchTip source-map upload env/);
});

test("GlitchTip release env verifier accepts complete required source-map upload credentials", () => {
  const result = runVerifier({
    VESLO_REQUIRE_GLITCHTIP_SOURCE_MAP_UPLOAD: "1",
    SENTRY_URL: "https://glitchtip.example.invalid",
    SENTRY_AUTH_TOKEN: "source-map-upload-token",
    SENTRY_ORG: "neatech",
    SENTRY_PROJECT: "veslo",
  });

  assert.equal(result.status, 0);
});
