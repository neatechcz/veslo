import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createAppDeepLinkWorkflow } from "../../context/app-deep-link-workflow.js";

function createHarness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let booting = false;
  let startupPreference = "server";
  let onboardingStep = "welcome";
  let settings = { urlOverride: "https://server.example", token: "server-token" };
  let hostInfo: unknown = { baseUrl: "http://127.0.0.1:8787", clientToken: "local-token" };
  let createRemoteWorkspaceOpen = false;
  let vesloStatus = "disconnected";
  let vesloWorkspaceId: string | null = null;
  let vesloClient: unknown = null;
  let now = 1_000;

  const deps: any = {
    booting: () => booting,
    startupPreference: () => startupPreference,
    setStartupPreference: (value: string) => {
      startupPreference = value;
      calls.push(`startup:${value}`);
    },
    onboardingStep: () => onboardingStep,
    setOnboardingStep: (value: string) => {
      onboardingStep = value;
      calls.push(`onboarding:${value}`);
    },
    vesloServerSettings: () => settings,
    setVesloServerSettings: (value: typeof settings) => {
      settings = value;
      calls.push(`settings:${value.urlOverride}`);
    },
    readVesloServerSettings: () => settings,
    writeVesloServerSettings: (value: typeof settings) => {
      settings = value;
      calls.push(`write-settings:${value.urlOverride}`);
      return value;
    },
    activeVesloServerHostInfo: () => hostInfo,
    vesloServerClient: () => vesloClient,
    vesloServerWorkspaceId: () => vesloWorkspaceId,
    vesloServerStatus: () => vesloStatus,
    workspace: {
      createRemoteWorkspaceOpen: () => createRemoteWorkspaceOpen,
      setCreateRemoteWorkspaceOpen: (open: boolean) => {
        createRemoteWorkspaceOpen = open;
        calls.push(`remote-modal:${open}`);
      },
      createRemoteWorkspaceFlow: async (input: { displayName?: string | null }) => {
        calls.push(`create-worker:${input.displayName ?? ""}`);
        return true;
      },
    },
    setView: (view: string) => calls.push(`view:${view}`),
    setTab: (tab: string) => calls.push(`tab:${tab}`),
    setError: (message: string | null) => calls.push(`error:${message ?? ""}`),
    queueAuthCompleteDeepLink: (url: string) => {
      calls.push(`auth:${url}`);
      return url.includes("auth-complete");
    },
    fetchSharedBundle: async (url: string) => {
      calls.push(`fetch:${url}`);
      return { name: "Team setup" };
    },
    buildImportPayloadFromBundle: () => ({
      payload: { skills: [{ id: "planning" }] },
      importedSkillsCount: 1,
    }),
    refreshSkills: async () => {
      calls.push("refresh-skills");
    },
    refreshHubSkills: async () => {
      calls.push("refresh-hub-skills");
    },
    timers: {
      now: () => now,
      sleep: async () => {
        now += 200;
        calls.push("sleep");
        vesloStatus = "connected";
        vesloWorkspaceId = "workspace-1";
        vesloClient = {
          importWorkspace: async (workspaceId: string, payload: unknown) => {
            calls.push(`import:${workspaceId}:${JSON.stringify(payload)}`);
          },
        };
      },
    },
    addOpencodeCacheHint: (message: string) => message,
    safeStringify: (value: unknown) => String(value),
    consoleLog: () => {},
    ...overrides,
  };

  return {
    calls,
    deps,
    setBooting: (value: boolean) => {
      booting = value;
    },
    setServerReady: () => {
      vesloStatus = "connected";
      vesloWorkspaceId = "workspace-1";
      vesloClient = {
        importWorkspace: async (workspaceId: string, payload: unknown) => {
          calls.push(`import:${workspaceId}:${JSON.stringify(payload)}`);
        },
      };
    },
  };
}

function createManualEffectRunner() {
  const effects: Array<() => void> = [];

  return {
    effect: (fn: () => void) => {
      effects.push(fn);
      fn();
    },
    flush: async () => {
      for (let index = 0; index < 4; index += 1) {
        await settle();
        for (const fn of effects) fn();
      }
      await settle();
    },
  };
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

test("desktop deep-link fan-in dedupes URLs and stops after the first consumed handler", () => {
  createRoot((dispose) => {
    const harness = createHarness();
    const workflow = createAppDeepLinkWorkflow(harness.deps);
    const authUrl = "veslo://auth-complete?code=code-1";
    const remoteUrl =
      "veslo://connect-remote?vesloHostUrl=https%3A%2F%2Fworker.example&vesloToken=worker-token&workerId=worker-alpha&workerName=Alpha";

    workflow.consumeDesktopDeepLinkUrls([authUrl, remoteUrl]);
    assert.equal(workflow.pendingRemoteConnectDeepLink(), null);

    workflow.consumeDesktopDeepLinkUrls([authUrl, remoteUrl]);
    assert.equal(workflow.pendingRemoteConnectDeepLink()?.displayName, "Alpha");
    assert.equal(workflow.pendingRemoteConnectDeepLink()?.vesloWorkspaceId, "worker-alpha");
    assert.deepEqual(
      harness.calls.filter((call) => call.startsWith("auth:")),
      [`auth:${authUrl}`, `auth:${remoteUrl}`],
      "deduped auth URL should not be reprocessed before the remote URL",
    );

    dispose();
  });
});

test("web deep-link startup queues all handlers and strips only remote or bundle query params", () => {
  createRoot((dispose) => {
    const replacements: string[] = [];
    const harness = createHarness();
    const workflow = createAppDeepLinkWorkflow(harness.deps);
    const currentUrl =
      "https://app.example/dashboard?bundleUrl=https%3A%2F%2Fshare.example%2Fbundle.json&intent=new_worker&code=auth-code&state=state-1";

    workflow.consumeWebDeepLinkUrl(currentUrl, (cleanedUrl) => replacements.push(cleanedUrl));

    assert.equal(workflow.pendingSharedBundleInvite()?.bundleUrl, "https://share.example/bundle.json");
    assert.deepEqual(replacements, ["/dashboard?code=auth-code&state=state-1"]);
    assert.deepEqual(
      harness.calls.filter((call) => call.startsWith("auth:")),
      [`auth:${currentUrl}`],
      "auth callback should see the original URL and auth params must remain in the cleaned URL",
    );

    dispose();
  });
});

test("remote-connect pending link opens the create-worker modal after boot", async () => {
  await createRoot(async (dispose) => {
    const harness = createHarness();
    const workflow = createAppDeepLinkWorkflow(harness.deps);
    harness.setBooting(true);

    assert.equal(
      workflow.queueRemoteConnectDeepLink(
        "veslo://connect-remote?vesloHostUrl=https%3A%2F%2Fworker.example&vesloToken=worker-token&workerId=worker-alpha&workerName=Alpha",
      ),
      true,
    );
    await Promise.resolve();
    assert.equal(workflow.deepLinkRemoteWorkspaceDefaults(), null);

    harness.setBooting(false);
    workflow.flushPendingRemoteConnectDeepLink();

    assert.equal(workflow.deepLinkRemoteWorkspaceDefaults()?.displayName, "Alpha");
    assert.equal(workflow.deepLinkRemoteWorkspaceDefaults()?.vesloWorkspaceId, "worker-alpha");
    assert.deepEqual(harness.calls.slice(-3), ["view:dashboard", "tab:scheduled", "remote-modal:true"]);

    dispose();
  });
});

test("shared bundle import creates a worker then waits for the connected writable target", async () => {
  await createRoot(async (dispose) => {
    const harness = createHarness();
    const workflow = createAppDeepLinkWorkflow(harness.deps);

    await workflow.importSharedBundleInvite({
      bundleUrl: "https://share.example/bundle.json",
      intent: "new_worker",
      label: "Shared Team",
    });

    assert.deepEqual(harness.calls, [
      "fetch:https://share.example/bundle.json",
      "create-worker:Shared Team",
      "sleep",
      "import:workspace-1:{\"skills\":[{\"id\":\"planning\"}]}",
      "refresh-skills",
      "refresh-hub-skills",
      "error:",
    ]);
    assert.equal(workflow.sharedBundleImportBusy(), false);
    assert.equal(workflow.pendingSharedBundleInvite(), null);

    dispose();
  });
});

test("queued shared bundle import survives the busy-state effect rerun", async () => {
  await createRoot(async (dispose) => {
    const effects = createManualEffectRunner();
    const harness = createHarness({ effect: effects.effect });
    harness.setServerReady();
    const workflow = createAppDeepLinkWorkflow(harness.deps);
    const currentUrl =
      "https://app.example/dashboard?bundleUrl=https%3A%2F%2Fshare.example%2Fbundle.json&intent=import_current";

    workflow.consumeWebDeepLinkUrl(currentUrl, () => {});
    await effects.flush();

    assert.deepEqual(harness.calls, [
      `auth:${currentUrl}`,
      "fetch:https://share.example/bundle.json",
      "import:workspace-1:{\"skills\":[{\"id\":\"planning\"}]}",
      "refresh-skills",
      "refresh-hub-skills",
      "error:",
    ]);
    assert.equal(workflow.sharedBundleImportBusy(), false);
    assert.equal(workflow.pendingSharedBundleInvite(), null);

    dispose();
  });
});
