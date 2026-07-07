import assert from "node:assert/strict";
import test from "node:test";

import { VesloServerError } from "../../lib/veslo-server.js";
import {
  createSessionAttachmentStaging,
  type SessionAttachmentStagingClient,
  type SessionAttachmentStagingDeps,
  type SessionAttachmentWorkspaceEntry,
} from "../../pages/session-attachment-staging.js";
import type { ComposerDraft } from "../../types.js";

const baseDraft = (input?: Partial<ComposerDraft>): ComposerDraft => ({
  mode: "prompt",
  parts: [],
  attachments: [],
  text: "Inspect this",
  ...input,
});

function makeClient(input?: {
  workspaces?: SessionAttachmentWorkspaceEntry[][];
  createFileSession?: SessionAttachmentStagingClient["createFileSession"];
  readFileBatch?: SessionAttachmentStagingClient["readFileBatch"];
  writeFileBatch?: SessionAttachmentStagingClient["writeFileBatch"];
  closeFileSession?: SessionAttachmentStagingClient["closeFileSession"];
}) {
  const calls = {
    listWorkspaces: 0,
    createFileSession: [] as Array<{ workspaceId: string; write?: boolean }>,
    readFileBatch: [] as Array<{ fileSessionId: string; paths: string[] }>,
    writeFileBatch: [] as Array<{ fileSessionId: string; items: Array<{ path: string; contentBase64: string }> }>,
    closeFileSession: [] as string[],
  };
  const workspaceResponses = input?.workspaces ?? [[{ id: "workspace-a", path: "/repo" }]];
  const client: SessionAttachmentStagingClient = {
    async listWorkspaces() {
      const index = Math.min(calls.listWorkspaces, workspaceResponses.length - 1);
      calls.listWorkspaces += 1;
      return { items: workspaceResponses[index] ?? [] };
    },
    async createFileSession(workspaceId, options) {
      calls.createFileSession.push({ workspaceId, write: options.write });
      if (input?.createFileSession) return await input.createFileSession(workspaceId, options);
      return { session: { id: "file-session-a" } };
    },
    async readFileBatch(fileSessionId, paths) {
      calls.readFileBatch.push({ fileSessionId, paths });
      if (input?.readFileBatch) return await input.readFileBatch(fileSessionId, paths);
      return { items: paths.map(() => ({ ok: false, code: "file_not_found" })) };
    },
    async writeFileBatch(fileSessionId, items) {
      calls.writeFileBatch.push({ fileSessionId, items });
      if (input?.writeFileBatch) return await input.writeFileBatch(fileSessionId, items);
      return { items: items.map(() => ({ ok: true })) };
    },
    async closeFileSession(fileSessionId) {
      calls.closeFileSession.push(fileSessionId);
      if (input?.closeFileSession) return await input.closeFileSession(fileSessionId);
    },
  };
  return { client, calls };
}

function makeDeps(client: SessionAttachmentStagingClient, overrides?: Partial<SessionAttachmentStagingDeps>): SessionAttachmentStagingDeps {
  return {
    vesloServerClient: () => client,
    vesloServerStatus: () => "connected",
    vesloServerWorkspaceId: () => "",
    setVesloServerWorkspaceId: () => undefined,
    vesloServerUrl: () => "http://127.0.0.1:7777",
    envVesloWorkspaceId: "",
    workspaceProjectDir: () => "/repo",
    sessionDirectoryForId: () => "/repo/session-a",
    activeWorkspaceId: () => "app-workspace-a",
    activeWorkspaceRoot: () => "/repo",
    activeWorkspaceDisplay: () => ({
      workspaceType: "local",
      path: "/repo",
      directory: "/repo",
    }),
    selectedSessionBrowseScope: () => null,
    isTauriRuntime: () => true,
    startupPreference: () => "local",
    vesloServerRestart: async () => ({
      running: true,
      baseUrl: "http://127.0.0.1:7777",
      clientToken: "client-token",
      hostToken: "host-token",
    }),
    setVesloServerHostInfoStable: () => undefined,
    setVesloServerStatus: () => undefined,
    setVesloServerCapabilitiesStable: () => undefined,
    setVesloServerCheckedAt: () => undefined,
    checkVesloServer: async () => ({ status: "connected", capabilities: null }),
    resolveConversationServerWorkspaceForSend: async () => null,
    recordSendTrace: () => undefined,
    sendTraceStep: async (_label, run) => await run(),
    safeStringify: (value) => JSON.stringify(value),
    ...overrides,
  };
}

test("uses only active remote identity for attachment staging, not cached global workspace ids", async () => {
  const { client, calls } = makeClient({
    workspaces: [[{ id: "fresh-workspace", path: "/repo", directory: "/repo" }]],
  });
  let storedWorkspaceId = "";
  const staging = createSessionAttachmentStaging(
    makeDeps(client, {
      vesloServerWorkspaceId: () => "stale-workspace",
      setVesloServerWorkspaceId: (value) => {
        storedWorkspaceId = value;
      },
      activeWorkspaceDisplay: () => ({
        workspaceType: "remote",
        remoteType: "veslo",
        vesloHostUrl: "https://veslo.example/w/fresh-workspace",
        directory: "/repo",
      }),
    }),
  );

  const resolved = await staging.resolveWorkspaceIdForAttachmentStaging(client);

  assert.equal(resolved, "fresh-workspace");
  assert.equal(storedWorkspaceId, "fresh-workspace");
  assert.equal(calls.listWorkspaces, 1);
});

test("does not use cached local Veslo workspace ids as attachment staging fallback", async () => {
  const { client } = makeClient({
    workspaces: [[{ id: "stale-cached-workspace", path: "/old", directory: "/old" }]],
  });
  const staging = createSessionAttachmentStaging(
    makeDeps(client, {
      vesloServerWorkspaceId: () => "stale-cached-workspace",
      activeWorkspaceDisplay: () => ({
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
      }),
    }),
  );

  const resolved = await staging.resolveWorkspaceIdForAttachmentStaging(client);

  assert.equal(resolved, "");
});

test("uses mapped local Veslo workspace ids and ignores path matching for attachment staging", async () => {
  const { client, calls } = makeClient({
    workspaces: [[
      { id: "server-mapped", path: "/private/var/repo", directory: "/private/var/repo" },
      { id: "server-path-match", path: "/repo-drifted", directory: "/repo-drifted" },
    ]],
  });
  let storedWorkspaceId = "";
  const staging = createSessionAttachmentStaging(
    makeDeps(client, {
      activeWorkspaceRoot: () => "/repo-drifted",
      activeWorkspaceDisplay: () => ({
        workspaceType: "local",
        path: "/repo-drifted",
        directory: "/repo-drifted",
        vesloWorkspaceId: "server-mapped",
      }),
      setVesloServerWorkspaceId: (value) => {
        storedWorkspaceId = value;
      },
    }),
  );

  const resolved = await staging.resolveWorkspaceIdForAttachmentStaging(client);

  assert.equal(resolved, "server-mapped");
  assert.equal(storedWorkspaceId, "server-mapped");
  assert.deepEqual(calls.createFileSession, []);
});

test("recovers a missing local server workspace once before retrying file-session creation", async () => {
  let createAttempts = 0;
  let restartCalls = 0;
  let checkCalls = 0;
  let cachedWorkspaceId = "local-old";
  const { client, calls } = makeClient({
    workspaces: [
      [{ id: "local-old", path: "/repo", directory: "/repo" }],
      [{ id: "local-new", path: "/repo", directory: "/repo" }],
    ],
    async createFileSession(workspaceId) {
      createAttempts += 1;
      if (createAttempts === 1) {
        throw new VesloServerError(404, "workspace_not_found", `Workspace ${workspaceId} not found`);
      }
      return { session: { id: "file-session-recovered" } };
    },
  });
  const staging = createSessionAttachmentStaging(
    makeDeps(client, {
      vesloServerWorkspaceId: () => cachedWorkspaceId,
      activeWorkspaceDisplay: () => ({
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
        vesloWorkspaceId: cachedWorkspaceId,
      }),
      vesloServerRestart: async () => {
        restartCalls += 1;
        cachedWorkspaceId = "local-new";
        return { running: true, baseUrl: "http://127.0.0.1:7777" };
      },
      checkVesloServer: async () => {
        checkCalls += 1;
        return { status: "connected", capabilities: { upload: true } };
      },
    }),
  );

  const staged = await staging.stageAttachmentsIntoSessionDirectory(
    baseDraft({
      attachments: [
        {
          id: "attachment-a",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          kind: "file",
          dataUrl: "data:text/plain;base64,aGVsbG8=",
        },
      ],
    }),
    "session-a",
    { traceId: "trace-a" },
  );

  assert.equal(restartCalls, 1);
  assert.equal(checkCalls, 1);
  assert.deepEqual(
    calls.createFileSession.map((call) => call.workspaceId),
    ["local-old", "local-new"],
  );
  assert.deepEqual(staged, [
    {
      name: "notes.txt",
      kind: "file",
      mimeType: "text/plain",
      relativePath: "session-a/notes.txt",
      absolutePath: "/repo/session-a/notes.txt",
    },
  ]);
  assert.deepEqual(calls.writeFileBatch[0]?.items, [
    {
      path: "session-a/notes.txt",
      contentBase64: "aGVsbG8=",
    },
  ]);
  assert.deepEqual(calls.closeFileSession, ["file-session-recovered"]);
});

test("builds prompt and command file parts from relative, absolute, and attachment inputs", () => {
  const { client } = makeClient();
  const staging = createSessionAttachmentStaging(makeDeps(client));
  const draft = baseDraft({
    parts: [
      { type: "agent", name: "builder" },
      { type: "file", path: "docs/read me.md" },
      { type: "file", path: "/tmp/absolute.txt" },
      { type: "file", path: "   " },
    ],
    attachments: [
      {
        id: "attachment-image",
        name: "shot.png",
        mimeType: "image/png",
        size: 4,
        kind: "image",
        dataUrl: "data:image/png;base64,AAAA",
      },
    ],
    resolvedText: "Resolved prompt",
  });

  const promptParts = staging.buildPromptParts(draft);
  assert.deepEqual(promptParts, [
    { type: "text", text: "Resolved prompt" },
    { type: "agent", name: "builder" },
    { type: "file", mime: "text/plain", url: "file:///repo/docs/read me.md", filename: "read me.md" },
    { type: "file", mime: "text/plain", url: "file:///tmp/absolute.txt", filename: "absolute.txt" },
    { type: "file", url: "data:image/png;base64,AAAA", filename: "shot.png", mime: "image/png" },
  ]);

  const commandParts = staging.buildCommandFileParts(draft);
  assert.deepEqual(commandParts, [
    { type: "file", mime: "text/plain", url: "file:///repo/docs/read me.md", filename: "read me.md" },
    { type: "file", mime: "text/plain", url: "file:///tmp/absolute.txt", filename: "absolute.txt" },
    { type: "file", url: "data:image/png;base64,AAAA", filename: "shot.png", mime: "image/png" },
  ]);
});

test("empty workspace roots skip relative file references but keep absolute file and attachment parts", () => {
  const { client } = makeClient();
  const staging = createSessionAttachmentStaging(
    makeDeps(client, {
      workspaceProjectDir: () => "",
    }),
  );
  const draft = baseDraft({
    parts: [
      { type: "file", path: "relative.txt" },
      { type: "file", path: "/tmp/absolute.txt" },
    ],
    attachments: [
      {
        id: "attachment-a",
        name: "inline.txt",
        mimeType: "text/plain",
        size: 5,
        kind: "file",
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      },
    ],
  });

  assert.deepEqual(staging.buildCommandFileParts(draft), [
    { type: "file", mime: "text/plain", url: "file:///tmp/absolute.txt", filename: "absolute.txt" },
    { type: "file", url: "data:text/plain;base64,aGVsbG8=", filename: "inline.txt", mime: "text/plain" },
  ]);
});
