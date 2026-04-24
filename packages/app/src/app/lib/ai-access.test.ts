import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_ACCESS_INVALID_MESSAGE,
  AI_ACCESS_NOT_CONFIGURED_MESSAGE,
  formatManagedAiAccessConfig,
  type ManagedAiAccessProfile,
  resolveManagedAiAccess,
  shouldPreserveManagedAiConfig,
  shouldEnsureManagedAiLocalGateway,
  shouldDeferManagedAiAccessRefresh,
} from "./ai-access.js";
import { OPENCODE_SESSION_ID_TEMPLATE } from "./opencode.js";

const managedCodexProfile: ManagedAiAccessProfile = {
  userId: "user_123",
  providerId: "codex_oauth",
  defaultModel: {
    providerID: "codex_oauth",
    modelID: "gpt-5.4",
  },
  allowedModels: ["gpt-5.4"],
  updatedAt: null,
};

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

test("shouldDeferManagedAiAccessRefresh waits for the local desktop client token before gateway fetch", () => {
  assert.equal(
    shouldDeferManagedAiAccessRefresh({
      gatewayBaseUrl: "http://127.0.0.1:8787",
      isDesktopRuntime: true,
      localClientToken: "",
    }),
    true,
  );

  assert.equal(
    shouldDeferManagedAiAccessRefresh({
      gatewayBaseUrl: "http://127.0.0.1:8787",
      isDesktopRuntime: true,
      localClientToken: "client-token",
    }),
    false,
  );

  assert.equal(
    shouldDeferManagedAiAccessRefresh({
      gatewayBaseUrl: "https://veslo.example.test",
      isDesktopRuntime: true,
      localClientToken: "",
    }),
    false,
  );
});

test("shouldEnsureManagedAiLocalGateway starts the desktop local gateway for signed-in local workspaces", () => {
  assert.equal(
    shouldEnsureManagedAiLocalGateway({
      isDesktopRuntime: true,
      workspaceType: "local",
      userToken: "den-token",
      localServerRunning: false,
      localClientToken: "",
    }),
    true,
  );
  assert.equal(
    shouldEnsureManagedAiLocalGateway({
      isDesktopRuntime: true,
      workspaceType: "local",
      userToken: "den-token",
      localServerRunning: true,
      localClientToken: "",
    }),
    true,
  );
  assert.equal(
    shouldEnsureManagedAiLocalGateway({
      isDesktopRuntime: true,
      workspaceType: "local",
      userToken: "den-token",
      localServerRunning: true,
      localClientToken: "client-token",
    }),
    false,
  );
  assert.equal(
    shouldEnsureManagedAiLocalGateway({
      isDesktopRuntime: false,
      workspaceType: "local",
      userToken: "den-token",
      localServerRunning: false,
      localClientToken: "",
    }),
    false,
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
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "den_token_123",
    },
  );

  const parsed = JSON.parse(content) as {
    model?: string;
    provider?: {
      openai?: {
        models?: Record<string, {
          headers?: Record<string, string>;
        }>;
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
  });
  assert.deepEqual(parsed.provider?.openai?.models?.["gpt-4o-mini"]?.headers, {
    Authorization: "Bearer veslo-client-token",
    "x-veslo-gateway-token": "den_token_123",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("formatManagedAiAccessConfig routes codex_oauth through the gateway", () => {
  const content = formatManagedAiAccessConfig(
    "{}",
    {
      profile: managedCodexProfile,
      serverBaseUrl: "https://veslo.example.test",
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "den_token_123",
    },
  );

  const parsed = JSON.parse(content) as {
    model?: string;
    provider?: {
      codex_oauth?: {
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
          baseURL?: string;
          headers?: Record<string, string>;
        };
      };
    };
  };

  assert.equal(parsed.model, "codex_oauth/gpt-5.4");
  assert.equal(parsed.provider?.codex_oauth?.name, "Veslo Codex OAuth");
  assert.equal(parsed.provider?.codex_oauth?.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(parsed.provider?.codex_oauth?.env, []);
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.name, "gpt-5.4");
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.tool_call, true);
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.reasoning, true);
  assert.equal(
    parsed.provider?.codex_oauth?.options?.baseURL,
    "https://veslo.example.test/ai-gateway/providers/codex_oauth/v1",
  );
  assert.equal(parsed.provider?.codex_oauth?.options?.apiKey, "veslo-client-token");
  assert.equal(parsed.provider?.codex_oauth?.options?.headers, undefined);
  assert.deepEqual(parsed.provider?.codex_oauth?.models?.["gpt-5.4"]?.headers, {
    "x-veslo-gateway-token": "den_token_123",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("shouldPreserveManagedAiConfig keeps existing gateway routing while managed access is still loading", () => {
  const content = formatManagedAiAccessConfig("{}", {
    profile: managedCodexProfile,
    serverBaseUrl: "https://veslo.example.test",
    serverClientToken: "veslo-client-token",
    gatewayAccessToken: "gateway-access-token",
  });

  assert.equal(
    shouldPreserveManagedAiConfig({
      content,
      managedProfile: null,
      gatewayBaseUrl: "",
      serverClientToken: "",
      gatewayAccessToken: "",
      accessBusy: true,
      accessError: null,
    }),
    true,
  );
});

test("shouldPreserveManagedAiConfig keeps existing gateway routing when the managed gateway token is temporarily unavailable", () => {
  const content = formatManagedAiAccessConfig("{}", {
    profile: managedCodexProfile,
    serverBaseUrl: "https://veslo.example.test",
    serverClientToken: "veslo-client-token",
    gatewayAccessToken: "gateway-access-token",
  });

  assert.equal(
    shouldPreserveManagedAiConfig({
      content,
      managedProfile: managedCodexProfile,
      gatewayBaseUrl: "https://veslo.example.test",
      serverClientToken: "",
      gatewayAccessToken: "",
      accessBusy: false,
      accessError: AI_ACCESS_INVALID_MESSAGE,
    }),
    true,
  );
});

test("shouldPreserveManagedAiConfig allows model-only fallback when the config is not already gateway-managed", () => {
  assert.equal(
    shouldPreserveManagedAiConfig({
      content: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "codex_oauth/gpt-5.4",
      }),
      managedProfile: managedCodexProfile,
      gatewayBaseUrl: "https://veslo.example.test",
      serverClientToken: "",
      gatewayAccessToken: "",
      accessBusy: false,
      accessError: AI_ACCESS_INVALID_MESSAGE,
    }),
    false,
  );
});

test("shouldPreserveManagedAiConfig keeps an existing managed config even when access temporarily reads as not configured", () => {
  const content = formatManagedAiAccessConfig("{}", {
    profile: managedCodexProfile,
    serverBaseUrl: "https://veslo.example.test",
    serverClientToken: "veslo-client-token",
    gatewayAccessToken: "gateway-access-token",
  });

  assert.equal(
    shouldPreserveManagedAiConfig({
      content,
      managedProfile: null,
      gatewayBaseUrl: "",
      serverClientToken: "",
      gatewayAccessToken: "",
      accessBusy: false,
      accessError: AI_ACCESS_NOT_CONFIGURED_MESSAGE,
    }),
    true,
  );
});

test("shouldPreserveManagedAiConfig keeps an existing managed config when the server client token is temporarily unavailable", () => {
  const content = formatManagedAiAccessConfig("{}", {
    profile: managedCodexProfile,
    serverBaseUrl: "https://veslo.example.test",
    serverClientToken: "veslo-client-token",
    gatewayAccessToken: "gateway-access-token",
  });

  assert.equal(
    shouldPreserveManagedAiConfig({
      content,
      managedProfile: managedCodexProfile,
      gatewayBaseUrl: "https://veslo.example.test",
      serverClientToken: "",
      gatewayAccessToken: "gateway-access-token",
      accessBusy: false,
      accessError: null,
    }),
    true,
  );
});
