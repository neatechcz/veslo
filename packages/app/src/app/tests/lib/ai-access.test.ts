import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_ACCESS_INVALID_MESSAGE,
  AI_ACCESS_NOT_CONFIGURED_MESSAGE,
  DEFAULT_MANAGED_AI_GATEWAY_BASE_URL,
  extractManagedApiKey,
  formatManagedAiAccessConfig,
  type ManagedAiAccessProfile,
  resolveManagedAiAccess,
  resolveManagedAiAccessBundleState,
  resolveManagedAiGatewayBaseUrl,
  resolveManagedAiProviderRoutingTarget,
  shouldPreserveManagedAiConfig,
  shouldEnsureManagedAiLocalGateway,
  shouldDeferManagedAiAccessRefresh,
} from "../../lib/ai-access.js";
import { OPENCODE_SESSION_ID_TEMPLATE } from "../../lib/opencode.js";

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

test("desktop managed AI defaults to the owned server gateway", () => {
  assert.equal(DEFAULT_MANAGED_AI_GATEWAY_BASE_URL, "https://ai.veslo.work");
});

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

test("resolveManagedAiAccessBundleState uses the DEN token when the gateway omits a separate access token", () => {
  const result = resolveManagedAiAccessBundleState({
    aiAccess: {
      id: "ai_access_123",
      userId: "user_123",
      enabled: true,
      provider: "codex_oauth",
      defaultModel: "gpt-5.4",
      allowedModels: ["gpt-5.4"],
      updatedAt: "2026-04-24T15:05:18.147Z",
    },
    accessToken: null,
    fallbackAccessToken: "den-user-token",
    requireGatewayAccessToken: true,
  });

  assert.equal(result.reason, null);
  assert.equal(result.gatewayAccessToken, "den-user-token");
  assert.deepEqual(result.profile, {
    ...managedCodexProfile,
    updatedAt: "2026-04-24T15:05:18.147Z",
  });
});

test("resolveManagedAiAccessBundleState ignores redacted gateway tokens and uses the DEN token fallback", () => {
  const result = resolveManagedAiAccessBundleState({
    aiAccess: {
      id: "ai_access_123",
      userId: "user_123",
      enabled: true,
      provider: "codex_oauth",
      defaultModel: "gpt-5.4",
      allowedModels: ["gpt-5.4"],
      updatedAt: null,
    },
    accessToken: "[REDACTED]",
    fallbackAccessToken: "den-user-token",
    requireGatewayAccessToken: true,
  });

  assert.equal(result.reason, null);
  assert.equal(result.gatewayAccessToken, "den-user-token");
  assert.deepEqual(result.profile, managedCodexProfile);
});

test("extractManagedApiKey ignores redacted server config values", () => {
  assert.equal(
    extractManagedApiKey(JSON.stringify({
      provider: {
        codex_oauth: {
          options: {
            apiKey: "[REDACTED]",
          },
        },
      },
    })),
    null,
  );
  assert.equal(
    extractManagedApiKey(JSON.stringify({
      provider: {
        codex_oauth: {
          options: {
            apiKey: "veslo-client-token",
          },
        },
      },
    })),
    "veslo-client-token",
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

test("resolveManagedAiProviderRoutingTarget keeps the UI URL separate from the engine URL", () => {
  assert.deepEqual(
    resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: true,
      workspaceType: "local",
      activeBaseUrl: "http://127.0.0.1:8787",
      engineBaseUrl: "http://engine-host.internal:8787",
      activeToken: "local-client-token",
      gatewayBaseUrl: "",
      gatewayToken: "",
    }),
    {
      baseUrl: "http://127.0.0.1:8787",
      engineBaseUrl: "http://engine-host.internal:8787",
      serverClientToken: "local-client-token",
    },
  );
});

test("resolveManagedAiGatewayBaseUrl keeps desktop local-first even when env config has a remote Veslo URL", () => {
  assert.equal(
    resolveManagedAiGatewayBaseUrl({
      settingsUrl: "https://den-worker-dev-dev-cloud-worker-2.onrender.com",
      gatewayClientBaseUrl: "http://127.0.0.1:8787",
      localFallbackBaseUrl: "http://127.0.0.1:8787",
      isDesktopRuntime: true,
    }),
    "",
  );

  assert.equal(
    resolveManagedAiGatewayBaseUrl({
      settingsUrl: "https://den-worker-dev-dev-cloud-worker-2.onrender.com",
      gatewayClientBaseUrl: "",
      localFallbackBaseUrl: "http://127.0.0.1:8787",
      isDesktopRuntime: true,
    }),
    "",
  );
});

test("formatManagedAiAccessConfig can route provider calls through an engine-reachable base URL", () => {
  const content = formatManagedAiAccessConfig("{}", {
    profile: managedCodexProfile,
    serverBaseUrl: "http://127.0.0.1:8787",
    engineBaseUrl: "http://engine-host.internal:8787",
    serverClientToken: "veslo-client-token",
    gatewayAccessToken: "gateway-access-token",
  });
  const parsed = JSON.parse(content) as {
    provider?: {
      codex_oauth?: {
        options?: {
          baseURL?: string;
        };
      };
    };
  };

  assert.equal(
    parsed.provider?.codex_oauth?.options?.baseURL,
    "http://engine-host.internal:8787/ai-gateway/providers/codex_oauth/v1",
  );
});

test("resolveManagedAiGatewayBaseUrl uses managed AI gateway instead of remote Veslo URL in desktop remote workspaces", () => {
  assert.equal(
    resolveManagedAiGatewayBaseUrl({
      settingsUrl: "https://den-worker-dev-dev-cloud-worker-2.onrender.com",
      gatewayClientBaseUrl: "https://den-worker-dev-dev-cloud-worker-2.onrender.com",
      localFallbackBaseUrl: "",
      isDesktopRuntime: true,
    }),
    DEFAULT_MANAGED_AI_GATEWAY_BASE_URL,
  );
});

test("resolveManagedAiGatewayBaseUrl still uses remote URLs outside desktop local mode", () => {
  assert.equal(
    resolveManagedAiGatewayBaseUrl({
      settingsUrl: "https://veslo-ai-gateway-dev.onrender.com",
      gatewayClientBaseUrl: "",
      localFallbackBaseUrl: "",
      isDesktopRuntime: false,
    }),
    "https://veslo-ai-gateway-dev.onrender.com",
  );
});

test("resolveManagedAiProviderRoutingTarget keeps desktop local provider routing on the local Veslo server", () => {
  assert.deepEqual(
    resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: true,
      workspaceType: "local",
      activeBaseUrl: "http://127.0.0.1:55021",
      activeToken: "local-client-token",
      gatewayBaseUrl: "https://den-worker-dev-dev-cloud-worker-2.onrender.com",
      gatewayToken: "remote-client-token",
    }),
    {
      baseUrl: "http://127.0.0.1:55021",
      engineBaseUrl: "http://127.0.0.1:55021",
      serverClientToken: "local-client-token",
    },
  );
});

test("resolveManagedAiProviderRoutingTarget does not fall back to remote routing while desktop local token is missing", () => {
  assert.deepEqual(
    resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: true,
      workspaceType: "local",
      activeBaseUrl: "http://127.0.0.1:55021",
      activeToken: "",
      gatewayBaseUrl: "https://den-worker-dev-dev-cloud-worker-2.onrender.com",
      gatewayToken: "remote-client-token",
    }),
    {
      baseUrl: "http://127.0.0.1:55021",
      engineBaseUrl: "http://127.0.0.1:55021",
      serverClientToken: "",
    },
  );
});

test("resolveManagedAiProviderRoutingTarget refuses remote active URLs for desktop local workspaces", () => {
  assert.equal(
    resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: true,
      workspaceType: "local",
      activeBaseUrl: "https://den-worker-dev-dev-cloud-worker-2.onrender.com",
      activeToken: "remote-settings-token",
      gatewayBaseUrl: "https://veslo-ai-gateway-dev.onrender.com",
      gatewayToken: "gateway-token",
    }),
    null,
  );
});

test("resolveManagedAiProviderRoutingTarget keeps remote routing outside desktop local workspaces", () => {
  assert.deepEqual(
    resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: true,
      workspaceType: "remote",
      activeBaseUrl: "http://127.0.0.1:55021",
      activeToken: "local-client-token",
      gatewayBaseUrl: "https://veslo.example.test",
      gatewayToken: "remote-client-token",
    }),
    {
      baseUrl: "https://veslo.example.test",
      engineBaseUrl: "https://veslo.example.test",
      serverClientToken: "remote-client-token",
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
          apiKey?: string;
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
          apiKey?: string;
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

test("formatManagedAiAccessConfig routes openai_compatible through the gateway", () => {
  const content = formatManagedAiAccessConfig(
    "{}",
    {
      profile: {
        userId: "user_123",
        providerId: "openai_compatible",
        defaultModel: {
          providerID: "openai_compatible",
          modelID: "custom-model",
        },
        allowedModels: ["custom-model"],
        updatedAt: null,
      },
      serverBaseUrl: "https://veslo.example.test",
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "den_token_123",
    },
  );

  const parsed = JSON.parse(content) as {
    model?: string;
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

  assert.equal(parsed.model, "openai_compatible/custom-model");
  assert.equal(parsed.provider?.openai_compatible?.name, "OpenAI-compatible");
  assert.equal(parsed.provider?.openai_compatible?.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(parsed.provider?.openai_compatible?.env, []);
  assert.equal(parsed.provider?.openai_compatible?.models?.["custom-model"]?.name, "custom-model");
  assert.equal(parsed.provider?.openai_compatible?.models?.["custom-model"]?.tool_call, true);
  assert.equal(parsed.provider?.openai_compatible?.models?.["custom-model"]?.reasoning, true);
  assert.equal(
    parsed.provider?.openai_compatible?.options?.baseURL,
    "https://veslo.example.test/ai-gateway/providers/openai_compatible/v1",
  );
  assert.equal(parsed.provider?.openai_compatible?.options?.apiKey, "veslo-client-token");
  assert.equal(parsed.provider?.openai_compatible?.options?.headers, undefined);
  assert.deepEqual(parsed.provider?.openai_compatible?.models?.["custom-model"]?.headers, {
    "x-veslo-gateway-token": "den_token_123",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  });
});

test("formatManagedAiAccessConfig supports assigned gpt-5.5 without making it the default", () => {
  const content = formatManagedAiAccessConfig(
    "{}",
    {
      profile: {
        ...managedCodexProfile,
        allowedModels: ["gpt-5.4", "gpt-5.5"],
      },
      serverBaseUrl: "https://veslo.example.test",
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "den_token_123",
    },
  );

  const parsed = JSON.parse(content) as {
    model?: string;
    provider?: {
      codex_oauth?: {
        models?: Record<string, {
          name?: string;
          tool_call?: boolean;
          reasoning?: boolean;
          headers?: Record<string, string>;
        }>;
      };
    };
  };

  assert.equal(parsed.model, "codex_oauth/gpt-5.4");
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.5"]?.name, "gpt-5.5");
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.5"]?.tool_call, true);
  assert.equal(parsed.provider?.codex_oauth?.models?.["gpt-5.5"]?.reasoning, true);
  assert.deepEqual(parsed.provider?.codex_oauth?.models?.["gpt-5.5"]?.headers, {
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

test("shouldPreserveManagedAiConfig rejects stale remote gateway routing when a local gateway is expected", () => {
  const content = formatManagedAiAccessConfig("{}", {
    profile: managedCodexProfile,
    serverBaseUrl: "https://den-worker-dev-dev-cloud-worker-2.onrender.com",
    serverClientToken: "veslo-client-token",
    gatewayAccessToken: "gateway-access-token",
  });

  assert.equal(
    shouldPreserveManagedAiConfig({
      content,
      managedProfile: null,
      gatewayBaseUrl: "http://127.0.0.1:62740",
      serverClientToken: "",
      gatewayAccessToken: "",
      accessBusy: false,
      accessError: AI_ACCESS_NOT_CONFIGURED_MESSAGE,
    }),
    false,
  );
});

test("shouldPreserveManagedAiConfig keeps matching local gateway routing during transient access gaps", () => {
  const content = formatManagedAiAccessConfig("{}", {
    profile: managedCodexProfile,
    serverBaseUrl: "http://127.0.0.1:62740",
    serverClientToken: "veslo-client-token",
    gatewayAccessToken: "gateway-access-token",
  });

  assert.equal(
    shouldPreserveManagedAiConfig({
      content,
      managedProfile: null,
      gatewayBaseUrl: "http://127.0.0.1:62740",
      serverClientToken: "",
      gatewayAccessToken: "",
      accessBusy: false,
      accessError: AI_ACCESS_NOT_CONFIGURED_MESSAGE,
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
