import assert from "node:assert/strict";
import test from "node:test";

const baseEnv = {
  DATABASE_URL: "mysql://root:root@localhost:3306/veslo_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
};

const productionEmailEnv = {
  LETTR_API_KEY: "lettr-test-key",
  AUTH_EMAIL_ADDRESS: "noreply@veslo.test",
};

Object.assign(process.env, baseEnv);

test("Den derives hosted backend URLs from VESLO_DEPLOYMENT_DOMAIN", async () => {
  const { parseEnv } = await import("../src/env.js");
  const parsed = parseEnv({
    ...baseEnv,
    ...productionEmailEnv,
    NODE_ENV: "production",
    VESLO_DEPLOYMENT_DOMAIN: "staging.veslo.work",
  });

  assert.equal(parsed.betterAuthUrl, "https://api.staging.veslo.work");
  assert.equal(parsed.publicAppBaseUrl, "https://app.staging.veslo.work");
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
    ...productionEmailEnv,
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

test("Den production defaults to required email verification and normalizes provider configuration", async () => {
  const { parseEnv } = await import("../src/env.js");
  const parsed = parseEnv({
    ...baseEnv,
    NODE_ENV: "production",
    LETTR_API_KEY: "  lettr-test-key  ",
    AUTH_EMAIL_ADDRESS: "  noreply@veslo.test  ",
  });

  assert.equal(parsed.authRequireEmailVerification, true);
  assert.equal(parsed.desktopAuthRequireEmailVerified, true);
  assert.equal(parsed.email.lettrApiKey, "lettr-test-key");
  assert.equal(parsed.email.address, "noreply@veslo.test");
});

test("Den production cannot opt out of required email verification", async () => {
  const { parseEnv } = await import("../src/env.js");

  for (const configuredValue of ["false", "  false  "]) {
    const parsed = parseEnv({
      ...baseEnv,
      ...productionEmailEnv,
      NODE_ENV: "production",
      DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: configuredValue,
    });

    assert.equal(parsed.authRequireEmailVerification, true);
    assert.equal(parsed.desktopAuthRequireEmailVerified, true);
  }

  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
    }),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  );
});

test("Den strictly parses explicit email verification flags", async () => {
  const { parseEnv } = await import("../src/env.js");

  for (const configuredValue of ["enabled", "tru", "0", ""]) {
    assert.throws(
      () => parseEnv({
        ...baseEnv,
        NODE_ENV: "development",
        DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: configuredValue,
      }),
      /DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED must be either 'true' or 'false'/,
    );
  }
  assert.throws(
    () => parseEnv({
      ...baseEnv,
      ...productionEmailEnv,
      NODE_ENV: "production",
      DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "disabled",
    }),
    /DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED must be either 'true' or 'false'/,
  );

  const enabled = parseEnv({
    ...baseEnv,
    ...productionEmailEnv,
    NODE_ENV: "development",
    DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "  TrUe  ",
  });
  const disabled = parseEnv({
    ...baseEnv,
    NODE_ENV: "development",
    DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "  FaLsE  ",
  });

  assert.equal(enabled.authRequireEmailVerification, true);
  assert.equal(disabled.authRequireEmailVerification, false);
});

test("Den rejects missing or blank email delivery configuration when verification is required", async () => {
  const { parseEnv } = await import("../src/env.js");

  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
    }),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  );
  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      AUTH_EMAIL_ADDRESS: "noreply@veslo.test",
    }),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  );
  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      LETTR_API_KEY: "   ",
      AUTH_EMAIL_ADDRESS: "noreply@veslo.test",
    }),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  );
  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      LETTR_API_KEY: "lettr-test-key",
    }),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  );
  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      LETTR_API_KEY: "lettr-test-key",
      AUTH_EMAIL_ADDRESS: "   ",
    }),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  );
});

test("Den supports an explicit development opt-out from required email verification", async () => {
  const { parseEnv } = await import("../src/env.js");
  const parsed = parseEnv({
    ...baseEnv,
    NODE_ENV: "development",
    DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
  });

  assert.equal(parsed.authRequireEmailVerification, false);
  assert.equal(parsed.desktopAuthRequireEmailVerified, false);
});

test("Den normalizes supported NODE_ENV values before deriving verification policy", async () => {
  const { parseEnv } = await import("../src/env.js");

  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: " production ",
      DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
    }),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  );

  const production = parseEnv({
    ...baseEnv,
    ...productionEmailEnv,
    NODE_ENV: " PrOdUcTiOn ",
    DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
  });
  assert.equal(production.authRequireEmailVerification, true);

  for (const nodeEnv of [" development ", " TEST "]) {
    const parsed = parseEnv({
      ...baseEnv,
      NODE_ENV: nodeEnv,
      DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
    });
    assert.equal(parsed.authRequireEmailVerification, false);
  }
});

test("Den rejects malformed or production-like NODE_ENV values instead of falling back", async () => {
  const { parseEnv } = await import("../src/env.js");

  for (const nodeEnv of ["prod", "productionx", "staging", "", "   "]) {
    assert.throws(
      () => parseEnv({
        ...baseEnv,
        NODE_ENV: nodeEnv,
        DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
      }),
      /NODE_ENV must be one of 'development', 'test', or 'production'/,
    );
  }
});

test("Den keeps the missing NODE_ENV compatibility default in development mode", async () => {
  const { parseEnv } = await import("../src/env.js");
  const parsed = parseEnv({
    ...baseEnv,
    DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
  });

  assert.equal(parsed.authRequireEmailVerification, false);
});
