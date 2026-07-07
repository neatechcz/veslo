import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createDenDesktopAuthWorkflow } from "../../context/den-desktop-auth-workflow.js";
import type { DenAuthState } from "../../lib/den-auth.js";

const authState: DenAuthState = {
  denApiBase: "https://api.veslo.work",
  token: "token-1",
  orgId: "org-1",
  user: { id: "user-1", email: "user@example.com" },
  org: { id: "org-1", slug: "org-one" },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("den desktop auth workflow dedupes auth-complete deep links and bootstraps once", async () => {
  await createRoot(async (dispose) => {
    const events: string[] = [];
    const writes: DenAuthState[] = [];
    const clearedProofs: Array<string | null | undefined> = [];
    let authChangeListener: (() => void) | null = null;

    const workflow = createDenDesktopAuthWorkflow({
      isTauriRuntime: () => true,
      workspace: {
        activeWorkspaceId: () => "workspace-1",
        bootstrapOnboarding: async () => {
          events.push("bootstrap");
        },
      },
      auth: {
        clearDenAuth: () => events.push("clear-auth"),
        readDenAuth: () => null,
        writeDenAuth: (state) => {
          writes.push(state);
          events.push(`write:${state.user.id}`);
          authChangeListener?.();
        },
        flushPendingDesktopSnapshotWrite: async () => {
          events.push("flush-snapshot");
        },
        subscribeDenAuthChanges: (listener) => {
          authChangeListener = listener;
          return () => {
            authChangeListener = null;
          };
        },
      },
      desktopAuth: {
        parseAuthCompleteDeepLink: () => ({ code: "code-1", sessionId: "session-1" }),
        readDesktopAuthExchangeProof: () => ({
          sessionId: "session-1",
          state: "state-1",
          codeVerifier: "verifier-1",
        }),
        clearDesktopAuthExchangeProof: (sessionId) => {
          clearedProofs.push(sessionId);
          events.push(`clear-proof:${sessionId ?? ""}`);
        },
        exchangeHandoffCode: async () => ({ ok: true, state: authState }),
        readPendingDesktopAuthSession: () => null,
        startDesktopBrowserAuth: async () => ({ ok: false, error: "unused" }),
        getDesktopBrowserAuthStatus: async () => ({ ok: false, error: "unused", statusCode: null }),
        getDenApiBase: () => "https://api.veslo.work",
      },
      ui: {
        setError: (message) => events.push(`error:${message ?? ""}`),
        setOnboardingStep: (step) => events.push(`step:${step}`),
        setView: (view) => events.push(`view:${view}`),
        setBooting: (booting) => events.push(`booting:${booting}`),
      },
      managedAi: {
        clearManagedAiAccessCache: () => events.push("clear-managed-cache"),
        clearRuntimeAuthorization: () => events.push("clear-runtime-auth"),
        requestManagedAiAccessRefresh: () => events.push("managed-refresh"),
      },
      diagnostics: {
        setBootstrapDiagnosticsCloudContext: async (context) => {
          events.push(`set-cloud:${context.userId}:${context.workspaceId}`);
        },
        clearBootstrapDiagnosticsCloudContext: async () => {
          events.push("clear-cloud");
        },
        recordBootstrapDiagnostic: async (event) => {
          events.push(`diagnostic:${event}`);
        },
      },
      profile: {
        resolveAuthenticatedDenUserLabel: (auth) => auth?.user.email ?? null,
        resolvePreferredDenUserLabel: (user) => user?.email ?? user?.id ?? null,
        fetchUserProfile: async () => null,
      },
      browser: {
        openDesktopAuthUrl: async (url) => {
          events.push(`open:${url}`);
        },
      },
      timers: {
        setTimeout: (callback) => {
          events.push("timer:set");
          return { callback } as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => events.push("timer:clear"),
        sleep: async () => undefined,
      },
      safeStringify: String,
    });

    assert.equal(workflow.queueAuthCompleteDeepLink("veslo://auth-complete?code=code-1"), true);
    assert.equal(workflow.queueAuthCompleteDeepLink("veslo://auth-complete?code=code-1"), true);
    await flush();
    await flush();

    assert.deepEqual(writes, [authState]);
    assert.deepEqual(clearedProofs, ["session-1"]);
    assert.equal(workflow.authCompleteExchangeBusy(), false);
    assert.equal(workflow.denAuthRevision(), 1);
    assert.equal(events.filter((event) => event === "bootstrap").length, 1);
    assert.ok(events.includes("set-cloud:user-1:workspace-1"));
    assert.ok(events.includes("managed-refresh"));

    dispose();
  });
});

test("den desktop auth workflow logout clears auth, cloud context, cache, and refreshes access", async () => {
  await createRoot(async (dispose) => {
    const events: string[] = [];
    const workflow = createDenDesktopAuthWorkflow({
      isTauriRuntime: () => true,
      workspace: {
        activeWorkspaceId: () => "workspace-1",
        bootstrapOnboarding: async () => undefined,
      },
      auth: {
        clearDenAuth: () => events.push("clear-auth"),
        readDenAuth: () => null,
        writeDenAuth: () => undefined,
        flushPendingDesktopSnapshotWrite: async () => {
          events.push("flush-snapshot");
        },
        subscribeDenAuthChanges: () => () => undefined,
      },
      desktopAuth: {
        parseAuthCompleteDeepLink: () => null,
        readDesktopAuthExchangeProof: () => null,
        clearDesktopAuthExchangeProof: () => undefined,
        exchangeHandoffCode: async () => ({ ok: false, error: "unused" }),
        readPendingDesktopAuthSession: () => null,
        startDesktopBrowserAuth: async () => ({ ok: false, error: "unused" }),
        getDesktopBrowserAuthStatus: async () => ({ ok: false, error: "unused", statusCode: null }),
        getDenApiBase: () => "https://api.veslo.work",
      },
      ui: {
        setError: (message) => events.push(`error:${message ?? ""}`),
        setOnboardingStep: (step) => events.push(`step:${step}`),
        setView: (view) => events.push(`view:${view}`),
        setBooting: (booting) => events.push(`booting:${booting}`),
      },
      managedAi: {
        clearManagedAiAccessCache: () => events.push("clear-managed-cache"),
        clearRuntimeAuthorization: () => events.push("clear-runtime-auth"),
        requestManagedAiAccessRefresh: () => events.push("managed-refresh"),
      },
      diagnostics: {
        setBootstrapDiagnosticsCloudContext: async () => {
          events.push("set-cloud");
        },
        clearBootstrapDiagnosticsCloudContext: async () => {
          events.push("clear-cloud");
        },
        recordBootstrapDiagnostic: async () => undefined,
      },
      profile: {
        resolveAuthenticatedDenUserLabel: () => null,
        resolvePreferredDenUserLabel: () => null,
        fetchUserProfile: async () => null,
      },
      browser: {
        openDesktopAuthUrl: async () => undefined,
      },
      safeStringify: String,
    });

    await workflow.logout();

    assert.deepEqual(events, [
      "clear-auth",
      "clear-cloud",
      "clear-managed-cache",
      "clear-runtime-auth",
      "step:auth",
      "view:onboarding",
      "flush-snapshot",
      "managed-refresh",
    ]);

    dispose();
  });
});

test("den desktop auth workflow ignores runtime authorization clear failures during logout", async () => {
  await createRoot(async (dispose) => {
    const events: string[] = [];
    const workflow = createDenDesktopAuthWorkflow({
      isTauriRuntime: () => true,
      workspace: {
        activeWorkspaceId: () => "workspace-1",
        bootstrapOnboarding: async () => undefined,
      },
      auth: {
        clearDenAuth: () => events.push("clear-auth"),
        readDenAuth: () => null,
        writeDenAuth: () => undefined,
        flushPendingDesktopSnapshotWrite: async () => {
          events.push("flush-snapshot");
        },
        subscribeDenAuthChanges: () => () => undefined,
      },
      desktopAuth: {
        parseAuthCompleteDeepLink: () => null,
        readDesktopAuthExchangeProof: () => null,
        clearDesktopAuthExchangeProof: () => undefined,
        exchangeHandoffCode: async () => ({ ok: false, error: "unused" }),
        readPendingDesktopAuthSession: () => null,
        startDesktopBrowserAuth: async () => ({ ok: false, error: "unused" }),
        getDesktopBrowserAuthStatus: async () => ({ ok: false, error: "unused", statusCode: null }),
        getDenApiBase: () => "https://api.veslo.work",
      },
      ui: {
        setError: (message) => events.push(`error:${message ?? ""}`),
        setOnboardingStep: (step) => events.push(`step:${step}`),
        setView: (view) => events.push(`view:${view}`),
        setBooting: (booting) => events.push(`booting:${booting}`),
      },
      managedAi: {
        clearManagedAiAccessCache: () => events.push("clear-managed-cache"),
        clearRuntimeAuthorization: async () => {
          events.push("clear-runtime-auth");
          throw new Error("local server unavailable");
        },
        requestManagedAiAccessRefresh: () => events.push("managed-refresh"),
      },
      diagnostics: {
        setBootstrapDiagnosticsCloudContext: async () => undefined,
        clearBootstrapDiagnosticsCloudContext: async () => {
          events.push("clear-cloud");
        },
        recordBootstrapDiagnostic: async (event, payload) => {
          events.push(`diagnostic:${event}:${String(payload?.message ?? "")}`);
        },
      },
      profile: {
        resolveAuthenticatedDenUserLabel: () => null,
        resolvePreferredDenUserLabel: () => null,
        fetchUserProfile: async () => null,
      },
      browser: {
        openDesktopAuthUrl: async () => undefined,
      },
      safeStringify: String,
    });

    await workflow.logout();
    await flush();

    assert.deepEqual(events.slice(0, 7), [
      "clear-auth",
      "clear-cloud",
      "clear-managed-cache",
      "clear-runtime-auth",
      "step:auth",
      "view:onboarding",
      "flush-snapshot",
    ]);
    assert.ok(events.includes("managed-refresh"));
    assert.ok(
      events.includes("diagnostic:desktop-auth:ai-gateway-runtime-auth-clear-failed:local server unavailable"),
    );

    dispose();
  });
});

test("den desktop auth workflow stops desktop polling on terminal auth statuses", async () => {
  for (const status of ["authorized", "expired", "cancelled", "exchanged"] as const) {
    await createRoot(async (dispose) => {
      const events: string[] = [];
      let statusCalls = 0;

      const workflow = createDenDesktopAuthWorkflow({
        isTauriRuntime: () => true,
        workspace: {
          activeWorkspaceId: () => "workspace-1",
          bootstrapOnboarding: async () => {
            events.push("bootstrap");
          },
        },
        auth: {
          clearDenAuth: () => undefined,
          readDenAuth: () => null,
          writeDenAuth: () => {
            events.push("write-auth");
          },
          flushPendingDesktopSnapshotWrite: async () => {
            events.push("flush-snapshot");
          },
          subscribeDenAuthChanges: () => () => undefined,
        },
        desktopAuth: {
          parseAuthCompleteDeepLink: () => null,
          readDesktopAuthExchangeProof: () => ({
            sessionId: "session-1",
            state: "state-1",
            codeVerifier: "verifier-1",
          }),
          clearDesktopAuthExchangeProof: () => {
            events.push("clear-proof");
          },
          exchangeHandoffCode: async () => {
            events.push("exchange");
            return { ok: true, state: authState };
          },
          readPendingDesktopAuthSession: () => null,
          startDesktopBrowserAuth: async () => ({
            ok: true,
            authorizeUrl: "https://auth.example/start",
            sessionId: "session-1",
          }),
          getDesktopBrowserAuthStatus: async () => {
            statusCalls += 1;
            events.push(`status:${status}`);
            return {
              ok: true,
              status,
              sessionId: "session-1",
              code: status === "authorized" ? "code-1" : null,
              expiresAt: null,
            };
          },
          getDenApiBase: () => "https://api.veslo.work",
        },
        ui: {
          setError: (message) => events.push(`error:${message ?? ""}`),
          setOnboardingStep: (step) => events.push(`step:${step}`),
          setView: (view) => events.push(`view:${view}`),
          setBooting: (booting) => events.push(`booting:${booting}`),
        },
        managedAi: {
          clearManagedAiAccessCache: () => undefined,
          requestManagedAiAccessRefresh: () => events.push("managed-refresh"),
        },
        diagnostics: {
          setBootstrapDiagnosticsCloudContext: async () => {
            events.push("set-cloud");
          },
          clearBootstrapDiagnosticsCloudContext: async () => undefined,
          recordBootstrapDiagnostic: async (event) => {
            events.push(`diagnostic:${event}`);
          },
        },
        profile: {
          resolveAuthenticatedDenUserLabel: () => null,
          resolvePreferredDenUserLabel: () => null,
          fetchUserProfile: async () => null,
        },
        browser: {
          openDesktopAuthUrl: async (url) => {
            events.push(`open:${url}`);
          },
        },
        timers: {
          sleep: async () => {
            events.push("sleep");
          },
        },
        safeStringify: String,
      });

      await workflow.startDesktopBrowserSignIn();
      await flush();
      await flush();

      assert.equal(statusCalls, 1, `${status} should stop polling after one status response`);
      assert.equal(events.includes("sleep"), false, `${status} should not schedule another poll`);
      assert.equal(events.filter((event) => event === "exchange").length, status === "authorized" ? 1 : 0);
      assert.equal(events.filter((event) => event === "bootstrap").length, status === "authorized" ? 1 : 0);

      dispose();
    });
  }
});

test("den desktop auth workflow clears post-auth bootstrap timeout after bootstrap settles", async () => {
  await createRoot(async (dispose) => {
    const events: string[] = [];
    let timeoutCallback: (() => void) | null = null;

    const workflow = createDenDesktopAuthWorkflow({
      isTauriRuntime: () => true,
      workspace: {
        activeWorkspaceId: () => "workspace-1",
        bootstrapOnboarding: async () => {
          events.push("bootstrap");
        },
      },
      auth: {
        clearDenAuth: () => undefined,
        readDenAuth: () => null,
        writeDenAuth: () => undefined,
        flushPendingDesktopSnapshotWrite: async () => undefined,
        subscribeDenAuthChanges: () => () => undefined,
      },
      desktopAuth: {
        parseAuthCompleteDeepLink: () => ({ code: "code-1", sessionId: "session-1" }),
        readDesktopAuthExchangeProof: () => ({
          sessionId: "session-1",
          state: "state-1",
          codeVerifier: "verifier-1",
        }),
        clearDesktopAuthExchangeProof: () => undefined,
        exchangeHandoffCode: async () => ({ ok: true, state: authState }),
        readPendingDesktopAuthSession: () => null,
        startDesktopBrowserAuth: async () => ({ ok: false, error: "unused" }),
        getDesktopBrowserAuthStatus: async () => ({ ok: false, error: "unused", statusCode: null }),
        getDenApiBase: () => "https://api.veslo.work",
      },
      ui: {
        setError: (message) => events.push(`error:${message ?? ""}`),
        setOnboardingStep: (step) => events.push(`step:${step}`),
        setView: (view) => events.push(`view:${view}`),
        setBooting: (booting) => events.push(`booting:${booting}`),
      },
      managedAi: {
        clearManagedAiAccessCache: () => undefined,
        requestManagedAiAccessRefresh: () => undefined,
      },
      diagnostics: {
        setBootstrapDiagnosticsCloudContext: async () => undefined,
        clearBootstrapDiagnosticsCloudContext: async () => undefined,
        recordBootstrapDiagnostic: async (event) => {
          events.push(`diagnostic:${event}`);
        },
      },
      profile: {
        resolveAuthenticatedDenUserLabel: () => null,
        resolvePreferredDenUserLabel: () => null,
        fetchUserProfile: async () => null,
      },
      timers: {
        setTimeout: (callback) => {
          timeoutCallback = callback;
          events.push("timer:set");
          return "timeout-1" as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (timeoutId) => {
          events.push(`timer:clear:${String(timeoutId)}`);
          timeoutCallback = null;
        },
      },
      safeStringify: String,
    });

    assert.equal(workflow.queueAuthCompleteDeepLink("veslo://auth-complete?code=code-1"), true);
    await flush();
    await flush();

    assert.equal(events.includes("timer:set"), true);
    assert.equal(events.includes("timer:clear:timeout-1"), true);
    assert.equal(timeoutCallback, null);
    assert.equal(events.includes("diagnostic:desktop-auth:post-auth-bootstrap-timeout"), false);

    dispose();
  });
});
