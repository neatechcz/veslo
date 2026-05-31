import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { startServer } from "./server.js";
import {
  listSkillRemovals,
  removeSkillWithSnapshot,
  restoreSkillRemoval,
} from "./skill-removal-journal.js";

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

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const createSkill = async (rootDir: string, name: string, body = "Use this skill for demos."): Promise<string> => {
  const skillDir = join(rootDir, ".opencode", "skills", name);
  await mkdir(join(skillDir, "nested"), { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, `---\nname: ${name}\ndescription: Demo skill\n---\n\n${body}\n`, "utf8");
  await writeFile(join(skillDir, "nested", "notes.txt"), `notes for ${name}\n`, "utf8");
  return skillPath;
};

const restoreValidation = (rootDir: string, workspaceId = "ws_1") => ({
  workspace: {
    id: workspaceId,
    rootDir,
    skillRoots: [join(rootDir, ".opencode", "skills"), join(rootDir, ".claude", "skills")],
  },
});

const startFixture = async (options?: {
  workspaces?: Array<{ id: string; name: string; path: string; workspaceType: "local" }>;
  authorizedRoots?: string[];
}) => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  const workspaceRoot = await tempDir("veslo-skill-removal-workspace-");
  const workspaces = options?.workspaces ?? [
    {
      id: "ws_1",
      name: "Workspace",
      path: workspaceRoot,
      workspaceType: "local" as const,
    },
  ];
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
    workspaces,
    authorizedRoots: options?.authorizedRoots ?? workspaces.map((workspace) => workspace.path),
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
  return { dataDir, workspaceRoot, server };
};

test("removeSkillWithSnapshot snapshots the directory before removing the original skill", async () => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  const rootDir = await tempDir("veslo-skill-removal-workspace-");
  const skillPath = await createSkill(rootDir, "demo-skill");
  const skillDir = join(rootDir, ".opencode", "skills", "demo-skill");

  const record = await removeSkillWithSnapshot({
    dataDir,
    actor: { type: "host" },
    source: { scope: "workspace", workspaceId: "ws_1", rootDir, skillPath },
    reason: "cleanup",
  });

  expect(await exists(skillDir)).toBe(false);
  expect(record.name).toBe("demo-skill");
  expect(record.scope).toBe("workspace");
  expect(record.workspaceId).toBe("ws_1");
  expect(record.reason).toBe("cleanup");
  expect(record.actor).toEqual({ type: "host" });
  expect(record.originalDir).toBe(skillDir);
  expect(record.originalPath).toBe(skillPath);
  expect(record.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.removedAt).toBeString();
  expect(Date.parse(record.removedAt ?? "")).toBeGreaterThan(0);

  const recordPath = join(dataDir, "skill-removals", "records", `${record.id}.json`);
  const persisted = JSON.parse(await readFile(recordPath, "utf8"));
  expect(persisted).toEqual(record);
  expect(await readFile(join(dataDir, "skill-removals", "snapshots", record.id, "SKILL.md"), "utf8")).toContain(
    "demo-skill",
  );
  expect(await readFile(join(dataDir, "skill-removals", "snapshots", record.id, "nested", "notes.txt"), "utf8"))
    .toBe("notes for demo-skill\n");
});

test("listSkillRemovals filters records and excludes restored entries by default", async () => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  const workspaceRoot = await tempDir("veslo-skill-removal-workspace-");
  const userRoot = await tempDir("veslo-skill-removal-user-");

  const workspaceRecord = await removeSkillWithSnapshot({
    dataDir,
    actor: { type: "host" },
    source: {
      scope: "workspace",
      workspaceId: "ws_1",
      rootDir: workspaceRoot,
      skillPath: await createSkill(workspaceRoot, "workspace-skill"),
    },
    reason: "workspace cleanup",
  });
  await removeSkillWithSnapshot({
    dataDir,
    actor: { type: "remote", clientId: "client_1" },
    source: { scope: "user-global", rootDir: userRoot, skillPath: await createSkill(userRoot, "global-skill") },
    reason: "global cleanup",
  });

  await restoreSkillRemoval({ dataDir, removalId: workspaceRecord.id, actor: { type: "host" } });

  const activeOnly = await listSkillRemovals({ dataDir });
  expect(activeOnly.map((record) => record.name)).toEqual(["global-skill"]);

  const workspaceItems = await listSkillRemovals({
    dataDir,
    scope: "workspace",
    workspaceId: "ws_1",
    includeRestored: true,
  });
  expect(workspaceItems.map((record) => record.id)).toEqual([workspaceRecord.id]);
  expect(workspaceItems[0].restoredAt).toBeString();
  expect(workspaceItems[0].restoredBy).toEqual({ type: "host" });
});

test("restoreSkillRemoval restores the snapshot and marks the record restored", async () => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  const rootDir = await tempDir("veslo-skill-removal-workspace-");
  const skillPath = await createSkill(rootDir, "demo-skill");

  const record = await removeSkillWithSnapshot({
    dataDir,
    actor: { type: "host" },
    source: { scope: "workspace", workspaceId: "ws_1", rootDir, skillPath },
    reason: "cleanup",
  });

  const restored = await restoreSkillRemoval({
    dataDir,
    removalId: record.id,
    actor: { type: "remote", clientId: "client_1" },
    ...restoreValidation(rootDir),
  });

  expect(restored.path.endsWith("demo-skill/SKILL.md")).toBe(true);
  expect(await readFile(restored.path, "utf8")).toContain("demo-skill");
  expect(await readFile(join(rootDir, ".opencode", "skills", "demo-skill", "nested", "notes.txt"), "utf8"))
    .toBe("notes for demo-skill\n");

  const [restoredRecord] = await listSkillRemovals({ dataDir, includeRestored: true });
  expect(restoredRecord.restoredAt).toBeString();
  expect(restoredRecord.restoredBy).toEqual({ type: "remote", clientId: "client_1" });
});

test("restoreSkillRemoval rejects conflicts when the original directory already exists", async () => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  const rootDir = await tempDir("veslo-skill-removal-workspace-");
  const skillPath = await createSkill(rootDir, "demo-skill");

  const record = await removeSkillWithSnapshot({
    dataDir,
    actor: { type: "host" },
    source: { scope: "workspace", workspaceId: "ws_1", rootDir, skillPath },
    reason: "cleanup",
  });
  await createSkill(rootDir, "demo-skill", "Replacement body.");

  await expect(restoreSkillRemoval({ dataDir, removalId: record.id })).rejects.toThrow(/already exists/);
});

test("listSkillRemovals excludes pending records that were not fully removed", async () => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  await mkdir(join(dataDir, "skill-removals", "records"), { recursive: true });
  await writeFile(
    join(dataDir, "skill-removals", "records", "pending.json"),
    JSON.stringify({
      id: "pending",
      name: "pending-skill",
      scope: "workspace",
      workspaceId: "ws_1",
      rootDir: "/tmp/workspace",
      originalDir: "/tmp/workspace/.opencode/skills/pending-skill",
      originalPath: "/tmp/workspace/.opencode/skills/pending-skill/SKILL.md",
      actor: { type: "host" },
      status: "pending",
      hash: "0".repeat(64),
    }) + "\n",
    "utf8",
  );

  expect(await listSkillRemovals({ dataDir, includeRestored: true })).toEqual([]);
});

test("pending records become listable and restorable when source deletion already happened", async () => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  const rootDir = await tempDir("veslo-skill-removal-workspace-");
  const skillPath = await createSkill(rootDir, "demo-skill");
  const removedRecord = await removeSkillWithSnapshot({
    dataDir,
    actor: { type: "host" },
    source: { scope: "workspace", workspaceId: "ws_1", rootDir, skillPath },
    reason: "cleanup",
  });
  const pendingRecord = {
    ...removedRecord,
    status: "pending",
    removedAt: undefined,
  };
  await writeFile(
    join(dataDir, "skill-removals", "records", `${removedRecord.id}.json`),
    JSON.stringify(pendingRecord) + "\n",
    "utf8",
  );

  const listed = await listSkillRemovals({ dataDir, includeRestored: true });
  expect(listed.map((record) => record.id)).toEqual([removedRecord.id]);

  const restored = await restoreSkillRemoval({
    dataDir,
    removalId: removedRecord.id,
    actor: { type: "host" },
    ...restoreValidation(rootDir),
  });
  expect(await readFile(restored.path, "utf8")).toContain("demo-skill");
});

test("restoreSkillRemoval rejects tampered record paths outside the current workspace skill roots", async () => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  const rootDir = await tempDir("veslo-skill-removal-workspace-");
  const skillPath = await createSkill(rootDir, "demo-skill");
  const record = await removeSkillWithSnapshot({
    dataDir,
    actor: { type: "host" },
    source: { scope: "workspace", workspaceId: "ws_1", rootDir, skillPath },
    reason: "cleanup",
  });
  const recordPath = join(dataDir, "skill-removals", "records", `${record.id}.json`);
  await writeFile(
    recordPath,
    JSON.stringify({
      ...record,
      originalDir: join(tmpdir(), "stale-skills", "demo-skill"),
      originalPath: join(tmpdir(), "stale-skills", "demo-skill", "SKILL.md"),
    }) + "\n",
    "utf8",
  );

  await expect(restoreSkillRemoval({ dataDir, removalId: record.id, ...restoreValidation(rootDir) }))
    .rejects.toThrow(/skill root|authorized|path/i);
});

test("restoreSkillRemoval verifies the snapshot hash before restoring", async () => {
  const dataDir = await tempDir("veslo-skill-removal-data-");
  const rootDir = await tempDir("veslo-skill-removal-workspace-");
  const skillPath = await createSkill(rootDir, "demo-skill");
  const record = await removeSkillWithSnapshot({
    dataDir,
    actor: { type: "host" },
    source: { scope: "workspace", workspaceId: "ws_1", rootDir, skillPath },
    reason: "cleanup",
  });
  await writeFile(
    join(dataDir, "skill-removals", "snapshots", record.id, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Tampered\n---\n\ntampered\n",
    "utf8",
  );

  await expect(restoreSkillRemoval({ dataDir, removalId: record.id, ...restoreValidation(rootDir) }))
    .rejects.toThrow(/hash|integrity/i);
});

test("workspace skill deletion creates a recoverable removal and restore routes can restore it", async () => {
  const { dataDir, workspaceRoot, server } = await startFixture();
  const skillPath = await createSkill(workspaceRoot, "demo-skill");

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_1/skills/demo-skill?path=${encodeURIComponent(skillPath)}`,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer client-token" },
    },
  );

  expect(deleteResponse.status).toBe(200);
  const deletePayload = await deleteResponse.json() as { ok: true; name: string; path: string; removalId: string };
  expect(deletePayload).toMatchObject({
    ok: true,
    name: "demo-skill",
    path: join(workspaceRoot, ".opencode", "skills", "demo-skill"),
  });
  expect(deletePayload.removalId).toBeString();

  const listResponse = await fetch(`http://127.0.0.1:${server.port}/skill-removals?scope=workspace&workspaceId=ws_1`, {
    headers: { Authorization: "Bearer client-token" },
  });
  expect(listResponse.status).toBe(200);
  const listPayload = await listResponse.json() as { items: Array<{ id: string; name: string; path: string; restoredAt?: string }> };
  expect(listPayload.items).toEqual([
    expect.objectContaining({ id: deletePayload.removalId, name: "demo-skill", path: skillPath }),
  ]);
  expect(listPayload.items[0]).not.toHaveProperty("actor");
  expect(listPayload.items[0]).not.toHaveProperty("tokenHash");
  expect(listPayload.items[0]).not.toHaveProperty("rootDir");
  expect(listPayload.items[0]).not.toHaveProperty("originalDir");
  expect(listPayload.items[0]).not.toHaveProperty("originalPath");
  expect(listPayload.items[0]).not.toHaveProperty("hash");

  const restoreResponse = await fetch(
    `http://127.0.0.1:${server.port}/skill-removals/${encodeURIComponent(deletePayload.removalId)}/restore`,
    {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    },
  );

  expect(restoreResponse.status).toBe(200);
  const restorePayload = await restoreResponse.json() as { ok: true; path: string };
  expect(restorePayload.path.endsWith("demo-skill/SKILL.md")).toBe(true);
  expect(await readFile(restorePayload.path, "utf8")).toContain("demo-skill");
  const auditResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/audit`, {
    headers: { Authorization: "Bearer client-token" },
  });
  const auditPayload = await auditResponse.json() as { items: Array<{ action: string; target: string }> };
  expect(auditPayload.items.some((item) => item.action === "skills.restore" && item.target === restorePayload.path))
    .toBe(true);

  const hiddenAfterRestore = await listSkillRemovals({ dataDir });
  expect(hiddenAfterRestore).toEqual([]);
});

test("user-global skill deletion creates a recoverable removal and restore routes can restore it", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await tempDir("veslo-skill-removal-home-");
  process.env.HOME = homeDir;
  try {
    const { dataDir, server } = await startFixture();
    const userRoot = join(homeDir, ".config", "opencode", "skills");
    const skillDir = join(userRoot, "global-skill");
    await mkdir(join(skillDir, "nested"), { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(skillPath, "---\nname: global-skill\ndescription: Global\n---\n\nGlobal body.\n", "utf8");
    await writeFile(join(skillDir, "nested", "notes.txt"), "global notes\n", "utf8");

    const deleteResponse = await fetch(
      `http://127.0.0.1:${server.port}/skills/user-global/global-skill?path=${encodeURIComponent(skillPath)}&reason=${encodeURIComponent("cleanup")}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer client-token" },
      },
    );

    expect(deleteResponse.status).toBe(200);
    const deletePayload = await deleteResponse.json() as {
      ok: true;
      name: string;
      path: string;
      removalId: string;
      reloadRequired?: boolean;
      trigger?: { type: string; name: string; action: string; path: string; scope?: string };
    };
    expect(deletePayload).toMatchObject({
      ok: true,
      name: "global-skill",
      path: join(userRoot, "global-skill"),
      reloadRequired: true,
      trigger: {
        type: "skill",
        name: "global-skill",
        action: "removed",
        path: join(userRoot, "global-skill"),
        scope: "user-global",
      },
    });
    expect(deletePayload.removalId).toBeString();
    expect(await exists(join(userRoot, "global-skill"))).toBe(false);

    const [record] = await listSkillRemovals({ dataDir, scope: "user-global" });
    expect(record).toMatchObject({
      id: deletePayload.removalId,
      name: "global-skill",
      scope: "user-global",
      rootDir: userRoot,
      originalDir: join(userRoot, "global-skill"),
      originalPath: skillPath,
      reason: "cleanup",
    });

    const restoreResponse = await fetch(
      `http://127.0.0.1:${server.port}/skill-removals/${encodeURIComponent(deletePayload.removalId)}/restore`,
      {
        method: "POST",
        headers: { "x-veslo-host-token": "host-token" },
      },
    );

    expect(restoreResponse.status).toBe(200);
    const restorePayload = await restoreResponse.json() as { ok: true; path: string };
    expect(restorePayload.path).toBe(skillPath);
    expect(await readFile(restorePayload.path, "utf8")).toContain("global-skill");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("user-global skill deletion rejects registry materialized paths", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await tempDir("veslo-skill-removal-home-");
  process.env.HOME = homeDir;
  try {
    const { server } = await startFixture();
    const managedDir = join(homeDir, ".config", "opencode", "skills", "veslo-managed", "managed-skill");
    const managedPath = join(managedDir, "SKILL.md");
    await mkdir(managedDir, { recursive: true });
    await writeFile(managedPath, "---\nname: managed-skill\ndescription: Managed\n---\n", "utf8");

    const response = await fetch(
      `http://127.0.0.1:${server.port}/skills/user-global/managed-skill?path=${encodeURIComponent(managedPath)}`,
      {
        method: "DELETE",
        headers: { "x-veslo-host-token": "host-token" },
      },
    );

    expect(response.status).toBe(409);
    expect(await exists(managedPath)).toBe(true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("GET /skill-removals requires collaborator-or-host access", async () => {
  const { server } = await startFixture();
  const unauthenticated = await fetch(`http://127.0.0.1:${server.port}/skill-removals`);
  expect(unauthenticated.status).toBe(401);

  const tokenResponse = await fetch(`http://127.0.0.1:${server.port}/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify({ scope: "viewer" }),
  });
  const tokenPayload = await tokenResponse.json() as { token: string };
  const viewerResponse = await fetch(`http://127.0.0.1:${server.port}/skill-removals`, {
    headers: { Authorization: `Bearer ${tokenPayload.token}` },
  });
  expect(viewerResponse.status).toBe(403);

  const hostResponse = await fetch(`http://127.0.0.1:${server.port}/skill-removals`, {
    headers: { "x-veslo-host-token": "host-token" },
  });
  expect(hostResponse.status).toBe(200);
});

test("GET /skill-removals filters to visible workspace removals by default and by workspaceId", async () => {
  const workspaceOne = await tempDir("veslo-skill-removal-ws1-");
  const workspaceTwo = await tempDir("veslo-skill-removal-ws2-");
  const hiddenWorkspace = await tempDir("veslo-skill-removal-hidden-");
  const { dataDir, server } = await startFixture({
    workspaces: [
      { id: "ws_1", name: "One", path: workspaceOne, workspaceType: "local" },
      { id: "ws_2", name: "Two", path: workspaceTwo, workspaceType: "local" },
    ],
    authorizedRoots: [workspaceOne, workspaceTwo],
  });
  const records = [
    await removeSkillWithSnapshot({
      dataDir,
      actor: { type: "remote", tokenHash: "should-not-leak", scope: "owner" },
      source: { scope: "workspace", workspaceId: "ws_1", rootDir: workspaceOne, skillPath: await createSkill(workspaceOne, "one-skill") },
    }),
    await removeSkillWithSnapshot({
      dataDir,
      actor: { type: "remote", tokenHash: "should-not-leak", scope: "owner" },
      source: { scope: "workspace", workspaceId: "ws_2", rootDir: workspaceTwo, skillPath: await createSkill(workspaceTwo, "two-skill") },
    }),
    await removeSkillWithSnapshot({
      dataDir,
      actor: { type: "remote", tokenHash: "should-not-leak", scope: "owner" },
      source: { scope: "workspace", workspaceId: "ws_hidden", rootDir: hiddenWorkspace, skillPath: await createSkill(hiddenWorkspace, "hidden-skill") },
    }),
  ];

  const allResponse = await fetch(`http://127.0.0.1:${server.port}/skill-removals`, {
    headers: { Authorization: "Bearer client-token" },
  });
  expect(allResponse.status).toBe(200);
  const allPayload = await allResponse.json() as { items: Array<{ id: string; name: string; workspaceId: string }> };
  expect(allPayload.items.map((item) => item.id).sort()).toEqual([records[0].id, records[1].id].sort());
  expect(allPayload.items.find((item) => item.id === records[2].id)).toBeUndefined();

  const workspaceTwoResponse = await fetch(`http://127.0.0.1:${server.port}/skill-removals?workspaceId=ws_2`, {
    headers: { Authorization: "Bearer client-token" },
  });
  expect(workspaceTwoResponse.status).toBe(200);
  const workspaceTwoPayload = await workspaceTwoResponse.json() as { items: Array<{ id: string; name: string; workspaceId: string }> };
  expect(workspaceTwoPayload.items).toEqual([
    expect.objectContaining({ id: records[1].id, name: "two-skill", workspaceId: "ws_2" }),
  ]);
});

test("recoverable delete supports skills discovered in a parent workspace root", async () => {
  const repoRoot = await tempDir("veslo-skill-removal-repo-");
  await mkdir(join(repoRoot, ".git"), { recursive: true });
  const nestedWorkspace = join(repoRoot, "packages", "app");
  await mkdir(nestedWorkspace, { recursive: true });
  const skillPath = await createSkill(repoRoot, "parent-skill");
  const { server } = await startFixture({
    workspaces: [{ id: "ws_1", name: "Nested", path: nestedWorkspace, workspaceType: "local" }],
    authorizedRoots: [repoRoot],
  });

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_1/skills/parent-skill?path=${encodeURIComponent(skillPath)}`,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer client-token" },
    },
  );
  expect(deleteResponse.status).toBe(200);
  const deletePayload = await deleteResponse.json() as { removalId: string };
  expect(deletePayload.removalId).toBeString();
});

test("user-global restore returns reload metadata for callers without workspace audit", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await tempDir("veslo-skill-removal-home-");
  process.env.HOME = homeDir;
  try {
    const userRoot = join(homeDir, ".config", "opencode", "skills");
    const { dataDir, server } = await startFixture();
    const skillDir = join(userRoot, "global-skill");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(skillPath, "---\nname: global-skill\ndescription: Global\n---\n", "utf8");
    const record = await removeSkillWithSnapshot({
      dataDir,
      actor: { type: "host" },
      source: { scope: "user-global", rootDir: userRoot, skillPath },
      reason: "cleanup",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/skill-removals/${encodeURIComponent(record.id)}/restore`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: true;
      path: string;
      reloadRequired?: boolean;
      trigger?: { type: string; name: string; action: string; path: string; scope?: string };
    };
    expect(payload.path).toBe(skillPath);
    expect(payload.reloadRequired).toBe(true);
    expect(payload.trigger).toEqual({
      type: "skill",
      name: "global-skill",
      action: "added",
      path: payload.path,
      scope: "user-global",
    });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("user-global restore rejects tampered managed materialization paths", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await tempDir("veslo-skill-removal-home-");
  process.env.HOME = homeDir;
  try {
    const userRoot = join(homeDir, ".config", "opencode", "skills");
    const { dataDir, server } = await startFixture();
    const skillDir = join(userRoot, "global-skill");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(skillPath, "---\nname: global-skill\ndescription: Global\n---\n", "utf8");
    const record = await removeSkillWithSnapshot({
      dataDir,
      actor: { type: "host" },
      source: { scope: "user-global", rootDir: userRoot, skillPath },
      reason: "cleanup",
    });
    const managedDir = join(userRoot, "veslo-managed", "global-skill");
    await writeFile(
      join(dataDir, "skill-removals", "records", `${record.id}.json`),
      JSON.stringify({
        ...record,
        rootDir: join(userRoot, "veslo-managed"),
        originalDir: managedDir,
        originalPath: join(managedDir, "SKILL.md"),
      }, null, 2) + "\n",
      "utf8",
    );

    const response = await fetch(`http://127.0.0.1:${server.port}/skill-removals/${encodeURIComponent(record.id)}/restore`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });

    expect(response.status).toBe(409);
    expect(await exists(managedDir)).toBe(false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
