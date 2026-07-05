import assert from "node:assert/strict";
import test from "node:test";

const baseEnv = {
  DATABASE_URL: "mysql://root:root@localhost:3306/veslo_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
};

Object.assign(process.env, baseEnv);

test("Den derives hosted backend URLs from VESLO_DEPLOYMENT_DOMAIN", async () => {
  const { parseEnv } = await import("../src/env.js");
  const parsed = parseEnv({
    ...baseEnv,
    NODE_ENV: "production",
    VESLO_DEPLOYMENT_DOMAIN: "staging.veslo.work",
  });

  assert.equal(parsed.betterAuthUrl, "https://api.staging.veslo.work");
  assert.deepEqual(parsed.corsOrigins, [
    "https://app.staging.veslo.work",
    "https://ai.staging.veslo.work",
  ]);
  assert.equal(parsed.ownedWorkerManager.publicDomainSuffix, "workers.staging.veslo.work");
  assert.equal(
    parsed.googleWorkspace.oauthRedirectUri,
    "https://api.staging.veslo.work/v1/integrations/google/oauth/callback",
  );
  assert.equal(
    parsed.googleWorkspace.oauthSuccessRedirectUrl,
    "https://app.staging.veslo.work/settings/integrations/google",
  );
  assert.equal(parsed.googleWorkspace.connectorBaseUrl, "https://api.staging.veslo.work");
  assert.equal(
    parsed.microsoft.redirectUri,
    "https://api.staging.veslo.work/v1/integrations/microsoft/oauth/callback",
  );
  assert.equal(parsed.microsoft.successRedirectUrl, "https://app.staging.veslo.work/settings/integrations/microsoft");
  assert.equal(parsed.microsoft.connectorBaseUrl, "https://api.staging.veslo.work");
});

test("Den explicit full backend URLs still override deployment-domain defaults", async () => {
  const { parseEnv } = await import("../src/env.js");
  const parsed = parseEnv({
    ...baseEnv,
    NODE_ENV: "production",
    VESLO_DEPLOYMENT_DOMAIN: "staging.veslo.work",
    BETTER_AUTH_URL: "https://api.override.example",
    CORS_ORIGINS: "https://app.override.example",
    OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX: "workers.override.example",
    GOOGLE_WORKSPACE_OAUTH_SUCCESS_REDIRECT_URL: "https://app.override.example/settings/google",
    GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI: "https://api.override.example/google/callback",
    GOOGLE_WORKSPACE_CONNECTOR_BASE_URL: "https://api.override.example/",
    MICROSOFT_REDIRECT_URI: "https://api.override.example/microsoft/callback",
    MICROSOFT_CONNECTOR_BASE_URL: "https://api.override.example/",
  });

  assert.equal(parsed.betterAuthUrl, "https://api.override.example");
  assert.deepEqual(parsed.corsOrigins, ["https://app.override.example"]);
  assert.equal(parsed.ownedWorkerManager.publicDomainSuffix, "workers.override.example");
  assert.equal(parsed.googleWorkspace.oauthSuccessRedirectUrl, "https://app.override.example/settings/google");
  assert.equal(parsed.googleWorkspace.oauthRedirectUri, "https://api.override.example/google/callback");
  assert.equal(parsed.googleWorkspace.connectorBaseUrl, "https://api.override.example");
  assert.equal(parsed.microsoft.redirectUri, "https://api.override.example/microsoft/callback");
  assert.equal(parsed.microsoft.connectorBaseUrl, "https://api.override.example");
});
