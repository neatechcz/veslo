import assert from "node:assert/strict";
import test from "node:test";

import {
  clearDenAuth,
  exchangeHandoffCode,
  flushPendingDesktopSnapshotWrite,
  getDesktopBrowserAuthStatus,
  hydrateDenAuthFromDesktopSnapshot,
  parseAuthCompleteDeepLink,
  readDenAuth,
  readDenKeepSignedIn,
  readDesktopAuthExchangeProof,
  resolveAuthenticatedDenUserLabel,
  resolvePreferredDenUserLabel,
  startDesktopBrowserAuth,
  subscribeDenAuthChanges,
  writeDenAuth,
  writeDenKeepSignedIn,
} from "../../lib/den-auth.js";

class MemoryStorage implements Storage {
  #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }

  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.#map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, String(value));
  }
}

function installDomStorage(options?: {
  tauriInvoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}) {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const previousWindow = globalThis.window;
  const tauriInternals =
    typeof options?.tauriInvoke === "function"
      ? {
          invoke: options.tauriInvoke,
        }
      : null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      sessionStorage,
      __TAURI_INTERNALS__: tauriInternals,
    },
  });
  return {
    localStorage,
    sessionStorage,
    restore() {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
        return;
      }
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    },
  };
}

function installCrypto() {
  const previousCrypto = globalThis.crypto;
  const encoder = new TextEncoder();
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(target: Uint8Array) {
        for (let index = 0; index < target.length; index += 1) {
          target[index] = (index + 17) % 255;
        }
        return target;
      },
      subtle: {
        async digest(algorithm: string, input: BufferSource) {
          assert.equal(algorithm, "SHA-256");
          const bytes = input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBuffer);
          const seeded = encoder.encode(`sha256:${Array.from(bytes).join(",")}`);
          const digest = new Uint8Array(32);
          for (let index = 0; index < digest.length; index += 1) {
            digest[index] = seeded[index % seeded.length] ?? 0;
          }
          return digest.buffer;
        },
      },
    },
  });
  return () => {
    if (previousCrypto === undefined) {
      Reflect.deleteProperty(globalThis, "crypto");
      return;
    }
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: previousCrypto,
    });
  };
}

function installNavigator(overrides: Partial<Navigator>) {
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      ...(previousNavigator ?? {}),
      ...overrides,
    },
  });
  return () => {
    if (previousNavigator === undefined) {
      Reflect.deleteProperty(globalThis, "navigator");
      return;
    }
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
  };
}

test("startDesktopBrowserAuth uses v2 start and stores exchange proof by transaction id", async () => {
  const storage = installDomStorage();
  const restoreCrypto = installCrypto();
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    return new Response(
      JSON.stringify({
        transactionId: "dat_123",
        authorizeUrl: "https://api.veslo.work/?desktopOnboarding=1&tid=dat_123&state=abc",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const result = await startDesktopBrowserAuth("signin");

    assert.deepEqual(result, {
      ok: true,
      authorizeUrl: "https://api.veslo.work/?desktopOnboarding=1&tid=dat_123&state=abc",
      sessionId: "dat_123",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.endsWith("/v2/desktop-auth/start"), true);
    assert.equal(calls[0]?.body.redirectUri, "veslo://auth-complete");
    assert.equal(typeof calls[0]?.body.codeChallenge, "string");
    assert.equal(calls[0]?.body.codeChallengeMethod, "S256");

    const proof = readDesktopAuthExchangeProof("dat_123");
    assert.equal(proof?.sessionId, "dat_123");
    assert.equal(typeof proof?.state, "string");
    assert.equal(typeof proof?.codeVerifier, "string");
    const storedPending = storage.localStorage.getItem("veslo.den.desktopAuthPending");
    assert.equal(storedPending?.includes("\"authorizeUrl\":"), true);
    assert.equal(
      storedPending?.includes("https://api.veslo.work/?desktopOnboarding=1&tid=dat_123&state=abc"),
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreCrypto();
    storage.restore();
  }
});

test("getDesktopBrowserAuthStatus reads v2 polling state", async () => {
  const storage = installDomStorage();
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return new Response(
      JSON.stringify({
        status: "authorized",
        transactionId: "dat_456",
        code: "handoff-code-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const result = await getDesktopBrowserAuthStatus("dat_456");

    assert.deepEqual(result, {
      ok: true,
      status: "authorized",
      sessionId: "dat_456",
      code: "handoff-code-1",
      expiresAt: result.ok ? result.expiresAt : null,
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0],
      "https://api.veslo.work/v2/desktop-auth/status?transactionId=dat_456",
    );
  } finally {
    globalThis.fetch = previousFetch;
    storage.restore();
  }
});

test("exchangeHandoffCode uses legacy v1 exchange when no PKCE proof is available", async () => {
  const storage = installDomStorage();
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });

    if (url.endsWith("/v1/desktop-auth/exchange")) {
      return new Response(
        JSON.stringify({
          token: "legacy-token",
          user: { id: "user_123" },
          org: { id: "org_456", name: "Legacy Org" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/v1/me")) {
      return new Response(
        JSON.stringify({
          user: { id: "user_123", name: "Legacy User", email: "legacy@example.com" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await exchangeHandoffCode("legacy-code-1");

    assert.deepEqual(result, {
      ok: true,
      state: {
        denApiBase: "https://api.veslo.work",
        token: "legacy-token",
        orgId: "org_456",
        user: { id: "user_123", name: "Legacy User", email: "legacy@example.com" },
        org: { id: "org_456", name: "Legacy Org", slug: undefined, role: undefined },
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://api.veslo.work/v1/desktop-auth/exchange");
    assert.deepEqual(calls[0]?.body, { code: "legacy-code-1" });
    assert.equal(calls[1]?.url, "https://api.veslo.work/v1/me");
  } finally {
    globalThis.fetch = previousFetch;
    storage.restore();
  }
});

test("exchangeHandoffCode uses v2 exchange with transaction proof when PKCE proof is available", async () => {
  const storage = installDomStorage();
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });

    if (url.endsWith("/v2/desktop-auth/exchange")) {
      return new Response(
        JSON.stringify({
          token: "pkce-token",
          user: { id: "user_v2" },
          org: { id: "org_v2", slug: "v2-org", role: "owner" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/v1/me")) {
      return new Response(
        JSON.stringify({
          user: { id: "user_v2", name: "PKCE User", email: "pkce@example.com" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await exchangeHandoffCode("v2-code-1", {
      sessionId: "dat_123",
      state: "state_123456789012",
      codeVerifier: "verifier_123",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.state.user, {
        id: "user_v2",
        name: "PKCE User",
        email: "pkce@example.com",
      });
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://api.veslo.work/v2/desktop-auth/exchange");
    assert.deepEqual(calls[0]?.body, {
      code: "v2-code-1",
      transactionId: "dat_123",
      state: "state_123456789012",
      codeVerifier: "verifier_123",
    });
    assert.equal(calls[1]?.url, "https://api.veslo.work/v1/me");
  } finally {
    globalThis.fetch = previousFetch;
    storage.restore();
  }
});

test("exchangeHandoffCode accepts accessToken from the v2 exchange contract", async () => {
  const storage = installDomStorage();
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.endsWith("/v2/desktop-auth/exchange")) {
      return new Response(
        JSON.stringify({
          accessToken: "pkce-access-token",
          tokenType: "Bearer",
          expiresIn: 3600,
          user: { id: "user_v2_contract" },
          org: { id: "org_v2_contract", slug: "v2-contract-org", role: "owner" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/v1/me")) {
      return new Response(
        JSON.stringify({
          user: { id: "user_v2_contract", name: "Contract User", email: "contract@example.com" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await exchangeHandoffCode("v2-code-contract", {
      sessionId: "dat_contract",
      state: "state_contract_123456789012",
      codeVerifier: "verifier_contract_123",
    });

    assert.deepEqual(result, {
      ok: true,
      state: {
        denApiBase: "https://api.veslo.work",
        token: "pkce-access-token",
        orgId: "org_v2_contract",
        user: { id: "user_v2_contract", name: "Contract User", email: "contract@example.com" },
        org: { id: "org_v2_contract", name: undefined, slug: "v2-contract-org", role: "owner" },
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    storage.restore();
  }
});

test("resolvePreferredDenUserLabel prefers email over name and id", () => {
  assert.equal(
    resolvePreferredDenUserLabel({
      id: "user_123",
      name: "Michal",
      email: "michal@example.com",
    }),
    "michal@example.com",
  );
  assert.equal(
    resolvePreferredDenUserLabel({
      id: "user_123",
      name: "Michal",
      email: " ",
    }),
    "Michal",
  );
  assert.equal(
    resolvePreferredDenUserLabel({
      id: "user_123",
      name: " ",
      email: " ",
    }),
    "user_123",
  );
});

test("resolveAuthenticatedDenUserLabel keeps signed-in state visible when profile fields are blank", () => {
  assert.equal(resolveAuthenticatedDenUserLabel(null), null);
  assert.equal(
    resolveAuthenticatedDenUserLabel({
      user: { id: "   " },
    }),
    "Signed in",
  );
  assert.equal(
    resolveAuthenticatedDenUserLabel({
      user: { id: "user_123", email: "michal@example.com" },
    }),
    "michal@example.com",
  );
});

test("exchangeHandoffCode enriches the returned auth state with /v1/me email details", async () => {
  const storage = installDomStorage();
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });

    if (url.endsWith("/v1/desktop-auth/exchange")) {
      return new Response(
        JSON.stringify({
          token: "legacy-token",
          user: { id: "user_123" },
          org: { id: "org_456", name: "Legacy Org" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/v1/me")) {
      return new Response(
        JSON.stringify({
          user: {
            id: "user_123",
            name: "Michal",
            email: "michal@example.com",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await exchangeHandoffCode("legacy-code-2");

    assert.deepEqual(result, {
      ok: true,
      state: {
        denApiBase: "https://api.veslo.work",
        token: "legacy-token",
        orgId: "org_456",
        user: { id: "user_123", name: "Michal", email: "michal@example.com" },
        org: { id: "org_456", name: "Legacy Org", slug: undefined, role: undefined },
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://api.veslo.work/v1/desktop-auth/exchange");
    assert.equal(calls[1]?.url, "https://api.veslo.work/v1/me");
  } finally {
    globalThis.fetch = previousFetch;
    storage.restore();
  }
});

test("parseAuthCompleteDeepLink accepts transactionId callbacks from v2 redirects", () => {
  assert.deepEqual(
    parseAuthCompleteDeepLink("veslo://auth-complete?code=abc123&transactionId=dat_789&state=state-1"),
    { code: "abc123", sessionId: "dat_789" },
  );
});

test("hydrateDenAuthFromDesktopSnapshot imports persisted auth before onboarding", async () => {
  const authState = {
    denApiBase: "https://api.veslo.work",
    token: "token_from_snapshot",
    orgId: "org_123",
    user: { id: "user_123", email: "snapshot@example.com" },
    org: { id: "org_123", slug: "snapshot-org" },
  };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const storage = installDomStorage({
    tauriInvoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: JSON.stringify(authState),
          keepSignedIn: true,
          source: "legacy-webkit",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    clearDenAuth();
    writeDenKeepSignedIn(true);
    storage.localStorage.removeItem("veslo.den.keepSignedIn");

    const imported = await hydrateDenAuthFromDesktopSnapshot();
    assert.equal(imported, true);
    assert.deepEqual(readDenAuth(), authState);
    assert.equal(readDenKeepSignedIn(), true);
    assert.equal(
      calls.some((item) => item.command === "den_auth_snapshot_read"),
      true,
    );
  } finally {
    storage.restore();
  }
});

test("writeDenAuth skips desktop snapshot writes during WebDriver sessions", async () => {
  const authState = {
    denApiBase: "https://api.veslo.work",
    token: "token_from_webdriver",
    orgId: "org_webdriver",
    user: { id: "user_webdriver", email: "webdriver@example.com" },
    org: { id: "org_webdriver" },
  };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const storage = installDomStorage({
    tauriInvoke: async (command, args) => {
      calls.push({ command, args });
      return null;
    },
  });
  const restoreNavigator = installNavigator({ webdriver: true });

  try {
    writeDenAuth(authState);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(readDenAuth(), authState);
    assert.equal(calls.length, 0);
  } finally {
    restoreNavigator();
    storage.restore();
  }
});

test("hydrateDenAuthFromDesktopSnapshot treats keepSignedIn false with auth as a session-only sign-in", async () => {
  const authState = {
    denApiBase: "https://api.veslo.work",
    token: "token_from_snapshot",
    orgId: "org_456",
    user: { id: "user_456" },
    org: { id: "org_456" },
  };
  const storage = installDomStorage({
    tauriInvoke: async (command) => {
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: JSON.stringify(authState),
          keepSignedIn: false,
          source: "legacy-webkit",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    const imported = await hydrateDenAuthFromDesktopSnapshot();
    assert.equal(imported, true);
    assert.deepEqual(readDenAuth(), authState);
    assert.equal(readDenKeepSignedIn(), false);
  } finally {
    storage.restore();
  }
});

test("hydrateDenAuthFromDesktopSnapshot imports auth into session storage when snapshot disables keep signed in", async () => {
  const authState = {
    denApiBase: "https://api.veslo.work",
    token: "token_from_snapshot_session_only",
    orgId: "org_session_only",
    user: { id: "user_session_only", email: "session-only@example.com" },
    org: { id: "org_session_only" },
  };
  const storage = installDomStorage({
    tauriInvoke: async (command) => {
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: JSON.stringify(authState),
          keepSignedIn: false,
          source: "desktop-runtime",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    clearDenAuth();
    writeDenKeepSignedIn(true);

    const imported = await hydrateDenAuthFromDesktopSnapshot();
    await flushPendingDesktopSnapshotWrite();

    assert.equal(imported, true);
    assert.deepEqual(readDenAuth(), authState);
    assert.equal(readDenKeepSignedIn(), false);
    assert.match(storage.sessionStorage.getItem("veslo.den.auth") ?? "", /token_from_snapshot_session_only/);
    assert.equal(storage.localStorage.getItem("veslo.den.auth"), null);
  } finally {
    storage.restore();
  }
});

test("hydrateDenAuthFromDesktopSnapshot replaces stale browser auth when desktop snapshot user differs", async () => {
  const staleAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_stale_browser",
    orgId: "org_stale",
    user: { id: "user_stale", email: "stale@example.com" },
    org: { id: "org_stale" },
  };
  const snapshotAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_snapshot_newer",
    orgId: "org_snapshot",
    user: { id: "user_snapshot", email: "snapshot@example.com" },
    org: { id: "org_snapshot" },
  };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const storage = installDomStorage({
    tauriInvoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: JSON.stringify(snapshotAuth),
          keepSignedIn: true,
          source: "desktop-runtime",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    writeDenAuth(staleAuth);
    await flushPendingDesktopSnapshotWrite();
    calls.length = 0;

    const imported = await hydrateDenAuthFromDesktopSnapshot();
    await flushPendingDesktopSnapshotWrite();

    assert.equal(imported, true);
    assert.deepEqual(readDenAuth(), snapshotAuth);
    assert.equal(readDenKeepSignedIn(), true);
    assert.equal(calls.some((entry) => entry.command === "den_auth_snapshot_read"), true);
  } finally {
    storage.restore();
  }
});

test("hydrateDenAuthFromDesktopSnapshot preserves browser auth when snapshot matches the current user", async () => {
  const currentAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_current_browser",
    orgId: "org_current",
    user: { id: "user_same", email: "same@example.com" },
    org: { id: "org_current" },
  };
  const snapshotAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_snapshot_older",
    orgId: "org_snapshot",
    user: { id: "user_same", email: "same@example.com" },
    org: { id: "org_snapshot" },
  };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const storage = installDomStorage({
    tauriInvoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: JSON.stringify(snapshotAuth),
          keepSignedIn: true,
          source: "desktop-runtime",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    writeDenAuth(currentAuth);
    await flushPendingDesktopSnapshotWrite();
    calls.length = 0;

    const imported = await hydrateDenAuthFromDesktopSnapshot();
    await flushPendingDesktopSnapshotWrite();

    assert.equal(imported, false);
    assert.deepEqual(readDenAuth(), currentAuth);
    const snapshotWrite = calls.filter((entry) => entry.command === "den_auth_snapshot_write").at(-1);
    assert.ok(snapshotWrite);
    assert.match(String(snapshotWrite.args?.authJson ?? ""), /token_current_browser/);
  } finally {
    storage.restore();
  }
});

test("hydrateDenAuthFromDesktopSnapshot preserves an existing browser language preference", async () => {
  const currentAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_current_browser",
    orgId: "org_current",
    user: { id: "user_same", email: "same@example.com" },
    org: { id: "org_current" },
  };
  const snapshotAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_snapshot_older",
    orgId: "org_snapshot",
    user: { id: "user_same", email: "same@example.com" },
    org: { id: "org_snapshot" },
  };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const storage = installDomStorage({
    tauriInvoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: JSON.stringify(snapshotAuth),
          keepSignedIn: true,
          language: "en",
          onboardingComplete: true,
          source: "desktop-runtime",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    storage.localStorage.setItem("veslo.language", "cs");
    storage.localStorage.setItem("veslo.onboardingComplete", "1");
    writeDenAuth(currentAuth);
    await flushPendingDesktopSnapshotWrite();
    calls.length = 0;

    const imported = await hydrateDenAuthFromDesktopSnapshot();
    await flushPendingDesktopSnapshotWrite();

    assert.equal(imported, false);
    assert.equal(storage.localStorage.getItem("veslo.language"), "cs");
    assert.equal(storage.localStorage.getItem("veslo.onboardingComplete"), "1");
    const snapshotWrite = calls.filter((entry) => entry.command === "den_auth_snapshot_write").at(-1);
    assert.ok(snapshotWrite);
    assert.equal(snapshotWrite.args?.language, "cs");
    assert.equal(snapshotWrite.args?.onboardingComplete, true);
  } finally {
    storage.restore();
  }
});

test("hydrateDenAuthFromDesktopSnapshot replaces stale browser auth with a session-only snapshot sign-in", async () => {
  const staleAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_stale_browser",
    orgId: "org_stale",
    user: { id: "user_stale", email: "stale@example.com" },
    org: { id: "org_stale" },
  };
  const snapshotAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_snapshot_signed_out",
    orgId: "org_snapshot",
    user: { id: "user_snapshot", email: "snapshot@example.com" },
    org: { id: "org_snapshot" },
  };
  const storage = installDomStorage({
    tauriInvoke: async (command) => {
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: JSON.stringify(snapshotAuth),
          keepSignedIn: false,
          source: "desktop-runtime",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    writeDenAuth(staleAuth);
    await flushPendingDesktopSnapshotWrite();

    const imported = await hydrateDenAuthFromDesktopSnapshot();
    await flushPendingDesktopSnapshotWrite();

    assert.equal(imported, true);
    assert.deepEqual(readDenAuth(), snapshotAuth);
    assert.equal(readDenKeepSignedIn(), false);
  } finally {
    storage.restore();
  }
});

test("hydrateDenAuthFromDesktopSnapshot clears stale browser auth when snapshot is explicitly signed out", async () => {
  const staleAuth = {
    denApiBase: "https://api.veslo.work",
    token: "token_stale_browser",
    orgId: "org_stale",
    user: { id: "user_stale", email: "stale@example.com" },
    org: { id: "org_stale" },
  };
  const storage = installDomStorage({
    tauriInvoke: async (command) => {
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: null,
          keepSignedIn: false,
          source: "desktop-runtime",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    writeDenAuth(staleAuth);
    await flushPendingDesktopSnapshotWrite();

    const imported = await hydrateDenAuthFromDesktopSnapshot();
    await flushPendingDesktopSnapshotWrite();

    assert.equal(imported, false);
    assert.equal(readDenAuth(), null);
    assert.equal(readDenKeepSignedIn(), false);
  } finally {
    storage.restore();
  }
});

test("hydrateDenAuthFromDesktopSnapshot restores language and onboarding completion flags", async () => {
  const authState = {
    denApiBase: "https://api.veslo.work",
    token: "token_from_snapshot",
    orgId: "org_789",
    user: { id: "user_789", email: "seeded@example.com" },
    org: { id: "org_789", slug: "seeded-org" },
  };
  const storage = installDomStorage({
    tauriInvoke: async (command) => {
      if (command === "den_auth_snapshot_read") {
        return {
          authJson: JSON.stringify(authState),
          keepSignedIn: true,
          language: "en",
          onboardingComplete: true,
          source: "e2e-seed",
        };
      }
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    clearDenAuth();
    storage.localStorage.removeItem("veslo.language");
    storage.localStorage.removeItem("veslo.onboardingComplete");

    const imported = await hydrateDenAuthFromDesktopSnapshot();
    assert.equal(imported, true);
    assert.deepEqual(readDenAuth(), authState);
    assert.equal(storage.localStorage.getItem("veslo.language"), "en");
    assert.equal(storage.localStorage.getItem("veslo.onboardingComplete"), "1");
  } finally {
    storage.restore();
  }
});

test("writeDenAuth syncs desktop snapshot with language and onboarding metadata", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const storage = installDomStorage({
    tauriInvoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "den_auth_snapshot_write") {
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    storage.localStorage.setItem("veslo.language", "en");
    storage.localStorage.setItem("veslo.onboardingComplete", "1");

    const authState = {
      denApiBase: "https://api.veslo.work",
      token: "token_for_snapshot_sync",
      orgId: "org_sync",
      user: { id: "user_sync", email: "sync@example.com" },
      org: { id: "org_sync", slug: "sync-org" },
    };

    writeDenAuth(authState);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshotWrite = calls.filter((entry) => entry.command === "den_auth_snapshot_write").at(-1);
    assert.ok(snapshotWrite);
    assert.equal(snapshotWrite.args?.keepSignedIn, true);
    assert.equal(snapshotWrite.args?.language, "en");
    assert.equal(snapshotWrite.args?.onboardingComplete, true);
    assert.equal(typeof snapshotWrite.args?.authJson, "string");
  } finally {
    storage.restore();
  }
});

test("flushPendingDesktopSnapshotWrite waits for the queued desktop snapshot write", async () => {
  let resolveWrite: (() => void) | undefined;
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const storage = installDomStorage({
    tauriInvoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "den_auth_snapshot_write") {
        await new Promise<void>((resolve) => {
          resolveWrite = () => resolve();
        });
        return null;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    },
  });

  try {
    const authState = {
      denApiBase: "https://api.veslo.work",
      token: "token_for_flush",
      orgId: "org_flush",
      user: { id: "user_flush", email: "flush@example.com" },
      org: { id: "org_flush", slug: "flush-org" },
    };

    writeDenAuth(authState);

    let flushed = false;
    const pendingFlush = flushPendingDesktopSnapshotWrite().then(() => {
      flushed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(flushed, false);
    assert.equal(calls.some((entry) => entry.command === "den_auth_snapshot_write"), true);

    if (!resolveWrite) {
      throw new Error("Expected desktop snapshot write to be pending");
    }
    resolveWrite();
    await pendingFlush;
    assert.equal(flushed, true);
  } finally {
    storage.restore();
  }
});

test("subscribeDenAuthChanges fires when auth state changes", () => {
  const storage = installDomStorage();
  const notifications: string[] = [];
  const unsubscribe = subscribeDenAuthChanges(() => {
    notifications.push("changed");
  });

  try {
    writeDenAuth({
      denApiBase: "https://api.veslo.work",
      token: "token_for_subscription",
      orgId: "org_subscription",
      user: { id: "user_subscription", email: "subscription@example.com" },
      org: { id: "org_subscription", slug: "subscription-org" },
    });
    clearDenAuth();
    writeDenKeepSignedIn(false);

    assert.equal(notifications.length, 3);
  } finally {
    unsubscribe();
    storage.restore();
  }
});
