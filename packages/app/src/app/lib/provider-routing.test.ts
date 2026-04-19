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
      models: ["gpt-4o-mini"],
    },
  );

  const parsed = JSON.parse(updated) as {
    provider?: {
      openai?: {
        models?: Record<string, {
          headers?: Record<string, string>;
        }>;
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
  assert.equal(parsed.provider?.openai?.options?.headers, undefined);
  assert.deepEqual(parsed.provider?.openai?.models?.["gpt-4o-mini"]?.headers, {
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
      models: ["claude-sonnet-4-20250514"],
    },
  );

  const parsed = JSON.parse(updated) as {
    provider?: {
      anthropic?: {
        models?: Record<string, {
          headers?: Record<string, string>;
        }>;
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
  assert.equal(parsed.provider?.anthropic?.options?.headers, undefined);
  assert.deepEqual(parsed.provider?.anthropic?.models?.["claude-sonnet-4-20250514"]?.headers, {
    "x-veslo-gateway-token": "gateway-access-token",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("codex_oauth provider config points at ai-gateway codex route", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({
      provider: {
        codex_oauth: {
          options: {
            apiKey: "sk-provider-secret",
          },
        },
      },
    }),
    {
      providerId: "codex_oauth",
      serverBaseUrl: "http://127.0.0.1:4318/",
      gatewayAccessToken: "gateway-access-token",
      models: ["gpt-5.4"],
    },
  );

  const parsed = JSON.parse(updated) as {
    provider?: {
      codex_oauth?: {
        models?: Record<string, {
          headers?: Record<string, string>;
        }>;
        options?: {
          apiKey?: string;
          baseURL?: string;
          headers?: Record<string, string>;
        };
      };
    };
  };

  assert.equal(parsed.provider?.codex_oauth?.options?.baseURL, "http://127.0.0.1:4318/ai-gateway/providers/codex_oauth/v1");
  assert.equal(parsed.provider?.codex_oauth?.options?.apiKey, undefined);
  assert.equal(parsed.provider?.codex_oauth?.options?.headers, undefined);
  assert.deepEqual(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.headers, {
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
      models: ["gpt-4o-mini"],
    },
  );

  assert.match(updated, /gateway-access-token/);
  assert.doesNotMatch(updated, /sk-proj-openai-secret/);

  const parsed = JSON.parse(updated) as {
    provider?: {
      openai?: {
        models?: Record<string, {
          headers?: Record<string, string>;
        }>;
        options?: {
          headers?: Record<string, string>;
        };
      };
    };
  };

  assert.deepEqual(parsed.provider?.openai?.options?.headers, {
    "x-extra": "keep-me",
  });
  assert.deepEqual(parsed.provider?.openai?.models?.["gpt-4o-mini"]?.headers, {
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
      models: ["claude-sonnet-4-20250514"],
    },
  );

  assert.match(updated, /gateway-access-token/);
  assert.doesNotMatch(updated, /sk-ant|sk-proj|refresh_token|access_token/);

  const parsed = JSON.parse(updated) as {
    provider?: {
      anthropic?: {
        models?: Record<string, {
          headers?: Record<string, string>;
        }>;
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
  });
  assert.deepEqual(parsed.provider?.anthropic?.models?.["claude-sonnet-4-20250514"]?.headers, {
    "x-veslo-gateway-token": "gateway-access-token",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});
