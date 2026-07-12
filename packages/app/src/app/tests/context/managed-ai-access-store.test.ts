import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import type { ManagedAiAccessProfile } from "../../lib/ai-access.js";
import {
  buildManagedAiAccessCacheKey,
  clearManagedAiAccessCache,
  createManagedAiAccessStore,
  loadManagedAiAccessSingleFlight,
  readManagedAiAccessCache,
  writeManagedAiAccessCache,
  type ManagedAiAccessStorage,
  type ManagedAiAccessStoreOptions,
} from "../../context/managed-ai-access-store.js";

function createMemoryStorage(initial: Record<string, string> = {}): ManagedAiAccessStorage & {
  values: Map<string, string>;
  removals: string[];
} {
  const values = new Map(Object.entries(initial));
  const removals: string[] = [];

  return {
    values,
    removals,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      removals.push(key);
      values.delete(key);
    },
  };
}

function managedProfile(overrides: Partial<ManagedAiAccessProfile> = {}): ManagedAiAccessProfile {
  return {
    userId: "user-1",
    providerId: "codex_oauth",
    effectiveModel: {
      providerID: "codex_oauth",
      modelID: "gpt-5",
    },
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

async function settleEffects() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function createStoreOptions(
  overrides: Partial<ManagedAiAccessStoreOptions> = {},
): ManagedAiAccessStoreOptions {
  const options: ManagedAiAccessStoreOptions = {
    authenticatedUser: () => "user@example.com",
    denAuthRevision: () => 1,
    readDenAuth: () => ({
      denApiBase: "https://api.veslo.work",
      token: "den-token",
      orgId: "org-1",
      user: { id: "user-1", email: "user@example.com" },
      org: { id: "org-1" },
    }),
    isTauriRuntime: () => false,
    gatewayVesloServerClient: () => ({
      baseUrl: "https://gateway.veslo.test",
      getMyAiAccess: async () => ({
        aiAccess: null,
        accessToken: "",
      }),
    }),
    managedAiGatewayBaseUrl: () => "",
    vesloServerAuth: () => ({ token: "local-token" }),
    activeVesloServerHostInfo: () => ({ baseUrl: "http://127.0.0.1:34115" }),
    activeWorkspaceDisplay: () => ({ workspaceType: "remote" }),
    ensureLocalVesloServerRunning: async () => false,
    providers: () => [{ id: "codex_oauth", name: "Codex Cloud", env: [], models: {} }],
    formatModelLabel: (model) => model.modelID,
    translate: (key) => key,
    reportError: () => undefined,
    describeRequestError: () => "Managed AI access failed",
    storage: createMemoryStorage(),
    timers: {
      setTimeout: (callback) => setTimeout(callback, 0),
      clearTimeout: (timeoutId) => clearTimeout(timeoutId),
    },
    windowTarget: null,
    documentTarget: null,
    now: () => 1_000,
    effect: (fn) => {
      fn();
    },
    ...overrides,
  };
  return options;
}

test("managed AI access cache hydrates, expires, and clears browser records", () => {
  const storage = createMemoryStorage();
  const profile = managedProfile();
  const cacheKey = buildManagedAiAccessCacheKey({
    userId: " user-1 ",
    orgId: " org-1 ",
    gatewayBaseUrl: "https://gateway.veslo.test/",
  });

  assert.equal(cacheKey, "user-1|org-1|https://gateway.veslo.test");

  writeManagedAiAccessCache(cacheKey, profile, " gateway-token ", {
    storage,
    isTauriRuntime: () => false,
    now: () => 1_000,
  });

  assert.deepEqual(
    readManagedAiAccessCache(cacheKey, {
      storage,
      isTauriRuntime: () => false,
      now: () => 1_000,
    }),
    {
      schemaVersion: 1,
      cacheKey,
      fetchedAt: 1_000,
      profile,
      gatewayAccessToken: "gateway-token",
    },
  );
  assert.equal(
    readManagedAiAccessCache(cacheKey, {
      storage,
      isTauriRuntime: () => false,
      now: () => 31 * 60 * 1_000,
    }),
    null,
    "expired access records must not hydrate",
  );

  clearManagedAiAccessCache(cacheKey, {
    storage,
    isTauriRuntime: () => false,
  });
  assert.deepEqual(storage.removals, ["veslo.managedAiAccess.v1"]);
});

test("managed AI browser cache rejects malformed or mismatched effective models", () => {
  const cacheKey = "user-1|org-1|https://gateway.veslo.test";
  const invalidProfiles = [
    managedProfile({ effectiveModel: { providerID: "codex_oauth", modelID: "" } }),
    managedProfile({ effectiveModel: { providerID: "openai", modelID: "gpt-5" } }),
    managedProfile({
      providerId: "local_development" as ManagedAiAccessProfile["providerId"],
      effectiveModel: { providerID: "local_development", modelID: "gpt-5" },
    }),
  ];

  for (const profile of invalidProfiles) {
    const storage = createMemoryStorage();
    writeManagedAiAccessCache(cacheKey, profile, "gateway-token", {
      storage,
      isTauriRuntime: () => false,
      now: () => 1_000,
    });

    assert.equal(
      readManagedAiAccessCache(cacheKey, {
        storage,
        isTauriRuntime: () => false,
        now: () => 1_000,
      }),
      null,
    );
  }
});

test("managed AI access single-flight reuses loads for the same cache key", async () => {
  let loadCalls = 0;
  const first = loadManagedAiAccessSingleFlight("key-a", async () => {
    loadCalls += 1;
    return { aiAccess: null, accessToken: "" };
  });
  const second = loadManagedAiAccessSingleFlight("key-a", async () => {
    loadCalls += 1;
    return { aiAccess: null, accessToken: "" };
  });

  assert.equal(first, second);
  await first;
  assert.equal(loadCalls, 1);
});

test("managed AI access store applies cached access before retrying a gateway failure", async () => {
  await createRoot(async (dispose) => {
    try {
      const storage = createMemoryStorage();
      const profile = managedProfile();
      const cacheKey = "user-1|org-1|https://gateway.veslo.test";
      const scheduledTimers: Array<() => void> = [];
      let loadCalls = 0;

      writeManagedAiAccessCache(cacheKey, profile, "cached-token", {
        storage,
        isTauriRuntime: () => false,
        now: () => 1_000,
      });

      const store = createManagedAiAccessStore(
        createStoreOptions({
          storage,
          gatewayVesloServerClient: () => ({
            baseUrl: "https://gateway.veslo.test",
            getMyAiAccess: async () => {
              loadCalls += 1;
              throw new Error("offline");
            },
          }),
          timers: {
            setTimeout: (callback) => {
              scheduledTimers.push(callback);
              return scheduledTimers.length as unknown as ReturnType<typeof setTimeout>;
            },
            clearTimeout: () => undefined,
          },
        }),
      );

      await settleEffects();

      assert.equal(loadCalls, 1);
      assert.deepEqual(store.managedAiAccess(), profile);
      assert.equal(store.managedAiGatewayAccessToken(), "cached-token");
      assert.equal(store.managedAiAccessError(), "Managed AI access failed");
      assert.equal(store.managedAiAccessBusy(), false);
      assert.equal(store.managedAiAccessRetryScheduled(), true);
      assert.equal(scheduledTimers.length, 1);
    } finally {
      dispose();
    }
  });
});

test("managed AI access store defers loopback desktop refresh until local auth exists", async () => {
  await createRoot(async (dispose) => {
    try {
      let loadCalls = 0;
      const effects: Array<() => void> = [];
      const store = createManagedAiAccessStore(
        createStoreOptions({
          effect: (fn) => {
            effects.push(fn);
            fn();
          },
          isTauriRuntime: () => true,
          managedAiGatewayBaseUrl: () => "http://127.0.0.1:34115",
          vesloServerAuth: () => ({ token: "" }),
          gatewayVesloServerClient: () => ({
            baseUrl: "http://127.0.0.1:34115",
            getMyAiAccess: async () => {
              loadCalls += 1;
              return { aiAccess: null, accessToken: "" };
            },
          }),
        }),
      );

      await settleEffects();
      for (const effect of effects) {
        effect();
      }
      await settleEffects();

      assert.equal(loadCalls, 0);
      assert.equal(store.managedAiAccess(), null);
      assert.equal(store.managedAiGatewayAccessToken(), "");
      assert.equal(store.managedAiAccessBusy(), false);
      assert.equal(store.managedAiAccessError(), null);
    } finally {
      dispose();
    }
  });
});

test("managed AI access store starts the local gateway before refreshing local desktop access", async () => {
  await createRoot(async (dispose) => {
    try {
      let ensureCalls = 0;
      const store = createManagedAiAccessStore(
        createStoreOptions({
          isTauriRuntime: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeVesloServerHostInfo: () => null,
          vesloServerAuth: () => ({ token: "" }),
          ensureLocalVesloServerRunning: async () => {
            ensureCalls += 1;
            return true;
          },
        }),
      );

      await settleEffects();

      assert.equal(ensureCalls, 1);
      assert.equal(store.managedAiAccess(), null);
    } finally {
      dispose();
    }
  });
});
