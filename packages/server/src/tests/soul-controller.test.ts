import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { createSoulController } from "../soul-controller.js";
import { writePendingSoulEdit } from "../soul-cache.js";
import type { RequestContext } from "../routing.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";

const workspaceA: WorkspaceInfo = {
  id: "workspace-a",
  name: "Workspace A",
  path: "/tmp/workspace-a",
  workspaceType: "local",
};

const workspaceB: WorkspaceInfo = {
  id: "workspace-b",
  name: "Workspace B",
  path: "/tmp/workspace-b",
  workspaceType: "local",
};

const baseConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  token: "token",
  hostToken: "host-token",
  approval: { mode: "auto", timeoutMs: 1 },
  corsOrigins: [],
  workspaces: [workspaceA, workspaceB],
  authorizedRoots: [],
  readOnly: false,
  startedAt: 1,
  tokenSource: "generated",
  hostTokenSource: "generated",
  logFormat: "json",
  logRequests: false,
  debugLogs: {
    enabled: false,
    ingestUrl: null,
    ingestToken: null,
    batchMaxEvents: 100,
    batchMaxBytes: 1000,
    spoolMaxBytes: 1000,
    flushIntervalMs: 1000,
  },
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function requestContext(headers: Record<string, string>, config: ServerConfig = baseConfig): RequestContext {
  return {
    request: new Request("http://localhost/soul", { headers }),
    url: new URL("http://localhost/soul"),
    params: {},
    config,
    actor: {
      type: "remote",
      tokenHash: "actor-token",
      scope: "collaborator",
    },
  } as RequestContext;
}

describe("createSoulController", () => {
  test("derives Den context and edit permissions from request headers and token scope", () => {
    const controller = createSoulController();
    const ctx = requestContext({
      "x-veslo-den-api-base": "https://den.example.test/root/",
      "x-veslo-den-token": "den-token",
      "x-veslo-den-org-id": "org-1",
      "x-veslo-user-id": "user-1",
    });

    expect(controller.soulDenContext(ctx)).toEqual({
      baseUrl: "https://den.example.test/root",
      denToken: "den-token",
      orgId: "org-1",
      userId: "user-1",
    });
    expect(controller.soulCanEdit(ctx, "organization")).toBe(true);
    expect(controller.soulCanEdit(ctx, "user")).toBe(true);

    const readOnlyCtx = requestContext({}, { ...baseConfig, readOnly: true });
    expect(controller.soulCanEdit(readOnlyCtx, "user")).toBe(false);

    const missingOrgDenCtx = requestContext({ "x-veslo-den-token": "den-token" });
    expect(controller.soulCanEdit(missingOrgDenCtx, "organization")).toBe(false);
  });

  test("builds read payloads with stable empty documents instead of null document holes", () => {
    const controller = createSoulController();
    const summary = controller.soulSummary({
      scope: "workspace",
      ownerId: "workspace-a",
      document: null,
      canEdit: true,
      workspace: workspaceA,
    });

    const payload = controller.soulReadPayload({
      document: null,
      summary,
      denSynced: false,
    });

    expect(payload.document).toEqual({
      id: "workspace_workspace-a",
      scope: "workspace",
      ownerId: "workspace-a",
      currentVersionId: null,
      heartbeatEnabled: false,
      versions: [],
    });
    expect(payload.summary.status).toBe("not_configured");
    expect(payload.denSynced).toBe(false);
    expect("pendingEdits" in payload).toBe(false);
  });

  test("expands legacy activeRun into all configured workspace ids and trims explicit ids", () => {
    const controller = createSoulController();
    const active = controller.activeSoulWorkspaceIdsFromBody({
      activeRun: true,
      activeWorkspaceIds: [" workspace-c ", "", 42],
    }, baseConfig);

    expect([...active].sort()).toEqual(["workspace-a", "workspace-b", "workspace-c"]);
    expect(controller.soulWorkspaceActiveFromBody({ activeWorkspaceIds: ["workspace-b"] }, "workspace-b")).toBe(true);
    expect(controller.soulWorkspaceActiveFromBody({ activeWorkspaceIds: ["workspace-b"] }, "workspace-a")).toBe(false);
  });

  test("reports cached user Soul as pending when offline pending edits exist", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-soul-controller-"));
    tempDirs.push(dataDir);
    const controller = createSoulController();
    await writePendingSoulEdit({
      dataDir,
      edit: {
        id: "pending-user-1",
        scope: "user",
        ownerId: "user-1",
        content: "Updated user soul",
        changeSummary: "Offline update",
        baseVersionId: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        createdBy: "user-1",
      },
    });

    const model = await controller.readUserSoulModel(dataDir, requestContext({
      "x-veslo-user-id": "user-1",
    }));

    expect(model.document).toBeNull();
    expect(model.summary.ownerId).toBe("user-1");
    expect(model.summary.status).toBe("pending");
    expect(model.pendingEdits?.map((edit) => edit.id)).toEqual(["pending-user-1"]);
    expect(model.denSynced).toBe(false);
  });
});
