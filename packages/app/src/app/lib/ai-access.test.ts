import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_ACCESS_INVALID_MESSAGE,
  AI_ACCESS_NOT_CONFIGURED_MESSAGE,
  formatManagedAiAccessConfig,
  resolveManagedAiAccess,
} from "./ai-access.js";
import { OPENCODE_SESSION_ID_TEMPLATE } from "./opencode.js";

test("resolveManagedAiAccess returns a configured profile for valid admin policy", () => {
  const result = resolveManagedAiAccess({
    id: "ai_access_123",
    userId: "user_123",
    enabled: true,
    provider: "openai",
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini", "gpt-4.1"],
    updatedAt: "2026-04-08T12:00:00.000Z",
  });

  assert.deepEqual(result, {
    profile: {
      userId: "user_123",
      providerId: "openai",
      defaultModel: {
        providerID: "openai",
        modelID: "gpt-4o-mini",
      },
      allowedModels: ["gpt-4o-mini", "gpt-4.1"],
      updatedAt: "2026-04-08T12:00:00.000Z",
    },
    reason: null,
  });
});

test("resolveManagedAiAccess reports unconfigured access for missing or disabled records", () => {
  assert.deepEqual(resolveManagedAiAccess(null), {
    profile: null,
    reason: AI_ACCESS_NOT_CONFIGURED_MESSAGE,
  });

  assert.deepEqual(
    resolveManagedAiAccess({
      id: "ai_access_123",
      userId: "user_123",
      enabled: false,
      provider: "openai",
      defaultModel: "gpt-4o-mini",
      allowedModels: [],
      updatedAt: null,
    }),
    {
      profile: null,
      reason: AI_ACCESS_NOT_CONFIGURED_MESSAGE,
    },
  );
});

test("resolveManagedAiAccess rejects incomplete admin policy payloads", () => {
  assert.deepEqual(
    resolveManagedAiAccess({
      id: "ai_access_123",
      userId: "user_123",
      enabled: true,
      provider: "openai",
      defaultModel: "gpt-4o-mini",
      allowedModels: ["gpt-4.1"],
      updatedAt: null,
    }),
    {
      profile: null,
      reason: AI_ACCESS_INVALID_MESSAGE,
    },
  );
});

test("formatManagedAiAccessConfig writes admin-managed default model and gateway routing", () => {
  const content = formatManagedAiAccessConfig(
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        openai: {
          options: {
            headers: {
              "x-keep": "1",
            },
          },
        },
      },
    }),
    {
      profile: {
        userId: "user_123",
        providerId: "openai",
        defaultModel: {
          providerID: "openai",
          modelID: "gpt-4o-mini",
        },
        allowedModels: ["gpt-4o-mini"],
        updatedAt: "2026-04-08T12:00:00.000Z",
      },
      serverBaseUrl: "https://veslo.example.test",
      gatewayAccessToken: "den_token_123",
    },
  );

  const parsed = JSON.parse(content) as {
    model?: string;
    provider?: {
      openai?: {
        options?: {
          baseURL?: string;
          headers?: Record<string, string>;
        };
      };
    };
  };

  assert.equal(parsed.model, "openai/gpt-4o-mini");
  assert.equal(parsed.provider?.openai?.options?.baseURL, "https://veslo.example.test/ai-gateway/providers/openai/v1");
  assert.deepEqual(parsed.provider?.openai?.options?.headers, {
    "x-keep": "1",
    "x-veslo-gateway-token": "den_token_123",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("formatManagedAiAccessConfig routes codex_oauth through the gateway", () => {
  const content = formatManagedAiAccessConfig(
    "{}",
    {
      profile: {
        userId: "user_123",
        providerId: "codex_oauth",
        defaultModel: {
          providerID: "codex_oauth",
          modelID: "gpt-5.4",
        },
        allowedModels: ["gpt-5.4"],
        updatedAt: null,
      },
      serverBaseUrl: "https://veslo.example.test",
      gatewayAccessToken: "den_token_123",
    },
  );

  const parsed = JSON.parse(content) as {
    model?: string;
    provider?: {
      codex_oauth?: {
        options?: {
          baseURL?: string;
          headers?: Record<string, string>;
        };
      };
    };
  };

  assert.equal(parsed.model, "codex_oauth/gpt-5.4");
  assert.equal(
    parsed.provider?.codex_oauth?.options?.baseURL,
    "https://veslo.example.test/ai-gateway/providers/codex_oauth/v1",
  );
  assert.deepEqual(parsed.provider?.codex_oauth?.options?.headers, {
    "x-veslo-gateway-token": "den_token_123",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});
