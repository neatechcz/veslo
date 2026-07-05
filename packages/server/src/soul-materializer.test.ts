import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  materializeEffectiveSoul,
  soulMaterializationManifestPath,
  type SoulMaterializationManifest,
} from "./soul-materializer.js";
import { readJsoncFile } from "./jsonc.js";
import { startServer } from "./server.js";
import type { SoulDocument } from "./soul-memory.js";

const tempDirs: string[] = [];
const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore cleanup errors
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

function document(input: {
  scope: SoulDocument["scope"];
  ownerId: string;
  versionId: string;
  content: string;
}): SoulDocument {
  return {
    id: `${input.scope}_${input.ownerId}`,
    scope: input.scope,
    ownerId: input.ownerId,
    currentVersionId: input.versionId,
    heartbeatEnabled: true,
    versions: [
      {
        id: input.versionId,
        content: input.content,
        changeSummary: "Initial",
        createdAt: "2026-06-05T10:00:00.000Z",
        createdBy: "user_1",
        source: "api",
        baseVersionId: null,
        restoreSourceVersionId: null,
      },
    ],
  };
}

const soulDocs = () => ({
  organization: document({
    scope: "organization",
    ownerId: "org_1",
    versionId: "org_v1",
    content: "Organization memory",
  }),
  user: document({ scope: "user", ownerId: "user_1", versionId: "user_v1", content: "User memory" }),
  workspace: document({
    scope: "workspace",
    ownerId: "ws_1",
    versionId: "workspace_v1",
    content: "Workspace memory",
  }),
});

test("effective Soul composes Organization, User, Workspace in order and writes managed source files", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-workspace-");
  const docs = soulDocs();

  const result = await materializeEffectiveSoul({ workspaceRoot, ...docs });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.effectiveContent).toBe("Organization memory\n\nUser memory\n\nWorkspace memory");
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-company.md"), "utf8")).toBe("Organization memory\n");
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-user.md"), "utf8")).toBe("User memory\n");
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-workspace.md"), "utf8")).toBe("Workspace memory\n");
});

test("materializer writes and updates managed runtime files and manifest", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-managed-");
  const initial = soulDocs();
  await materializeEffectiveSoul({ workspaceRoot, ...initial });

  const updatedUser = document({
    scope: "user",
    ownerId: "user_1",
    versionId: "user_v2",
    content: "Updated user memory",
  });
  const result = await materializeEffectiveSoul({ workspaceRoot, ...initial, user: updatedUser });

  expect(result.ok).toBe(true);
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-user.md"), "utf8")).toBe("Updated user memory\n");
  const manifest = JSON.parse(await readFile(soulMaterializationManifestPath(workspaceRoot), "utf8")) as SoulMaterializationManifest;
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.composition.order).toEqual(["organization", "user", "workspace"]);
  expect(manifest.composition.currentVersionIds).toEqual({
    organization: "org_v1",
    user: "user_v2",
    workspace: "workspace_v1",
  });
  expect(manifest.files).toContainEqual(expect.objectContaining({
    path: ".opencode/soul-user.md",
    scope: "user",
    ownerId: "user_1",
    currentVersionId: "user_v2",
    managedBy: "veslo-soul-materializer",
  }));
});

test("existing unmanaged Soul target files are not overwritten and return actionable conflict status", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-conflict-");
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  await writeFile(join(workspaceRoot, ".opencode", "soul-user.md"), "User-authored memory\n", "utf8");

  const result = await materializeEffectiveSoul({ workspaceRoot, ...soulDocs() });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected materialization conflict");
  expect(result.reason).toBe("conflict");
  expect(result.requiresAction).toBe("preserve_unmanaged_soul_file");
  expect(result.conflicts).toContainEqual(expect.objectContaining({
    path: join(workspaceRoot, ".opencode", "soul-user.md"),
    relativePath: ".opencode/soul-user.md",
  }));
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-user.md"), "utf8")).toBe("User-authored memory\n");
});

test("manifestless Soul runtime files that already match source documents are adopted", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-adopt-");
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  await writeFile(join(workspaceRoot, ".opencode", "soul-company.md"), "Organization memory\n", "utf8");
  await writeFile(join(workspaceRoot, ".opencode", "soul-user.md"), "User memory\n", "utf8");
  await writeFile(join(workspaceRoot, ".opencode", "soul-workspace.md"), "Workspace memory\n", "utf8");

  const result = await materializeEffectiveSoul({ workspaceRoot, ...soulDocs() });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  const manifest = JSON.parse(await readFile(soulMaterializationManifestPath(workspaceRoot), "utf8")) as SoulMaterializationManifest;
  expect(manifest.files).toContainEqual(expect.objectContaining({
    path: ".opencode/soul-company.md",
    scope: "organization",
    currentVersionId: "org_v1",
  }));
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-company.md"), "utf8")).toBe("Organization memory\n");
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-user.md"), "utf8")).toBe("User memory\n");
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-workspace.md"), "utf8")).toBe("Workspace memory\n");
});

test("manifestless Soul runtime files matching previous source versions are adopted and updated", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-adopt-version-");
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  await writeFile(join(workspaceRoot, ".opencode", "soul-company.md"), "Organization memory\n", "utf8");
  await writeFile(join(workspaceRoot, ".opencode", "soul-user.md"), "User memory\n", "utf8");
  await writeFile(join(workspaceRoot, ".opencode", "soul-workspace.md"), "Workspace memory\n", "utf8");
  const initial = soulDocs();
  const updatedOrganization: SoulDocument = {
    ...initial.organization,
    currentVersionId: "org_v2",
    versions: [
      ...initial.organization.versions,
      {
        id: "org_v2",
        content: "Updated organization memory",
        changeSummary: "Update organization",
        createdAt: "2026-06-05T11:00:00.000Z",
        createdBy: "user_1",
        source: "api",
        baseVersionId: "org_v1",
        restoreSourceVersionId: null,
      },
    ],
  };

  const result = await materializeEffectiveSoul({
    workspaceRoot,
    ...initial,
    organization: updatedOrganization,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  const manifest = JSON.parse(await readFile(soulMaterializationManifestPath(workspaceRoot), "utf8")) as SoulMaterializationManifest;
  expect(manifest.composition.currentVersionIds.organization).toBe("org_v2");
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-company.md"), "utf8")).toBe("Updated organization memory\n");
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-user.md"), "utf8")).toBe("User memory\n");
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-workspace.md"), "utf8")).toBe("Workspace memory\n");
});

test("manifest-owned files with local edits are not overwritten", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-drift-");
  const initial = soulDocs();
  await materializeEffectiveSoul({ workspaceRoot, ...initial });
  await writeFile(join(workspaceRoot, ".opencode", "soul-user.md"), "Local edit\n", "utf8");

  const updatedUser = document({
    scope: "user",
    ownerId: "user_1",
    versionId: "user_v2",
    content: "Updated user memory",
  });
  const result = await materializeEffectiveSoul({ workspaceRoot, ...initial, user: updatedUser });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected materialization drift conflict");
  expect(result.reason).toBe("conflict");
  expect(result.requiresAction).toBe("preserve_unmanaged_soul_file");
  expect(result.conflicts).toContainEqual(expect.objectContaining({
    relativePath: ".opencode/soul-user.md",
    reason: "managed_target_modified",
  }));
  expect(await readFile(join(workspaceRoot, ".opencode", "soul-user.md"), "utf8")).toBe("Local edit\n");
});

test("manifest-owned missing files return actionable status instead of silently recreating", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-missing-");
  const docs = soulDocs();
  await materializeEffectiveSoul({ workspaceRoot, ...docs });
  await rm(join(workspaceRoot, ".opencode", "soul-user.md"), { force: true });

  const result = await materializeEffectiveSoul({ workspaceRoot, ...docs });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected materialization missing-file conflict");
  expect(result.reason).toBe("conflict");
  expect(result.requiresAction).toBe("restore_managed_soul_file");
  expect(result.conflicts).toContainEqual(expect.objectContaining({
    relativePath: ".opencode/soul-user.md",
    reason: "managed_target_missing",
  }));
});

test("opencode instructions include all three Soul files while preserving existing instructions", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-instructions-");
  await writeFile(
    join(workspaceRoot, "opencode.jsonc"),
    '{\n  // keep this comment parseable\n  "instructions": "AGENTS.md"\n}\n',
    "utf8",
  );

  const result = await materializeEffectiveSoul({ workspaceRoot, ...soulDocs() });

  expect(result.ok).toBe(true);
  const { data } = await readJsoncFile<Record<string, unknown>>(join(workspaceRoot, "opencode.jsonc"), {});
  expect(data.instructions).toEqual([
    "AGENTS.md",
    ".opencode/soul-company.md",
    ".opencode/soul-user.md",
    ".opencode/soul-workspace.md",
  ]);
});

test("workspace Heartbeat turns on when Workspace Soul is created through the route", async () => {
  const dataDir = await tempDir("veslo-soul-materializer-route-data-");
  const workspaceRoot = await tempDir("veslo-soul-materializer-route-workspace-");
  const previousDataDir = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    configPath: join(dataDir, "server.json"),
    workspaces: [{
      id: "ws_1",
      name: "Workspace",
      path: workspaceRoot,
      workspaceType: "local",
    }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 5000,
    },
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  if (previousDataDir === undefined) {
    delete process.env.VESLO_DATA_DIR;
  } else {
    process.env.VESLO_DATA_DIR = previousDataDir;
  }

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/soul`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer client-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: "Workspace memory", changeSummary: "Seed", baseVersionId: null }),
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    document: SoulDocument;
    materialization?: { ok: boolean; manualSyncRequired?: boolean; requiresAction?: string };
  };
  expect(payload.document.heartbeatEnabled).toBe(true);
  expect(payload.materialization?.ok).toBe(true);
  expect(payload.materialization?.manualSyncRequired).not.toBe(true);
  expect(payload.materialization?.requiresAction).not.toBe("manual_sync");
});

test("workspace Soul status reports drift for modified materialized files", async () => {
  const dataDir = await tempDir("veslo-soul-materializer-status-data-");
  const workspaceRoot = await tempDir("veslo-soul-materializer-status-workspace-");
  const previousDataDir = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    configPath: join(dataDir, "server.json"),
    workspaces: [{
      id: "ws_1",
      name: "Workspace",
      path: workspaceRoot,
      workspaceType: "local",
    }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 5000,
    },
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  if (previousDataDir === undefined) {
    delete process.env.VESLO_DATA_DIR;
  } else {
    process.env.VESLO_DATA_DIR = previousDataDir;
  }

  const patch = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/soul`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer client-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: "Workspace memory", changeSummary: "Seed", baseVersionId: null }),
  });
  expect(patch.status).toBe(200);
  await writeFile(join(workspaceRoot, ".opencode", "soul-workspace.md"), "Local edit\n", "utf8");

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/soul`, {
    headers: { Authorization: "Bearer client-token" },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    materialization?: {
      ok: boolean;
      reason?: string;
      requiresAction?: string;
      conflicts?: Array<{ relativePath: string; reason: string }>;
    };
  };
  expect(payload.materialization?.ok).toBe(false);
  expect(payload.materialization?.reason).toBe("conflict");
  expect(payload.materialization?.requiresAction).toBe("preserve_unmanaged_soul_file");
  expect(payload.materialization?.conflicts).toContainEqual(expect.objectContaining({
    relativePath: ".opencode/soul-workspace.md",
    reason: "managed_target_modified",
  }));
});

test("materializer does not expose manual sync as required user action", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-automatic-");

  const result = await materializeEffectiveSoul({ workspaceRoot, ...soulDocs() });

  expect(result.ok).toBe(true);
  expect(result.pending).toBe(false);
  expect(result.manualSyncRequired).toBe(false);
  expect(result.requiresAction).not.toBe("manual_sync");
});

test("failed materialization returns actionable status", async () => {
  const workspaceRoot = await tempDir("veslo-soul-materializer-failed-");
  await writeFile(join(workspaceRoot, "opencode.jsonc"), "{ invalid jsonc", "utf8");

  const result = await materializeEffectiveSoul({ workspaceRoot, ...soulDocs() });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected materialization failure");
  expect(result.reason).toBe("config_error");
  expect(result.requiresAction).toBe("fix_opencode_config");
  expect(result.path).toBe(join(workspaceRoot, "opencode.jsonc"));
  expect(result.message).toContain("Failed to parse JSONC");
});
