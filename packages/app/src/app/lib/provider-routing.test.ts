import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCODE_SESSION_ID_TEMPLATE,
  applyGatewayProviderRouting,
} from "./opencode.js";

test("openai provider config points at ai-gateway openai route", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({
      provider: {
        openai: {
          options: {
            apiKey: "sk-proj-openai-secret",
          },
        },
      },
    }),
    {
      providerId: "openai",
      serverBaseUrl: "http://127.0.0.1:4318",
      gatewayAccessToken: "gateway-access-token",
    },
  );

  const parsed = JSON.parse(updated) as {
    provider?: {
      openai?: {
        options?: {
          apiKey?: string;
          baseURL?: string;
          headers?: Record<string, string>;
        };
      };
    };
  };

  assert.equal(parsed.provider?.openai?.options?.baseURL, "http://127.0.0.1:4318/ai-gateway/providers/openai/v1");
  assert.equal(parsed.provider?.openai?.options?.apiKey, undefined);
  assert.deepEqual(parsed.provider?.openai?.options?.headers, {
    "x-veslo-gateway-token": "gateway-access-token",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("anthropic provider config points at ai-gateway anthropic route", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({
      provider: {
        anthropic: {
          options: {
            apiKey: "sk-ant-secret",
          },
        },
      },
    }),
    {
      providerId: "anthropic",
      serverBaseUrl: "http://127.0.0.1:4318/",
      gatewayAccessToken: "gateway-access-token",
    },
  );

  const parsed = JSON.parse(updated) as {
    provider?: {
      anthropic?: {
        options?: {
          apiKey?: string;
          baseURL?: string;
          headers?: Record<string, string>;
        };
      };
    };
  };

  assert.equal(parsed.provider?.anthropic?.options?.baseURL, "http://127.0.0.1:4318/ai-gateway/providers/anthropic/v1");
  assert.equal(parsed.provider?.anthropic?.options?.apiKey, undefined);
  assert.deepEqual(parsed.provider?.anthropic?.options?.headers, {
    "x-veslo-gateway-token": "gateway-access-token",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("gateway access token is stored as a gateway credential, not a raw provider secret", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({
      provider: {
        openai: {
          options: {
            apiKey: "sk-proj-openai-secret",
            headers: {
              Authorization: "Bearer sk-proj-openai-secret",
              "x-extra": "keep-me",
            },
          },
        },
      },
    }),
    {
      providerId: "openai",
      serverBaseUrl: "http://127.0.0.1:4318",
      gatewayAccessToken: "gateway-access-token",
    },
  );

  assert.match(updated, /gateway-access-token/);
  assert.doesNotMatch(updated, /sk-proj-openai-secret/);

  const parsed = JSON.parse(updated) as {
    provider?: {
      openai?: {
        options?: {
          headers?: Record<string, string>;
        };
      };
    };
  };

  assert.deepEqual(parsed.provider?.openai?.options?.headers, {
    "x-extra": "keep-me",
    "x-veslo-gateway-token": "gateway-access-token",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("migrated provider config export redacts provider secrets while keeping gateway routing", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({
      provider: {
        anthropic: {
          options: {
            apiKey: "sk-ant-secret",
            access_token: "access_token_live",
            refresh_token: "refresh_token_live",
            headers: {
              "x-api-key": "sk-proj-secret",
              access_token: "access_token_live",
              refresh_token: "refresh_token_live",
              "x-extra": "keep-me",
            },
          },
        },
      },
    }),
    {
      providerId: "anthropic",
      serverBaseUrl: "http://127.0.0.1:4318",
      gatewayAccessToken: "gateway-access-token",
    },
  );

  assert.match(updated, /gateway-access-token/);
  assert.doesNotMatch(updated, /sk-ant|sk-proj|refresh_token|access_token/);

  const parsed = JSON.parse(updated) as {
    provider?: {
      anthropic?: {
        options?: {
          headers?: Record<string, string>;
          access_token?: string;
          refresh_token?: string;
        };
      };
    };
  };

  assert.equal(parsed.provider?.anthropic?.options?.access_token, undefined);
  assert.equal(parsed.provider?.anthropic?.options?.refresh_token, undefined);
  assert.deepEqual(parsed.provider?.anthropic?.options?.headers, {
    "x-extra": "keep-me",
    "x-veslo-gateway-token": "gateway-access-token",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});
