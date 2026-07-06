import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCODE_SESSION_ID_TEMPLATE,
  VESLO_OPENCODE_SERVER_CLIENT_TOKEN_ENV,
  VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE,
  applyGatewayProviderRouting,
  managedConfigContentsMatchForServerPatch,
} from "../../lib/opencode.js";

const EXPECTED_CODEX_MODEL_OPTIONS = {
  reasoningEffort: "high",
  textVerbosity: "low",
  reasoningSummary: "auto",
};

const EXPECTED_CODEX_MODEL_VARIANTS = {
  low: {
    reasoningEffort: "low",
    textVerbosity: "low",
    reasoningSummary: "auto",
  },
  medium: {
    reasoningEffort: "medium",
    textVerbosity: "low",
    reasoningSummary: "auto",
  },
  high: EXPECTED_CODEX_MODEL_OPTIONS,
  xhigh: EXPECTED_CODEX_MODEL_OPTIONS,
};

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
      serverClientToken: "veslo-client-token",
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
    Authorization: `Bearer ${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE}`,
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
      serverClientToken: "veslo-client-token",
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
    Authorization: `Bearer ${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE}`,
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
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["gpt-5.4"],
    },
  );

  const parsed = JSON.parse(updated) as {
    provider?: {
      codex_oauth?: {
        models?: Record<string, {
          name?: string;
          tool_call?: boolean;
          reasoning?: boolean;
          options?: Record<string, unknown>;
          variants?: Record<string, unknown>;
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
  assert.equal(parsed.provider?.codex_oauth?.options?.apiKey, VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE);
  assert.equal(parsed.provider?.codex_oauth?.options?.headers, undefined);
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.name, "gpt-5.4");
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.tool_call, true);
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.reasoning, true);
  assert.deepEqual(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.options, EXPECTED_CODEX_MODEL_OPTIONS);
  assert.deepEqual(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.variants, EXPECTED_CODEX_MODEL_VARIANTS);
  assert.deepEqual(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.headers, {
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("gateway provider config scrubs stale workspace correlation headers", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({
      provider: {
        codex_oauth: {
          models: {
            "gpt-5.5": {
              headers: {
                "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
                "x-veslo-workspace-id": "ws_stale",
              },
            },
          },
        },
      },
    }),
    {
      providerId: "codex_oauth",
      serverBaseUrl: "http://127.0.0.1:4318/",
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "gateway-access-token",
      workspaceId: "ws_1",
      models: ["gpt-5.5"],
    },
  );

  const parsed = JSON.parse(updated) as {
    provider?: {
      codex_oauth?: {
        models?: Record<string, {
          headers?: Record<string, string>;
        }>;
      };
    };
  };

  assert.deepEqual(parsed.provider?.codex_oauth?.models?.["gpt-5.5"]?.headers, {
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("openai_compatible provider config points at ai-gateway custom route", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({ provider: {} }),
    {
      providerId: "openai_compatible",
      serverBaseUrl: "http://127.0.0.1:4318",
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["custom-model"],
    },
  );

  const parsed = JSON.parse(updated) as {
    provider?: {
      openai_compatible?: {
        name?: string;
        npm?: string;
        env?: string[];
        models?: Record<string, {
          name?: string;
          tool_call?: boolean;
          reasoning?: boolean;
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

  assert.equal(parsed.provider?.openai_compatible?.name, "OpenAI-compatible");
  assert.equal(parsed.provider?.openai_compatible?.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(parsed.provider?.openai_compatible?.env, [VESLO_OPENCODE_SERVER_CLIENT_TOKEN_ENV]);
  assert.equal(
    parsed.provider?.openai_compatible?.options?.baseURL,
    "http://127.0.0.1:4318/ai-gateway/providers/openai_compatible/v1",
  );
  assert.equal(parsed.provider?.openai_compatible?.options?.apiKey, VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE);
  assert.equal(parsed.provider?.openai_compatible?.options?.headers, undefined);
  assert.equal(parsed.provider?.openai_compatible?.models?.["custom-model"]?.name, "custom-model");
  assert.equal(parsed.provider?.openai_compatible?.models?.["custom-model"]?.tool_call, true);
  assert.equal(parsed.provider?.openai_compatible?.models?.["custom-model"]?.reasoning, true);
  assert.deepEqual(parsed.provider?.openai_compatible?.models?.["custom-model"]?.headers, {
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("codex_oauth provider config includes assigned gpt-5.5 without changing the default model", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({
      model: "codex_oauth/gpt-5.4",
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
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["gpt-5.4", "gpt-5.5"],
    },
  );

  const parsed = JSON.parse(updated) as {
    model?: string;
    provider?: {
      codex_oauth?: {
        models?: Record<string, {
          name?: string;
          tool_call?: boolean;
          reasoning?: boolean;
          options?: Record<string, unknown>;
          variants?: Record<string, unknown>;
          headers?: Record<string, string>;
        }>;
      };
    };
  };

  assert.equal(parsed.model, "codex_oauth/gpt-5.4");
  for (const modelId of ["gpt-5.4", "gpt-5.5"]) {
    assert.equal(parsed.provider?.codex_oauth?.models?.[modelId]?.name, modelId);
    assert.equal(parsed.provider?.codex_oauth?.models?.[modelId]?.tool_call, true);
    assert.equal(parsed.provider?.codex_oauth?.models?.[modelId]?.reasoning, true);
    assert.deepEqual(parsed.provider?.codex_oauth?.models?.[modelId]?.options, EXPECTED_CODEX_MODEL_OPTIONS);
    assert.deepEqual(parsed.provider?.codex_oauth?.models?.[modelId]?.variants, EXPECTED_CODEX_MODEL_VARIANTS);
    assert.deepEqual(parsed.provider?.codex_oauth?.models?.[modelId]?.headers, {
      "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
    });
  }
});

test("managed provider config does not persist runtime gateway credentials", () => {
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
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["gpt-4o-mini"],
    },
  );

  assert.doesNotMatch(updated, /gateway-access-token/);
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
    Authorization: `Bearer ${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE}`,
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("migrated provider config export removes provider secrets while keeping gateway routing", () => {
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
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["claude-sonnet-4-20250514"],
    },
  );

  assert.doesNotMatch(updated, /gateway-access-token/);
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
    Authorization: `Bearer ${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE}`,
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("server-backed managed config comparison requires a patch when legacy gateway tokens are redacted", () => {
  const desired = applyGatewayProviderRouting(
    JSON.stringify({
      model: "codex_oauth/gpt-5.4",
      provider: {
        codex_oauth: {
          options: {
            baseURL: "http://127.0.0.1:4318/ai-gateway/providers/codex_oauth/v1",
          },
          models: {
            "gpt-5.4": {
              headers: {
                "x-veslo-gateway-token": "[REDACTED]",
                "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
              },
            },
          },
        },
      },
    }),
    {
      providerId: "codex_oauth",
      serverBaseUrl: "http://127.0.0.1:4318",
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["gpt-5.4"],
    },
  );

  const redactedCurrent = desired.replace("gateway-access-token", "[REDACTED]");
  const currentWithLegacyGatewayToken = redactedCurrent.replace(
    `"x-veslo-session-id": "${OPENCODE_SESSION_ID_TEMPLATE}"`,
    `"x-veslo-gateway-token": "[REDACTED]", "x-veslo-session-id": "${OPENCODE_SESSION_ID_TEMPLATE}"`,
  );

  assert.equal(
    managedConfigContentsMatchForServerPatch(currentWithLegacyGatewayToken, desired),
    false,
  );
});

test("server-backed managed config comparison requires a patch when the local server token is redacted", () => {
  const desired = applyGatewayProviderRouting(
    JSON.stringify({
      model: "codex_oauth/gpt-5.4",
      provider: {
        codex_oauth: {
          options: {
            baseURL: "http://127.0.0.1:4318/ai-gateway/providers/codex_oauth/v1",
          },
          models: {
            "gpt-5.4": {
              headers: {
                "x-veslo-gateway-token": "[REDACTED]",
                "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
              },
            },
          },
        },
      },
    }),
    {
      providerId: "codex_oauth",
      serverBaseUrl: "http://127.0.0.1:4318",
      serverClientToken: "new-local-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["gpt-5.4"],
    },
  );

  const redactedCurrent = desired.replace(VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE, "[REDACTED]");

  assert.equal(
    managedConfigContentsMatchForServerPatch(redactedCurrent, desired),
    false,
  );
});

test("server-backed managed config comparison requires a patch when model authorization is redacted", () => {
  const desired = applyGatewayProviderRouting(
    JSON.stringify({
      model: "openai/gpt-5.4",
      provider: {
        openai: {
          options: {
            baseURL: "http://127.0.0.1:4318/ai-gateway/providers/openai/v1",
          },
          models: {
            "gpt-5.4": {
              headers: {
                "x-veslo-gateway-token": "[REDACTED]",
                "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
              },
            },
          },
        },
      },
    }),
    {
      providerId: "openai",
      serverBaseUrl: "http://127.0.0.1:4318",
      serverClientToken: "new-local-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["gpt-5.4"],
    },
  );

  const redactedCurrent = desired.replace(`Bearer ${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE}`, "[REDACTED]");

  assert.equal(
    managedConfigContentsMatchForServerPatch(redactedCurrent, desired),
    false,
  );
});
