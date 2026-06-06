import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import type {
  VesloServerClient,
  VesloSoulAuthContext,
  VesloSoulReadResponse,
  VesloSoulSummary,
  VesloSoulVersion,
} from "../lib/veslo-server";
import { createSoulEditorController, type SoulEditorSource } from "./soul-controller.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function solidRuntimeSupportsSignalUpdates() {
  let observed = "initial";
  createRoot((dispose) => {
    const [value, setValue] = createSignal("initial");
    createComputed(() => {
      observed = value();
    });
    setValue("updated");
    dispose();
  });
  return observed === "updated";
}

const behaviorTestOptions = solidRuntimeSupportsSignalUpdates()
  ? {}
  : {
      skip:
        "Solid's node/server condition does not run client-side signal updates; run with node --conditions=browser.",
    };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const authContext: VesloSoulAuthContext = {
  denApiBase: "https://den.test",
  denToken: "den-token",
  denOrgId: "org-1",
  denUserId: "user-1",
};

function summary(input: {
  scope: "organization" | "user" | "workspace";
  ownerId: string;
  title: string;
  currentVersionId: string | null;
  canEdit: boolean;
  heartbeatEnabled?: boolean;
}): VesloSoulSummary {
  return {
    scope: input.scope,
    ownerId: input.ownerId,
    title: input.title,
    currentVersionId: input.currentVersionId,
    updatedAt: "2026-06-06T10:00:00.000Z",
    updatedBy: "tester",
    status: input.currentVersionId ? "active" : "not_configured",
    heartbeatEnabled: input.heartbeatEnabled ?? false,
    pendingSuggestionCount: 0,
    canEdit: input.canEdit,
  };
}

function version(id: string, content: string, changeSummary = `Change ${id}`): VesloSoulVersion {
  return {
    id,
    content,
    changeSummary,
    createdAt: "2026-06-06T10:00:00.000Z",
    createdBy: "tester",
    source: "api",
    baseVersionId: null,
    restoreSourceVersionId: null,
  };
}

function readResponse(source: SoulEditorSource, content: string, options?: { versionId?: string }): VesloSoulReadResponse {
  const versionId = options?.versionId ?? source.summary?.currentVersionId ?? null;
  return {
    summary: source.summary ?? summary({
      scope: source.scope,
      ownerId: source.scope === "workspace" ? source.workspaceId : source.key,
      title: source.key,
      currentVersionId: versionId,
      canEdit: true,
    }),
    document: {
      id: `${source.key}-doc`,
      scope: source.scope,
      ownerId: source.scope === "workspace" ? source.workspaceId : source.key,
      currentVersionId: versionId,
      heartbeatEnabled: source.summary?.heartbeatEnabled ?? false,
      versions: versionId ? [version(versionId, content, "Current")] : [],
    },
  };
}

function sources(options?: { orgCanEdit?: boolean; workspaceHeartbeat?: boolean }): SoulEditorSource[] {
  return [
    {
      key: "organization",
      scope: "organization",
      summary: summary({
        scope: "organization",
        ownerId: "org-1",
        title: "Organization Soul",
        currentVersionId: "org-v1",
        canEdit: options?.orgCanEdit ?? false,
      }),
    },
    {
      key: "user",
      scope: "user",
      summary: summary({
        scope: "user",
        ownerId: "user-1",
        title: "User Soul",
        currentVersionId: "user-v1",
        canEdit: true,
      }),
    },
    {
      key: "workspace:ws-1",
      scope: "workspace",
      workspaceId: "ws-1",
      summary: summary({
        scope: "workspace",
        ownerId: "ws-1",
        title: "Workspace One",
        currentVersionId: "ws-v1",
        canEdit: true,
        heartbeatEnabled: options?.workspaceHeartbeat ?? true,
      }),
    },
  ];
}

function makeClient(sourceList = sources()) {
  const calls = {
    updateOrganizationSoul: [] as unknown[],
    updateUserSoul: [] as unknown[],
    updateWorkspaceSoul: [] as unknown[],
    restoreOrganizationSoulVersion: [] as unknown[],
    restoreUserSoulVersion: [] as unknown[],
    restoreWorkspaceSoulVersion: [] as unknown[],
    setWorkspaceSoulHeartbeat: [] as unknown[],
  };

  const byKey = new Map(sourceList.map((source) => [source.key, source]));
  const responseFor = (key: string, content: string) => readResponse(byKey.get(key) ?? sourceList[0], content);
  const history = [
    version("user-v1", "Current user", "Current user"),
    version("user-v0", "Old user", "Old user"),
  ];

  const client = {
    getOrganizationSoul: async () => responseFor("organization", "Current org"),
    getUserSoul: async () => responseFor("user", "Current user"),
    getWorkspaceSoul: async (workspaceId: string) => responseFor(`workspace:${workspaceId}`, "Current workspace"),
    listSoulVersions: async () => ({ versions: history }),
    getSoulVersion: async (_scope: string, versionId: string) => ({
      version: history.find((item) => item.id === versionId) ?? version(versionId, "Preview"),
    }),
    updateOrganizationSoul: async (input: unknown) => {
      calls.updateOrganizationSoul.push(input);
      return responseFor("organization", (input as { content: string }).content);
    },
    updateUserSoul: async (input: unknown) => {
      calls.updateUserSoul.push(input);
      return responseFor("user", (input as { content: string }).content);
    },
    updateWorkspaceSoul: async (workspaceId: string, input: unknown) => {
      calls.updateWorkspaceSoul.push({ workspaceId, input });
      return responseFor(`workspace:${workspaceId}`, (input as { content: string }).content);
    },
    restoreOrganizationSoulVersion: async (versionId: string, input: unknown) => {
      calls.restoreOrganizationSoulVersion.push({ versionId, input });
      return responseFor("organization", "Restored org");
    },
    restoreUserSoulVersion: async (versionId: string, input: unknown) => {
      calls.restoreUserSoulVersion.push({ versionId, input });
      return responseFor("user", "Restored user");
    },
    restoreWorkspaceSoulVersion: async (workspaceId: string, versionId: string, input: unknown) => {
      calls.restoreWorkspaceSoulVersion.push({ workspaceId, versionId, input });
      return responseFor(`workspace:${workspaceId}`, "Restored workspace");
    },
    setWorkspaceSoulHeartbeat: async (workspaceId: string, enabled: boolean) => {
      calls.setWorkspaceSoulHeartbeat.push({ workspaceId, enabled });
      return responseFor(`workspace:${workspaceId}`, "Current workspace");
    },
  } as Partial<VesloServerClient> as VesloServerClient;

  return { client, calls };
}

function createController(input?: {
  sourceList?: SoulEditorSource[];
  client?: VesloServerClient;
  refresh?: () => void;
}) {
  const fallbackClient = input?.client ?? makeClient(input?.sourceList).client;
  return createSoulEditorController({
    sources: () => input?.sourceList ?? sources(),
    client: () => fallbackClient,
    serverConnected: () => true,
    authContext: () => authContext,
    refresh: input?.refresh ?? (() => {}),
    defaultChangeSummary: () => "Update Soul content",
    defaultRestoreSummary: () => "Restore selected Soul version",
    detailErrorMessage: () => "Failed to load Soul details.",
    historyErrorMessage: () => "Failed to load version history.",
    previewErrorMessage: () => "Failed to load version preview.",
  });
}

test("Soul editor controller selects organization user and workspace sources and gates org editing from summary", behaviorTestOptions, async () => {
  await createRoot(async (dispose) => {
    try {
      const controller = createController();
      await flush();

      assert.equal(controller.selectedSourceKey(), "organization");
      assert.equal(controller.selectedCanEdit(), false);
      assert.equal(controller.saveDisabled(), true);

      controller.setSelectedSourceKey("user");
      await flush();
      assert.equal(controller.selectedSource()?.scope, "user");
      assert.equal(controller.selectedCanEdit(), true);

      controller.setSelectedSourceKey("workspace:ws-1");
      await flush();
      const workspaceSource = controller.selectedSource();
      assert.equal(workspaceSource?.scope, "workspace");
      assert.equal(workspaceSource?.scope === "workspace" ? workspaceSource.workspaceId : null, "ws-1");
    } finally {
      dispose();
    }
  });
});

test("Soul editor controller does not let organization detail override overview editability", behaviorTestOptions, async () => {
  const sourceList = sources().map((source) =>
    source.scope === "organization" ? { ...source, summary: null } : source,
  );
  const { client } = makeClient(sourceList);

  await createRoot(async (dispose) => {
    try {
      const controller = createController({ sourceList, client });
      await flush();

      assert.equal(controller.selectedSourceKey(), "organization");
      assert.equal(controller.selectedCanEdit(), false);
      assert.equal(controller.saveDisabled(), true);
    } finally {
      dispose();
    }
  });
});

test("Soul editor controller saves content with change summary and current baseVersionId", behaviorTestOptions, async () => {
  const { client, calls } = makeClient();

  await createRoot(async (dispose) => {
    try {
      const controller = createController({ client });
      controller.setSelectedSourceKey("user");
      await flush();

      controller.setContent("Updated user Soul");
      controller.setChangeSummary("Clarify preferences");
      await controller.saveSelectedSoul();

      assert.deepEqual(calls.updateUserSoul, [
        {
          ...authContext,
          content: "Updated user Soul",
          changeSummary: "Clarify preferences",
          baseVersionId: "user-v1",
        },
      ]);
    } finally {
      dispose();
    }
  });
});

test("Soul editor controller keeps save pending state scoped to source and request", behaviorTestOptions, async () => {
  const sourceList = sources({ orgCanEdit: true });
  const orgSave = deferred<VesloSoulReadResponse>();
  const userSave = deferred<VesloSoulReadResponse>();
  const { client } = makeClient(sourceList);
  (client as unknown as { updateOrganizationSoul: VesloServerClient["updateOrganizationSoul"] }).updateOrganizationSoul =
    async () => orgSave.promise;
  (client as unknown as { updateUserSoul: VesloServerClient["updateUserSoul"] }).updateUserSoul = async () =>
    userSave.promise;

  await createRoot(async (dispose) => {
    try {
      const controller = createController({ sourceList, client });
      await flush();
      controller.setContent("Org edit");
      const orgPromise = controller.saveSelectedSoul();
      assert.equal(controller.selectedSavePending(), true);

      controller.setSelectedSourceKey("user");
      await flush();
      assert.equal(controller.selectedSavePending(), false);

      controller.setContent("User edit");
      const userPromise = controller.saveSelectedSoul();
      assert.equal(controller.selectedSavePending(), true);

      orgSave.resolve(readResponse(sourceList[0], "Saved org"));
      await orgPromise;
      assert.equal(controller.selectedSourceKey(), "user");
      assert.equal(controller.selectedSavePending(), true);

      userSave.resolve(readResponse(sourceList[1], "Saved user"));
      await userPromise;
      assert.equal(controller.selectedSavePending(), false);
    } finally {
      dispose();
    }
  });
});

test("Soul editor controller toggles workspace heartbeat through the workspace endpoint", behaviorTestOptions, async () => {
  const { client, calls } = makeClient(sources({ workspaceHeartbeat: true }));

  await createRoot(async (dispose) => {
    try {
      const controller = createController({ client, sourceList: sources({ workspaceHeartbeat: true }) });
      controller.setSelectedSourceKey("workspace:ws-1");
      await flush();

      await controller.toggleWorkspaceHeartbeat();

      assert.deepEqual(calls.setWorkspaceSoulHeartbeat, [{ workspaceId: "ws-1", enabled: false }]);
    } finally {
      dispose();
    }
  });
});

test("Soul editor controller disables restore for current version and restores a non-current version", behaviorTestOptions, async () => {
  const { client, calls } = makeClient();

  await createRoot(async (dispose) => {
    try {
      const controller = createController({ client });
      controller.setSelectedSourceKey("user");
      await flush();

      await controller.previewVersion("user-v1");
      assert.equal(controller.restoreDisabled(), true);

      await controller.previewVersion("user-v0");
      assert.equal(controller.restoreDisabled(), false);
      controller.setRestoreChangeSummary("Return to old preferences");
      await controller.restoreSelectedVersion("user-v0");

      assert.deepEqual(calls.restoreUserSoulVersion, [
        {
          versionId: "user-v0",
          input: {
            ...authContext,
            changeSummary: "Return to old preferences",
          },
        },
      ]);
    } finally {
      dispose();
    }
  });
});

test("Soul editor controller keeps restore pending state scoped to source and request", behaviorTestOptions, async () => {
  const sourceList = sources({ orgCanEdit: true });
  const orgRestore = deferred<VesloSoulReadResponse>();
  const userRestore = deferred<VesloSoulReadResponse>();
  const { client } = makeClient(sourceList);
  (client as unknown as { restoreOrganizationSoulVersion: VesloServerClient["restoreOrganizationSoulVersion"] }).restoreOrganizationSoulVersion =
    async () => orgRestore.promise;
  (client as unknown as { restoreUserSoulVersion: VesloServerClient["restoreUserSoulVersion"] }).restoreUserSoulVersion =
    async () => userRestore.promise;

  await createRoot(async (dispose) => {
    try {
      const controller = createController({ sourceList, client });
      await flush();
      await controller.previewVersion("user-v0");
      const orgPromise = controller.restoreSelectedVersion("user-v0");
      assert.equal(controller.selectedRestorePending(), true);

      controller.setSelectedSourceKey("user");
      await flush();
      await controller.previewVersion("user-v0");
      assert.equal(controller.selectedRestorePending(), false);

      const userPromise = controller.restoreSelectedVersion("user-v0");
      assert.equal(controller.selectedRestorePending(), true);

      orgRestore.resolve(readResponse(sourceList[0], "Restored org"));
      await orgPromise;
      assert.equal(controller.selectedSourceKey(), "user");
      assert.equal(controller.selectedRestorePending(), true);

      userRestore.resolve(readResponse(sourceList[1], "Restored user"));
      await userPromise;
      assert.equal(controller.selectedRestorePending(), false);
    } finally {
      dispose();
    }
  });
});
