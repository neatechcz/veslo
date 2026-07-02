import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSoulAppWorkspaceIdByServerWorkspaceId,
  buildSoulWorkspaceIdMap,
  canReplaySoulMaterialization,
  resolveSoulActiveWorkspaceGuard,
  resolveSoulServerWorkspaceId,
  soulMaterializationRequiresActiveRuntimeReload,
  soulReplayRequiresActiveRun,
} from "../../lib/soul-workspace-map.js";
import type { VesloSoulMaterializationResult, VesloWorkspaceInfo } from "../../lib/veslo-server.js";

const serverWorkspace = (input: Partial<VesloWorkspaceInfo> & { id: string }): VesloWorkspaceInfo => ({
  id: input.id,
  name: input.name ?? input.id,
  path: input.path ?? "",
  workspaceType: input.workspaceType ?? "local",
  directory: input.directory,
  opencode: input.opencode,
});

const soulMaterializationResult = (
  input: Partial<Extract<VesloSoulMaterializationResult, { ok: true }>> = {},
): Extract<VesloSoulMaterializationResult, { ok: true }> => ({
  ok: true,
  status: "current",
  workspaceRoot: "/repo",
  effectiveContent: "Soul content",
  manifestPath: "/repo/.opencode/veslo/soul-manifest.json",
  instructionsPath: "/repo/opencode.jsonc",
  files: [],
  pending: false,
  reloadRequired: true,
  manualSyncRequired: false,
  ...input,
});

test("buildSoulWorkspaceIdMap maps local paths and explicit Veslo remote ids", () => {
  assert.deepEqual(
    buildSoulWorkspaceIdMap({
      appWorkspaces: [
        { id: "local-app", workspaceType: "local", path: "/repo/local" },
        {
          id: "remote-explicit-app",
          workspaceType: "remote",
          remoteType: "veslo",
          vesloWorkspaceId: "veslo-remote-explicit",
          path: "/not-used",
        },
        {
          id: "remote-url-app",
          workspaceType: "remote",
          remoteType: "veslo",
          vesloHostUrl: "https://den.test/w/veslo-url",
        },
      ],
      serverWorkspaces: [
        serverWorkspace({ id: "veslo-local", path: "/repo/local" }),
      ],
    }),
    {
      "local-app": "veslo-local",
      "remote-explicit-app": "veslo-remote-explicit",
      "remote-url-app": "veslo-url",
    },
  );
});

test("buildSoulWorkspaceIdMap falls back to server directory hints for Veslo remotes only", () => {
  assert.deepEqual(
    buildSoulWorkspaceIdMap({
      appWorkspaces: [
        {
          id: "remote-directory-app",
          workspaceType: "remote",
          remoteType: "veslo",
          directory: "/workspace/from-opencode",
        },
        {
          id: "remote-non-veslo-app",
          workspaceType: "remote",
          remoteType: "opencode",
          directory: "/workspace/from-opencode",
        },
        {
          id: "remote-missing-app",
          workspaceType: "remote",
          remoteType: "veslo",
          directory: "/workspace/missing",
        },
      ],
      serverWorkspaces: [
        serverWorkspace({
          id: "veslo-directory",
          path: "/other",
          opencode: { directory: "/workspace/from-opencode" },
        }),
      ],
    }),
    {
      "remote-directory-app": "veslo-directory",
    },
  );
});

test("resolveSoulServerWorkspaceId prefers mapped server ids then stored ids and mounted URLs", () => {
  assert.equal(
    resolveSoulServerWorkspaceId(
      {
        id: "remote-app",
        workspaceType: "remote",
        remoteType: "veslo",
        vesloWorkspaceId: "stored-server-id",
        baseUrl: "https://den.test/w/url-server-id",
      },
      { "remote-app": "mapped-server-id" },
    ),
    "mapped-server-id",
  );
  assert.equal(
    resolveSoulServerWorkspaceId(
      {
        id: "remote-app",
        workspaceType: "remote",
        remoteType: "veslo",
        baseUrl: "https://den.test/w/url-server-id",
      },
      {},
    ),
    "url-server-id",
  );
});

test("buildSoulAppWorkspaceIdByServerWorkspaceId maps server ids back to app ids", () => {
  const byServerId = buildSoulAppWorkspaceIdByServerWorkspaceId(
    [
      { id: "local-app", workspaceType: "local", path: "/repo/local" },
      { id: "remote-app", workspaceType: "remote", remoteType: "veslo", vesloWorkspaceId: "stored-remote" },
      {
        id: "mounted-app",
        workspaceType: "remote",
        remoteType: "veslo",
        baseUrl: "https://den.test/w/mounted-remote",
      },
    ],
    { "local-app": "mapped-local" },
  );

  assert.equal(byServerId.get("mapped-local"), "local-app");
  assert.equal(byServerId.get("stored-remote"), "remote-app");
  assert.equal(byServerId.get("mounted-remote"), "mounted-app");
});

test("resolveSoulActiveWorkspaceGuard maps busy app ids to server ids and fails closed when unresolved", () => {
  const guard = resolveSoulActiveWorkspaceGuard({
    appWorkspaces: [
      { id: "remote-app", workspaceType: "remote", remoteType: "veslo", vesloWorkspaceId: "server-remote" },
      { id: "local-app", workspaceType: "local", path: "/repo/local" },
      { id: "opencode-remote", workspaceType: "remote", remoteType: "opencode", directory: "/remote" },
    ],
    soulWorkspaceMap: {},
    busyWorkspaceIds: ["remote-app", "local-app", "opencode-remote"],
  });

  assert.deepEqual(guard.activeWorkspaceIds, ["server-remote"]);
  assert.equal(guard.activeRun, true);
  assert.deepEqual(guard.unresolvedAppWorkspaceIds, ["local-app"]);
});

test("pending Soul replay waits for busy app ids and unknown app ids fail closed", () => {
  assert.equal(
    canReplaySoulMaterialization({
      replay: { appWorkspaceId: "remote-app", serverWorkspaceId: "server-remote" },
      busyWorkspaceIds: ["remote-app"],
    }),
    false,
  );
  assert.equal(
    canReplaySoulMaterialization({
      replay: { appWorkspaceId: "remote-app", serverWorkspaceId: "server-remote" },
      busyWorkspaceIds: [],
    }),
    true,
  );
  assert.equal(
    canReplaySoulMaterialization({
      replay: { appWorkspaceId: null, serverWorkspaceId: "server-unknown" },
      busyWorkspaceIds: ["some-busy-workspace"],
    }),
    false,
  );
  assert.equal(
    soulReplayRequiresActiveRun({
      replay: { appWorkspaceId: "remote-app", serverWorkspaceId: "server-remote" },
      busyWorkspaceIds: ["remote-app"],
    }),
    true,
  );
  assert.equal(
    soulReplayRequiresActiveRun({
      replay: { appWorkspaceId: "remote-app", serverWorkspaceId: "server-remote" },
      busyWorkspaceIds: [],
    }),
    false,
  );
  assert.equal(
    soulReplayRequiresActiveRun({
      replay: { appWorkspaceId: null, serverWorkspaceId: "server-unknown" },
      busyWorkspaceIds: ["some-busy-workspace"],
    }),
    true,
  );
});

test("Soul materialization requests active runtime reload only after current active workspace writes", () => {
  assert.equal(
    soulMaterializationRequiresActiveRuntimeReload({
      activeServerWorkspaceId: "ws-active",
      materialization: {
        ok: true,
        pending: false,
        manualSyncRequired: false,
        workspaces: [
          { workspaceId: "ws-active", result: soulMaterializationResult() },
          { workspaceId: "ws-other", result: soulMaterializationResult() },
        ],
      },
    }),
    true,
  );

  assert.equal(
    soulMaterializationRequiresActiveRuntimeReload({
      activeServerWorkspaceId: "ws-active",
      materialization: {
        ok: true,
        pending: true,
        manualSyncRequired: false,
        workspaces: [
          { workspaceId: "ws-active", result: soulMaterializationResult({ status: "pending", pending: true }) },
        ],
      },
    }),
    false,
  );

  assert.equal(
    soulMaterializationRequiresActiveRuntimeReload({
      activeServerWorkspaceId: "ws-active",
      materialization: {
        ok: true,
        pending: false,
        manualSyncRequired: false,
        workspaces: [
          { workspaceId: "ws-other", result: soulMaterializationResult() },
        ],
      },
    }),
    false,
  );

  assert.equal(
    soulMaterializationRequiresActiveRuntimeReload({
      activeServerWorkspaceId: "ws-active",
      sourceWorkspaceId: "ws-active",
      materialization: soulMaterializationResult(),
    }),
    true,
  );

  assert.equal(
    soulMaterializationRequiresActiveRuntimeReload({
      activeServerWorkspaceId: "ws-active",
      sourceWorkspaceId: "ws-other",
      materialization: soulMaterializationResult(),
    }),
    false,
  );
});
