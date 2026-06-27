import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { WorkspaceInfo } from "../../lib/tauri";
import {
  publishWorkspaceProfileShare,
  publishWorkspaceSkillsSetShare,
  resolveShareExportContext,
  resolveShareFields,
  resolveShareServiceDisabledReason,
  resolveWorkspaceShareDetail,
} from "../../pages/workspace-share-controller.js";

const t = (key: string) => key;

const localWorkspace = (overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id: "local-a",
  name: "Local A",
  path: "C:/work/local-a",
  preset: "default",
  workspaceType: "local",
  ...overrides,
});

const remoteVesloWorkspace = (overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id: "remote-a",
  name: "Remote A",
  path: "",
  preset: "default",
  workspaceType: "remote",
  remoteType: "veslo",
  baseUrl: "https://worker.example/workspaces/remote-a",
  directory: "/srv/remote-a",
  vesloWorkspaceId: "remote-a",
  vesloHostUrl: "https://worker.example",
  vesloToken: "workspace-token",
  ...overrides,
});

test("workspace share helpers derive disabled reasons and fields for local and remote workers", () => {
  assert.equal(
    resolveShareServiceDisabledReason({
      workspace: null,
      hostInfo: null,
      settings: {},
      t,
    }),
    "share.select_worker_first",
  );

  assert.equal(
    resolveShareServiceDisabledReason({
      workspace: localWorkspace(),
      hostInfo: { baseUrl: "http://127.0.0.1:3939", clientToken: "" } as any,
      settings: {},
      t,
    }),
    "share.local_host_not_ready",
  );

  assert.equal(
    resolveShareServiceDisabledReason({
      workspace: remoteVesloWorkspace({ vesloToken: "", baseUrl: "https://worker.example" }),
      hostInfo: null,
      settings: {},
      t,
    }),
    "share.missing_token",
  );

  assert.equal(
    resolveWorkspaceShareDetail({
      workspace: remoteVesloWorkspace(),
    }),
    "https://worker.example/w/remote-a",
  );

  const localFields = resolveShareFields({
    workspace: localWorkspace(),
    hostInfo: {
      baseUrl: "http://127.0.0.1:3939",
      connectUrl: "http://lan.local:3939",
      clientToken: "local-token",
    } as any,
    settings: {},
    localVesloWorkspaceId: "local-worker-id",
    isDesktopRuntime: true,
    remoteTokenMissingPlaceholder: "settings-token-placeholder",
    t,
  });
  assert.equal(localFields[0]?.label, "share.invite_link_label");
  assert.match(localFields[0]?.value ?? "", /http%3A%2F%2Flan\.local%3A3939%2Fw%2Flocal-worker-id/);
  assert.equal(localFields[2]?.value, "local-token");

  const remoteFields = resolveShareFields({
    workspace: remoteVesloWorkspace({ vesloToken: "" }),
    hostInfo: null,
    settings: {},
    localVesloWorkspaceId: null,
    isDesktopRuntime: true,
    remoteTokenMissingPlaceholder: "settings-token-placeholder",
    t,
  });
  assert.equal(remoteFields[2]?.placeholder, "settings-token-placeholder");
});

test("share export context resolves local and remote workspace ids without page-specific state", async () => {
  const localIds: string[] = [];
  const localClient = {
    listWorkspaces: async () => ({
      items: [{ id: "worker-local-a", name: "Local A", path: "C:\\work\\local-a", workspaceType: "local" }],
    }),
    exportWorkspace: async () => ({ workspaceId: "worker-local-a", exportedAt: 1, skills: [] }),
  };

  const localContext = await resolveShareExportContext({
    workspace: localWorkspace({ path: "C:/work/local-a" }),
    hostInfo: { baseUrl: "http://127.0.0.1:3939", clientToken: "local-token" } as any,
    settings: {},
    localVesloWorkspaceId: null,
    setLocalVesloWorkspaceId: (id) => localIds.push(id ?? ""),
    createClient: ({ baseUrl, token }) => {
      assert.equal(baseUrl, "http://127.0.0.1:3939");
      assert.equal(token, "local-token");
      return localClient as any;
    },
    t,
  });

  assert.equal(localContext.workspaceId, "worker-local-a");
  assert.deepEqual(localIds, ["worker-local-a"]);

  const remoteClient = {
    listWorkspaces: async () => ({ items: [], activeId: null }),
    exportWorkspace: async () => ({ workspaceId: "remote-a", exportedAt: 1, skills: [] }),
  };
  const remoteContext = await resolveShareExportContext({
    workspace: remoteVesloWorkspace({ vesloWorkspaceId: "", baseUrl: "https://worker.example/w/remote-a" }),
    hostInfo: null,
    settings: { token: "settings-token" },
    localVesloWorkspaceId: null,
    setLocalVesloWorkspaceId: () => undefined,
    createClient: ({ baseUrl, token }) => {
      assert.equal(baseUrl, "https://worker.example");
      assert.equal(token, "workspace-token");
      return remoteClient as any;
    },
    t,
  });

  assert.equal(remoteContext.workspaceId, "remote-a");
});

test("share publishing builds workspace profile and skills-set bundles from the same export context", async () => {
  const published: Array<{ bundleType: string; name?: string; payload: any }> = [];
  const copied: string[] = [];
  const client = {
    exportWorkspace: async (workspaceId: string) => ({
      workspaceId,
      exportedAt: 10,
      skills: [
        { name: "review", description: "Review code", trigger: "review", content: "Read carefully" },
      ],
    }),
  };

  const profileUrl = await publishWorkspaceProfileShare({
    resolveContext: async () => ({
      client: client as any,
      workspaceId: "worker-a",
      workspace: localWorkspace({ name: "Worker A" }),
    }),
    workspaceLabel: (workspace) => workspace.name,
    publishBundle: async (input) => {
      published.push(input as any);
      return { url: "https://share.example/profile" };
    },
    writeClipboardText: async (value) => {
      copied.push(value);
    },
    t,
  });

  assert.equal(profileUrl, "https://share.example/profile");
  assert.equal(published[0]?.bundleType, "workspace-profile");
  assert.equal(published[0]?.payload.type, "workspace-profile");
  assert.equal(published[0]?.payload.workspace.workspaceId, "worker-a");

  const skillsUrl = await publishWorkspaceSkillsSetShare({
    resolveContext: async () => ({
      client: client as any,
      workspaceId: "worker-a",
      workspace: localWorkspace({ name: "Worker A" }),
    }),
    workspaceLabel: (workspace) => workspace.name,
    publishBundle: async (input) => {
      published.push(input as any);
      return { url: "https://share.example/skills" };
    },
    writeClipboardText: async (value) => {
      copied.push(value);
    },
    t,
  });

  assert.equal(skillsUrl, "https://share.example/skills");
  assert.equal(published[1]?.bundleType, "skills-set");
  assert.deepEqual(published[1]?.payload.skills, [
    { name: "review", description: "Review code", trigger: "review", content: "Read carefully" },
  ]);
  assert.deepEqual(copied, ["https://share.example/profile", "https://share.example/skills"]);
});

test("session and dashboard wire share orchestration through the shared controller", () => {
  const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
  const dashboardSource = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");

  assert.match(sessionSource, /createWorkspaceShareController\(\{/);
  assert.match(dashboardSource, /createWorkspaceShareController\(\{/);
  assert.doesNotMatch(sessionSource, /const publishWorkspaceProfileLink = async/);
  assert.doesNotMatch(dashboardSource, /const publishWorkspaceProfileLink = async/);
});
