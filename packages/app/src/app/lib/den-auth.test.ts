import assert from "node:assert/strict";
import test from "node:test";

import {
  exchangeHandoffCode,
  getDesktopBrowserAuthStatus,
  parseAuthCompleteDeepLink,
  readDesktopAuthExchangeProof,
  resolveAuthenticatedDenUserLabel,
  resolvePreferredDenUserLabel,
  startDesktopBrowserAuth,
} from "./den-auth.js";

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

function installDomStorage() {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      sessionStorage,
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
        authorizeUrl: "https://den-control-plane-veslo.onrender.com/?desktopOnboarding=1&tid=dat_123&state=abc",
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
      authorizeUrl: "https://den-control-plane-veslo.onrender.com/?desktopOnboarding=1&tid=dat_123&state=abc",
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
      "https://den-control-plane-veslo.onrender.com/v2/desktop-auth/status?transactionId=dat_456",
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
        denApiBase: "https://den-control-plane-veslo.onrender.com",
        token: "legacy-token",
        orgId: "org_456",
        user: { id: "user_123", name: "Legacy User", email: "legacy@example.com" },
        org: { id: "org_456", name: "Legacy Org", slug: undefined, role: undefined },
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://den-control-plane-veslo.onrender.com/v1/desktop-auth/exchange");
    assert.deepEqual(calls[0]?.body, { code: "legacy-code-1" });
    assert.equal(calls[1]?.url, "https://den-control-plane-veslo.onrender.com/v1/me");
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
    assert.equal(calls[0]?.url, "https://den-control-plane-veslo.onrender.com/v2/desktop-auth/exchange");
    assert.deepEqual(calls[0]?.body, {
      code: "v2-code-1",
      transactionId: "dat_123",
      state: "state_123456789012",
      codeVerifier: "verifier_123",
    });
    assert.equal(calls[1]?.url, "https://den-control-plane-veslo.onrender.com/v1/me");
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
        denApiBase: "https://den-control-plane-veslo.onrender.com",
        token: "legacy-token",
        orgId: "org_456",
        user: { id: "user_123", name: "Michal", email: "michal@example.com" },
        org: { id: "org_456", name: "Legacy Org", slug: undefined, role: undefined },
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://den-control-plane-veslo.onrender.com/v1/desktop-auth/exchange");
    assert.equal(calls[1]?.url, "https://den-control-plane-veslo.onrender.com/v1/me");
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
