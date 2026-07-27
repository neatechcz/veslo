import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspaceSkillMaterializationGate,
  prepareRuntimeWithSkillViewRefresh,
  RuntimeSkillViewRefreshError,
} from "../../context/workspace-skill-materialization.js";
import { VesloServerError } from "../../lib/veslo-server.js";
import { readContextSource, readWorkspaceBehaviorSources } from "./workspace-source";

const behaviorSource = readWorkspaceBehaviorSources();
const source = readContextSource("workspace-skill-materialization.ts");
const runtimeSource = readContextSource("workspace-runtime-controller.ts");

function createGate(overrides: {
  client: unknown;
  workspaceBusy?: () => Record<string, Record<string, { startedAt: number }>>;
  setError?: (value: string | null) => void;
  updateWorkspaceConnectionState?: (workspaceId: string, next: unknown) => void;
  wsDebug?: (label: string, payload?: unknown) => void;
}) {
  return createWorkspaceSkillMaterializationGate({
    workspaceBusy: overrides.workspaceBusy ?? (() => ({})),
    vesloServerClient: () => overrides.client as any,
    refreshSkills: async () => undefined,
    setError: overrides.setError ?? (() => undefined),
    updateWorkspaceConnectionState: overrides.updateWorkspaceConnectionState as any ?? (() => undefined),
    wsDebug: overrides.wsDebug ?? (() => undefined),
  });
}

test("workspace store defines a server-backed skill materialization sync gate", () => {
  assert.match(
    source,
    /export function createWorkspaceSkillMaterializationGate\([\s\S]*deps\.vesloServerClient\?\.\(\)[\s\S]*getWorkspaceSkillMaterializationStatus\([\s\S]*syncWorkspaceSkillMaterialization\(/s,
    "workspace activation should use the Veslo server materialization status/sync APIs",
  );

  assert.match(
    source,
    /Object\.keys\(deps\.workspaceBusy\(\)\[workspace\.id\] \?\? \{\}\)\.length > 0[\s\S]*activeRun: true/s,
    "active workspace runs must request pending materialization instead of mutating managed skill files",
  );
});

test("workspace materialization sync forwards the signed-in Den API base", () => {
  assert.match(
    source,
    /denApiBase:\s*denAuth\?\.denApiBase\?\.trim\(\)\s*\|\|\s*undefined/,
    "runtime-start materialization sync must use the current signed-in Den API base, not only the server fallback config",
  );
});

test("workspace materialization trace carries registry errors for degraded diagnostics", () => {
  assert.match(
    source,
    /trace\("status",\s*\{[\s\S]*registryError:\s*status\.registryError\s*\?\?\s*null/s,
    "status trace should include the registry error that explains degraded materialization",
  );
  assert.match(
    source,
    /trace\("synced",\s*\{[\s\S]*registryError:\s*result\.registryError\s*\?\?\s*null/s,
    "sync trace should include registry errors returned by the sync endpoint",
  );
  assert.match(
    source,
    /function skillRegistryErrorTracePayload\(error: VesloServerError\)[\s\S]*\.\.\.skillRegistryDetailsPayload\(error\.details\)/s,
    "caught registry errors should keep server-provided registry details for exact diagnostics",
  );
  assert.match(
    source,
    /trace\("degraded",\s*\{[\s\S]*registryError,[\s\S]*\}\);/s,
    "degraded trace should carry the structured registry error payload",
  );
});

test("local materialization sync starts the managed server before using the fallback client", () => {
  const ensureIdx = source.indexOf("await deps.ensureLocalVesloServerRunning?.({ requireRuntimeChainReady: false })");
  const clientIdx = source.indexOf("const client = deps.vesloServerClient?.()");

  assert.notStrictEqual(
    ensureIdx,
    -1,
    "local sync should ensure the managed Veslo server process is running without requiring the runtime chain it is about to start",
  );
  assert.notStrictEqual(clientIdx, -1, "local sync should read the Veslo server client");
  assert.ok(ensureIdx < clientIdx, "managed server startup must happen before reading the fallback client");
});

test("local runtime starts are gated behind skill materialization sync", () => {
  const helperCall = "await deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace,";
  const ensureStart = runtimeSource.indexOf("async function ensureEngineForWorkspace(");
  assert.notStrictEqual(ensureStart, -1, "ensureEngineForWorkspace is missing");

  const ensureSource = runtimeSource.slice(ensureStart);
  const syncIdx = ensureSource.indexOf(helperCall);
  const prepareIdx = ensureSource.indexOf("deps.localRuntimeLifecycle.prepareWorkspaceRuntime({");

  assert.notStrictEqual(syncIdx, -1, "ensureEngineForWorkspace should sync skills before runtime start");
  assert.notStrictEqual(prepareIdx, -1, "ensureEngineForWorkspace should delegate runtime preparation");
  assert.ok(syncIdx < prepareIdx, "sync must happen before backend runtime preparation");
});

test("workspace activation local restart is gated behind skill materialization sync", () => {
  const activationSource = readContextSource("workspace-activation-local.ts");
  const restartStart = activationSource.indexOf("async function restartLocalRuntimeForSwitch(");
  assert.notStrictEqual(restartStart, -1, "restartLocalRuntimeForSwitch should exist");
  const restartSource = activationSource.slice(restartStart);

  const syncIdx = restartSource.indexOf("await deps.syncWorkspaceSkillMaterializationBeforeRuntime(next,");
  const restartIdx = restartSource.indexOf("deps.localRuntimeLifecycle.prepareWorkspaceRuntime({");

  assert.notStrictEqual(syncIdx, -1, "activateWorkspace should sync skills before local runtime restart");
  assert.ok(syncIdx < restartIdx, "sync must happen before local-to-local runtime restart");
});

test("configured pending materialization sync failure reports but does not block runtime readiness", async () => {
  const debugLabels: string[] = [];
  const errors: Array<string | null> = [];
  const states: Array<{ workspaceId: string; next: unknown }> = [];
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => ({
        registryConfigured: true,
        status: "pending",
        reloadRequired: true,
      }),
      syncWorkspaceSkillMaterialization: async () => {
        throw new VesloServerError(404, "not_found", "Materialization sync route was not found");
      },
    },
    setError: (value) => errors.push(value),
    updateWorkspaceConnectionState: (workspaceId, next) => states.push({ workspaceId, next }),
    wsDebug: (label) => debugLabels.push(label),
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );

  assert.equal(ready, true);
  assert.deepEqual(debugLabels, ["skills:materialization:failed:configured-sync"]);
  assert.deepEqual(errors, ["Materialization sync route was not found"]);
  assert.deepEqual(states, [
    {
      workspaceId: "workspace-1",
      next: { status: "error", message: "Materialization sync route was not found" },
    },
  ]);
});

test("configured skill registry not found degrades without setting workspace error", async () => {
  const debugLabels: string[] = [];
  const errors: Array<string | null> = [];
  const states: Array<{ workspaceId: string; next: unknown }> = [];
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => ({
        registryConfigured: true,
        status: "pending",
        reloadRequired: true,
      }),
      syncWorkspaceSkillMaterialization: async () => {
        throw new VesloServerError(404, "skill_registry_not_found", "Skill registry resource was not found");
      },
    },
    setError: (value) => errors.push(value),
    updateWorkspaceConnectionState: (workspaceId, next) => states.push({ workspaceId, next }),
    wsDebug: (label) => debugLabels.push(label),
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );

  assert.equal(ready, true);
  assert.deepEqual(debugLabels, ["skills:materialization:degraded"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(states, []);
});

test("workspace registry not configured status skips sync without blocking runtime", async () => {
  const debugLabels: string[] = [];
  let syncCalled = false;
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => ({
        registryConfigured: true,
        workspaceRegistryConfigured: false,
        status: "not-configured",
        reloadRequired: false,
      }),
      syncWorkspaceSkillMaterialization: async () => {
        syncCalled = true;
        throw new Error("sync should not be called");
      },
    },
    wsDebug: (label) => debugLabels.push(label),
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );

  assert.equal(ready, true);
  assert.equal(syncCalled, false);
  assert.deepEqual(debugLabels, ["skills:materialization:skip:not-configured"]);
});

test("runtime skill preparation uses the revisioned active view before launch", () => {
  assert.match(
    source,
    /const ensureActiveRuntimeManifest[\s\S]*client\.prepareRuntimeSkillView\(\s*workspaceId,/s,
    "runtime startup must prepare the server-owned active view before the orchestrator stages skills",
  );
});

test("local-only runtime still prepares the active view before engine startup", async () => {
  let prepared = 0;
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => ({
        registryConfigured: false,
        workspaceRegistryConfigured: false,
        status: "not-configured",
        reloadRequired: false,
      }),
      prepareRuntimeSkillView: async () => {
        prepared += 1;
        return { ready: true, revision: "view-1", generatedAt: "2026-07-21T00:00:00.000Z", activeCount: 1, items: [{ name: "workspace-only" }] };
      },
    },
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );

  assert.equal(ready, true);
  assert.equal(prepared, 1);
});

test("skill view changed forces a fresh active manifest before retrying runtime", async () => {
  let options: { forceRefresh?: boolean } | undefined;
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => ({
        registryConfigured: false,
        workspaceRegistryConfigured: false,
        status: "not-configured",
        reloadRequired: false,
      }),
      prepareRuntimeSkillView: async (
        _workspaceId: string,
        nextOptions?: { forceRefresh?: boolean },
      ) => {
        options = nextOptions;
        return { ready: true, revision: "view-2", generatedAt: "2026-07-27T00:00:00.000Z", activeCount: 1, items: [{ name: "workspace-only" }] };
      },
    },
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "skill-view-changed-retry" },
  );

  assert.equal(ready, true);
  assert.deepEqual(options, { forceRefresh: true });
});

test("a stale skill view forces the same fresh active manifest", async () => {
  let options: { forceRefresh?: boolean } | undefined;
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => ({
        registryConfigured: false,
        workspaceRegistryConfigured: false,
        status: "not-configured",
        reloadRequired: false,
      }),
      prepareRuntimeSkillView: async (
        _workspaceId: string,
        nextOptions?: { forceRefresh?: boolean },
      ) => {
        options = nextOptions;
        return { ready: true, revision: "view-2", generatedAt: "2026-07-27T00:00:00.000Z", activeCount: 1, items: [{ name: "workspace-only" }] };
      },
    },
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "skill-view-stale-retry" },
  );

  assert.equal(ready, true);
  assert.deepEqual(options, { forceRefresh: true });
});

test("runtime preparation refreshes one changed skill view and retries once", async () => {
  let prepareCalls = 0;
  const refreshReasons: string[] = [];

  const result = await prepareRuntimeWithSkillViewRefresh({
    prepare: async () => {
      prepareCalls += 1;
      if (prepareCalls === 1) throw new Error('Failed to activate workspace: status 409: {"error":"skill_view_changed"}');
      return "ready";
    },
    refresh: async ({ reason }) => {
      refreshReasons.push(reason);
      return true;
    },
  });

  assert.equal(result, "ready");
  assert.equal(prepareCalls, 2);
  assert.deepEqual(refreshReasons, ["skill-view-changed-retry"]);
});

test("repeated skill view changes produce an actionable UI error", async () => {
  await assert.rejects(
    prepareRuntimeWithSkillViewRefresh({
      prepare: async () => {
        throw new Error('Failed to activate workspace: status 409: {"error":"skill_view_changed"}');
      },
      refresh: async () => true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeSkillViewRefreshError);
      assert.equal(error.code, "skill_view_changed");
      assert.equal(error.phase, "retry");
      assert.match(error.message, /refreshed the skill view and retried/i);
      return true;
    },
  );
});

test("a stale runtime view requests the fresh-refresh context on every retry", async () => {
  const contexts: Array<{ reason: string }> = [];
  let prepares = 0;

  await assert.rejects(
    prepareRuntimeWithSkillViewRefresh({
      prepare: async () => {
        prepares += 1;
        throw new Error("Failed to activate workspace: status 409: {\\\"error\\\":\\\"skill_view_stale\\\"}");
      },
      refresh: async (context) => {
        contexts.push({ reason: context.reason });
        return true;
      },
    }),
    (error: unknown) => error instanceof RuntimeSkillViewRefreshError && error.code === "skill_view_stale",
  );

  assert.equal(prepares, 3);
  assert.deepEqual(contexts, [
    { reason: "skill-view-stale-retry" },
    { reason: "skill-view-stale-retry" },
  ]);
});

test("a conflict that clears on the second retry still starts the engine", async () => {
  let prepares = 0;
  let refreshes = 0;

  const result = await prepareRuntimeWithSkillViewRefresh({
    prepare: async () => {
      prepares += 1;
      if (prepares < 3) throw new Error('Failed to activate workspace: status 409: {"error":"skill_view_changed"}');
      return "ready";
    },
    refresh: async () => {
      refreshes += 1;
      return true;
    },
  });

  assert.equal(result, "ready");
  assert.equal(prepares, 3);
  assert.equal(refreshes, 2);
});

test("a deferred directory refresh waits for its hint instead of refreshing", async () => {
  const waits: number[] = [];
  const refreshReasons: string[] = [];
  let prepares = 0;

  const result = await prepareRuntimeWithSkillViewRefresh({
    prepare: async () => {
      prepares += 1;
      if (prepares === 1) {
        throw new Error(
          'Failed to activate workspace: status 409: {"error":"directory_skill_view_refresh_deferred","retryAfterMs":250}',
        );
      }
      return "ready";
    },
    refresh: async ({ reason }) => {
      refreshReasons.push(reason);
      return true;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(result, "ready");
  assert.equal(prepares, 2);
  assert.deepEqual(waits, [250]);
  // A drain needs time, not a re-resolve; refreshing would invalidate a good view.
  assert.deepEqual(refreshReasons, []);
});

test("a deferred refresh hint is clamped and falls back when absent", async () => {
  const waits: number[] = [];
  let prepares = 0;

  await assert.rejects(
    prepareRuntimeWithSkillViewRefresh({
      prepare: async () => {
        prepares += 1;
        throw new Error(
          prepares === 1
            ? 'status 409: {"error":"directory_skill_view_refresh_deferred"}'
            : 'status 409: {"error":"directory_skill_view_refresh_deferred","retryAfterMs":900000}',
        );
      },
      refresh: async () => true,
      wait: async (ms) => {
        waits.push(ms);
      },
    }),
    (error: unknown) =>
      error instanceof RuntimeSkillViewRefreshError &&
      error.code === "skill_view_deferred",
  );

  assert.deepEqual(waits, [250, 5000]);
  assert.equal(prepares, 3);
});

test("the retry budget is bounded and reports the first conflict", async () => {
  let prepares = 0;

  await assert.rejects(
    prepareRuntimeWithSkillViewRefresh({
      prepare: async () => {
        prepares += 1;
        throw new Error(
          prepares === 1
            ? 'Failed to activate workspace: status 409: {"error":"skill_view_changed"}'
            : 'Failed to activate workspace: status 409: {"error":"skill_view_stale"}',
        );
      },
      refresh: async () => true,
      retryLimit: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeSkillViewRefreshError);
      assert.equal(error.code, "skill_view_changed");
      return true;
    },
  );

  assert.equal(prepares, 2);
});

test("degraded workspace materialization status skips sync without blocking runtime", async () => {
  const debugLabels: string[] = [];
  let syncCalled = false;
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => ({
        registryConfigured: true,
        status: "degraded",
        reloadRequired: false,
        registryError: {
          code: "skill_registry_fetch_failed",
          message: "Failed to fetch skill registry",
          status: 502,
        },
      }),
      syncWorkspaceSkillMaterialization: async () => {
        syncCalled = true;
        throw new Error("sync should not be called");
      },
    },
    wsDebug: (label) => debugLabels.push(label),
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );

  assert.equal(ready, true);
  assert.equal(syncCalled, false);
  assert.deepEqual(debugLabels, ["skills:materialization:degraded"]);
});

test("missing materialization status route remains an unsupported older server skip", async () => {
  const debugLabels: string[] = [];
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => {
        throw new VesloServerError(404, "not_found", "Not found");
      },
    },
    wsDebug: (label) => debugLabels.push(label),
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "activation" },
  );

  assert.equal(ready, true);
  assert.deepEqual(debugLabels, ["skills:materialization:skip:unsupported-server"]);
});

test("skill registry materialization outages degrade without blocking runtime start", () => {
  assert.match(
    source,
    /export function isSkillRegistryMaterializationError\(error: unknown\): boolean \{/,
    "workspace materialization should classify skill registry outages separately",
  );

  assert.match(
    source,
    /if \(isSkillRegistryMaterializationError\(error\)\) \{[\s\S]*deps\.wsDebug\("skills:materialization:degraded"[\s\S]*reportError\(error, "workspace\.skillMaterialization"\);[\s\S]*return true;[\s\S]*\}/s,
    "skill registry outages should be reported as degraded and allow runtime startup to continue",
  );
});

test("materialization hard failures keep concrete messages for UI", () => {
  assert.match(
    source,
    /const message = error instanceof Error \? error\.message : safeStringify\(error\);[\s\S]*deps\.setError\(addOpencodeCacheHint\(message\)\);[\s\S]*deps\.updateWorkspaceConnectionState\(workspaceId, \{ status: "error", message \}\);/s,
    "hard materialization failures should preserve the concrete error message in UI connection state",
  );
});
