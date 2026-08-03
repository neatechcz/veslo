import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceRuntimeController } from "../../context/workspace-runtime-controller.js";
import {
  readContextSource,
  readWorkspaceFacadeSource,
} from "./workspace-source";

async function waitForCondition(condition: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(condition(), true);
}

test("lazy runtime ensure lives in workspace runtime controller", () => {
  const runtimeSource = readContextSource("workspace-runtime-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(
    runtimeSource,
    /export function createWorkspaceRuntimeController\(/,
  );
  assert.match(runtimeSource, /async function ensureEngineForWorkspace/);
  assert.match(
    runtimeSource,
    /export type EnsureEngineForWorkspaceOptions = \{[\s\S]*reason\?: string;[\s\S]*loadSessions\?: boolean;[\s\S]*forceFreshRuntime\?: boolean;[\s\S]*\};/,
    "runtime ensure should expose one narrow options object for requested starts and send recovery without adding another owner",
  );
  assert.match(
    runtimeSource,
    /async function ensureEngineForWorkspace\([\s\S]*workspaceId\?: string \| null,[\s\S]*options: EnsureEngineForWorkspaceOptions = \{\},[\s\S]*\): Promise<boolean>/,
    "initial requests and first-send recovery should share the same runtime ensure owner",
  );
  assert.match(runtimeSource, /connectMode: "quiet"/);
  const ensureStart = runtimeSource.indexOf(
    "async function ensureEngineForWorkspace",
  );
  const ensureSource = runtimeSource.slice(ensureStart);
  const hydrationWaitIndex = ensureSource.indexOf(
    'recordSendWorkflowTrace("workspace-runtime", "ensure-engine:hydration-wait"',
  );
  const workspaceLookupIndex = ensureSource.indexOf(
    "const workspace = deps.workspaces().find",
  );
  assert.ok(
    hydrationWaitIndex >= 0,
    "runtime ensure should wait for workspace hydration",
  );
  assert.ok(
    workspaceLookupIndex >= 0,
    "runtime ensure should resolve the target workspace",
  );
  assert.ok(
    hydrationWaitIndex < workspaceLookupIndex,
    "runtime ensure must wait for workspace hydration before deciding the target workspace is missing",
  );
  assert.match(
    runtimeSource,
    /async function connectToEngineQuiet[\s\S]*deps\.routing\.ensure\(workspaceId, baseUrl,[\s\S]*deps\.setClient\(nextClient\);/s,
    "quiet reconnect must bind a workspace-scoped routed client before send uses routedClient(workspaceId)",
  );
  assert.doesNotMatch(
    runtimeSource,
    /connect-quiet:routing-skip-health|skipHealth: true/,
  );
  assert.match(
    runtimeSource,
    /function isEngineStartingRoutingError[\s\S]*engine_starting[\s\S]*"connect-quiet:engine-starting"/s,
    "quiet reconnect should trace pending engine startup separately from generic routing failures",
  );
  assert.match(
    runtimeSource,
    /localRuntimeLifecycle\.prepareWorkspaceRuntime\(\{/,
  );
  assert.match(
    runtimeSource,
    /const prepareReason = ensureReason;[\s\S]*localRuntimeLifecycle\.prepareWorkspaceRuntime\(\{[\s\S]*reason: prepareReason,[\s\S]*connectMode: "quiet",[\s\S]*forceFreshRuntime,/,
    "runtime ensure should send a backend-owned prepare intent instead of choosing a lifecycle primitive in the UI",
  );
  assert.doesNotMatch(
    runtimeSource,
    /localRuntimeLifecycle\.(startHost|restartWorkspaceRuntime|reattachOrchestratorWorkspace)\(/,
    "the UI runtime controller should not choose engine lifecycle primitives",
  );
  assert.match(
    runtimeSource,
    /const shouldLoadSessions = options\.loadSessions !== false;[\s\S]*if \(shouldLoadSessions\) \{[\s\S]*withTimeoutOrThrow\(deps\.loadSessions\(workspace\.path\)/s,
    "requested starts should not force session-list UI side effects",
  );
  assert.match(runtimeSource, /ensure-engine:load-sessions:skipped/);
  assert.match(runtimeSource, /loadSessions failed; continuing first prompt/);
  assert.match(runtimeSource, /clearWorkspaceBusyAllExcept\(workspace\.id\)/);
  assert.match(
    runtimeSource,
    /const runtimeReady = workspace\.workspaceType === "local"[\s\S]*await deps\.ensureLocalRuntimeReadyForWorkspaceStart\?\.\(workspace\.path\)[\s\S]*if \(runtimeReady === false\) \{[\s\S]*ensure-engine:runtime-prerequisites-not-ready[\s\S]*return false;[\s\S]*\}[\s\S]*const skillSyncReason = isRuntimeRecovery \? "runtime-recovery" : "browse-attach";[\s\S]*deps\.syncWorkspaceSkillMaterializationBeforeRuntime\(workspace,[\s\S]*reason: skillSyncReason,/s,
    "first-prompt lazy runtime startup must ask the local runtime readiness guard before skill sync or engine spawn",
  );
  const managedConfigStart = ensureSource.indexOf(
    '"ensure-engine:managed-ai-config:start"',
  );
  const managedConfigDone = ensureSource.indexOf(
    '"ensure-engine:managed-ai-config:done"',
  );
  const skillSync = ensureSource.indexOf(
    "deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace",
  );
  const runtimePrepare = ensureSource.indexOf(
    "deps.localRuntimeLifecycle.prepareWorkspaceRuntime({",
  );
  assert.ok(
    managedConfigStart >= 0,
    "runtime ensure should trace the managed AI config gate",
  );
  assert.ok(
    managedConfigDone > managedConfigStart,
    "runtime ensure should wait for managed AI config completion",
  );
  assert.ok(
    skillSync > managedConfigDone,
    "managed AI config must be ready before skill sync",
  );
  assert.ok(
    runtimePrepare > managedConfigDone,
    "managed AI config must be ready before cold engine start",
  );
  assert.match(
    ensureSource,
    /if \(!managedAiConfigReady\) \{[\s\S]*ensure-engine:managed-ai-config:not-ready[\s\S]*return false;/,
    "runtime ensure must not start a cold engine when live managed AI access is still undecided",
  );
  assert.match(
    runtimeSource,
    /const isActiveWorkspace = workspace\.id === deps\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*if \(isActiveWorkspace\) \{[\s\S]*deps\.setEngineReady\?\.\(true\);[\s\S]*deps\.onEngineStable\?\.\(\);[\s\S]*\}/s,
    "runtime ensure should reflect engine readiness only for the currently active workspace",
  );
  assert.match(
    runtimeSource,
    /dispatchLifecycle\?: \(event: WorkspaceLifecycleEvent\) => void;/,
    "runtime controller should accept lifecycle dispatch from the workspace store instead of owning another state model",
  );
  assert.match(
    runtimeSource,
    /deps\.dispatchLifecycle\?\.\(\{[\s\S]*type: "runtime-starting",[\s\S]*workspaceId: id,[\s\S]*runtime,[\s\S]*reason: ensureReason,[\s\S]*\}\);[\s\S]*recordSendWorkflowTrace\("workspace-runtime", "ensure-engine:start"/s,
    "explicit runtime ensure should publish runtime-starting before it can spawn or attach the engine",
  );
  assert.match(
    runtimeSource,
    /deps\.updateWorkspaceConnectionState\(id, \{ status: "connected", message: null \}\);[\s\S]*deps\.dispatchLifecycle\?\.\(\{[\s\S]*type: "connected",[\s\S]*workspaceId: id,[\s\S]*runtime,[\s\S]*reason: ensureReason,[\s\S]*\}\);/s,
    "runtime ensure success should publish a workspace-scoped connected event",
  );
  assert.match(
    runtimeSource,
    /deps\.dispatchLifecycle\?\.\(\{[\s\S]*type: "failed",[\s\S]*workspaceId: id,[\s\S]*message,[\s\S]*\}\);[\s\S]*return false;/s,
    "runtime ensure failures should publish workspace-scoped failed events with the concrete message",
  );
  assert.match(
    runtimeSource,
    /const message = messageFromUnknownError\(e, deps\.safeStringify\);[\s\S]*setErrorForActiveWorkspace\(id, message\);/,
    "runtime ensure failures should keep concrete engine startup messages for the UI",
  );
  assert.match(
    facadeSource,
    /ensureLocalRuntimeReadyForWorkspaceStart: engineStore\.ensureLocalRuntimeReadyForWorkspaceStart,/,
    "workspace store should pass the same local runtime preflight used by startHost into lazy first-prompt runtime startup",
  );
  assert.doesNotMatch(facadeSource, /async function ensureEngineForWorkspace/);
});

test("quiet connect traces engine_starting routing failures distinctly", async () => {
  const root = globalThis as unknown as {
    window?: Record<string, unknown>;
  };
  const previousWindow = root.window;
  const traceWindow: Record<string, unknown> = {
    __vesloSendWorkflowTraceEnabled: true,
  };
  root.window = traceWindow;

  try {
    const controller = createWorkspaceRuntimeController({
      activeWorkspaceId: () => "ws-a",
      workspaces: () => [],
      workspacesHydrated: () => true,
      routing: {
        release: () => {},
        ensure: async () => null,
        lastEnsureError: () =>
          '{"error":"engine_starting","engineState":"starting"}',
      },
      resolveEngineRuntime: () => "veslo-orchestrator",
      localRuntimeLifecycle: {} as never,
      connectToServer: async () => true,
      loadSessions: async () => {},
      setClient: () => {},
      setConnectedVersion: () => {},
      setBaseUrl: () => {},
      setClientDirectory: () => {},
      setError: () => {},
      updateWorkspaceConnectionState: () => {},
      clearWorkspaceBusyAllExcept: () => {},
      syncWorkspaceSkillMaterializationBeforeRuntime: async () => true,
      createClient: () => {
        throw new Error(
          "createClient should not run for routing ensure failures",
        );
      },
      waitForHealthy: async () => ({}),
      safeStringify: String,
      wsLog: () => {},
    });

    const ok = await controller.connectToEngineQuiet(
      "http://127.0.0.1:7777/workspace/ws-a/opencode",
      "/repo",
      undefined,
      { workspaceId: "ws-a", workspaceType: "local", reason: "test" },
    );
    assert.equal(ok, false);

    const logs = traceWindow.__vesloSendWorkflowTrace as Array<
      Record<string, unknown>
    >;
    assert.equal(logs.at(-1)?.event, "connect-quiet:engine-starting");
    assert.equal(logs.at(-1)?.engineState, "starting");
  } finally {
    if (previousWindow === undefined) {
      delete root.window;
    } else {
      root.window = previousWindow;
    }
  }
});

test("runtime ensure sends recovery reasons to the backend-owned prepare workflow", async () => {
  const calls: string[] = [];
  const controller = createWorkspaceRuntimeController({
    activeWorkspaceId: () => "ws-a",
    workspaces: () => [
      {
        id: "ws-a",
        name: "Workspace A",
        path: "/repo/a",
        workspaceType: "local",
      } as never,
    ],
    workspacesHydrated: () => true,
    routing: {
      release: () => {},
      ensure: async () => null,
      lastEnsureError: () => null,
    },
    resolveEngineRuntime: () => "veslo-orchestrator",
    localRuntimeLifecycle: {
      prepareWorkspaceRuntime: async (options: {
        reason?: string;
        forceFreshRuntime?: boolean;
      }) => {
        calls.push(
          `prepare:${options.forceFreshRuntime === true}:${options.reason ?? ""}`,
        );
        return true;
      },
    } as never,
    connectToServer: async () => true,
    loadSessions: async () => {
      calls.push("loadSessions");
    },
    setClient: () => {},
    setConnectedVersion: () => {},
    setBaseUrl: () => {},
    setClientDirectory: () => {},
    setEngineReady: () => {},
    setError: () => {},
    updateWorkspaceConnectionState: () => {},
    clearWorkspaceBusyAllExcept: () => {
      calls.push("clearBusy");
    },
    ensureLocalRuntimeReadyForWorkspaceStart: async () => true,
    syncWorkspaceSkillMaterializationBeforeRuntime: async () => {
      calls.push("syncSkills");
      return true;
    },
    createClient: () => {
      throw new Error("createClient should not run in this recovery test");
    },
    waitForHealthy: async () => ({}),
    safeStringify: String,
    wsLog: () => {},
  });

  const ok = await controller.ensureEngineForWorkspace("ws-a", {
    reason: "sendPrompt-runtime-recovery",
    loadSessions: false,
  });
  const freshOk = await controller.ensureEngineForWorkspace("ws-a", {
    reason: "event-stream-runtime-recovery",
    loadSessions: false,
    forceFreshRuntime: true,
  });

  assert.equal(ok, true);
  assert.equal(freshOk, true);
  assert.deepEqual(calls, [
    "syncSkills",
    "prepare:true:sendPrompt-runtime-recovery",
    "syncSkills",
    "prepare:true:event-stream-runtime-recovery",
  ]);
});

test("runtime recovery does not wait on an unrelated in-flight requested start", async () => {
  const calls: string[] = [];
  let releaseInitialRequest: () => void = () => {
    throw new Error("initial request was not started");
  };
  let markInitialRequestStarted: () => void = () => {};
  const initialRequestStarted = new Promise<void>((resolve) => {
    markInitialRequestStarted = resolve;
  });
  const controller = createWorkspaceRuntimeController({
    activeWorkspaceId: () => "ws-a",
    workspaces: () => [
      {
        id: "ws-a",
        name: "Workspace A",
        path: "/repo/a",
        workspaceType: "local",
      } as never,
    ],
    workspacesHydrated: () => true,
    routing: {
      release: () => {},
      ensure: async () => null,
      lastEnsureError: () => null,
    },
    resolveEngineRuntime: () => "veslo-orchestrator",
    localRuntimeLifecycle: {
      prepareWorkspaceRuntime: async (options: {
        reason?: string;
        forceFreshRuntime?: boolean;
      }) => {
        calls.push(
          `prepare:${options.forceFreshRuntime === true}:${options.reason ?? ""}`,
        );
        if (options.reason === "initial-request") {
          markInitialRequestStarted();
          await new Promise<void>((resolve) => {
            releaseInitialRequest = resolve;
          });
        }
        return true;
      },
    } as never,
    connectToServer: async () => true,
    loadSessions: async () => {},
    setClient: () => {},
    setConnectedVersion: () => {},
    setBaseUrl: () => {},
    setClientDirectory: () => {},
    setEngineReady: () => {},
    setError: () => {},
    updateWorkspaceConnectionState: () => {},
    clearWorkspaceBusyAllExcept: () => {},
    ensureLocalRuntimeReadyForWorkspaceStart: async () => true,
    syncWorkspaceSkillMaterializationBeforeRuntime: async () => true,
    createClient: () => {
      throw new Error("createClient should not run in this recovery test");
    },
    waitForHealthy: async () => ({}),
    safeStringify: String,
    wsLog: () => {},
  });

  const initialRequest = controller.ensureEngineForWorkspace("ws-a", {
    reason: "initial-request",
    loadSessions: false,
  });
  await initialRequestStarted;

  const recovery = controller.ensureEngineForWorkspace("ws-a", {
    reason: "sendPrompt-runtime-recovery",
    loadSessions: false,
  });
  await waitForCondition(() => calls.length === 2);

  assert.deepEqual(calls, [
    "prepare:false:initial-request",
    "prepare:true:sendPrompt-runtime-recovery",
  ]);
  assert.equal(await recovery, true);
  releaseInitialRequest();
  assert.equal(await initialRequest, true);
});
