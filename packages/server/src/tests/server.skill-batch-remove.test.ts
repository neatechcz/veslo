import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { startServer } from "../server.js";

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

const createWorkspaceSkill = async (rootDir: string, name: string): Promise<string> => {
  const skillDir = join(rootDir, ".opencode", "skills", name);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, `---\nname: ${name}\ndescription: Demo\n---\n\n${name}\n`, "utf8");
  return skillPath;
};

const createUserSkill = async (homeDir: string, name: string): Promise<string> => {
  const skillDir = join(homeDir, ".config", "opencode", "skills", name);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, `---\nname: ${name}\ndescription: User Demo\n---\n\n${name}\n`, "utf8");
  return skillPath;
};

async function startFixture(registryBaseUrl?: string) {
  const dataDir = await tempDir("veslo-skill-batch-remove-data-");
  const workspaceRoot = await tempDir("veslo-skill-batch-remove-workspace-");
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
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: workspaceRoot,
        workspaceType: "local",
      },
    ],
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
    denApiBase: registryBaseUrl,
    skillRegistryBaseUrl: registryBaseUrl,
    skillRegistryToken: "registry-token",
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  if (previousDataDir === undefined) {
    delete process.env.VESLO_DATA_DIR;
  } else {
    process.env.VESLO_DATA_DIR = previousDataDir;
  }
  return { dataDir, workspaceRoot, server };
}

test("POST /skills/batch-remove removes local skills and reports per-item failures", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await tempDir("veslo-skill-batch-remove-home-");
  process.env.HOME = homeDir;
  try {
    const { workspaceRoot, server } = await startFixture();
    const workspaceSkillPath = await createWorkspaceSkill(workspaceRoot, "workspace-skill");
    const userSkillPath = await createUserSkill(homeDir, "user-skill");
    const missingSkillPath = join(workspaceRoot, ".opencode", "skills", "missing-skill", "SKILL.md");

    const response = await fetch(`http://127.0.0.1:${server.port}/skills/batch-remove`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-host-token": "host-token",
      },
      body: JSON.stringify({
        items: [
          {
            id: "workspace",
            scope: "workspace",
            workspaceId: "ws_1",
            name: "workspace-skill",
            path: workspaceSkillPath,
            reason: "bulk cleanup",
          },
          {
            id: "missing",
            scope: "workspace",
            workspaceId: "ws_1",
            name: "missing-skill",
            path: missingSkillPath,
            reason: "bulk cleanup",
          },
          {
            id: "user",
            scope: "user-global",
            name: "user-skill",
            path: userSkillPath,
            reason: "bulk cleanup",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      succeeded: number;
      failed: number;
      results: Array<{
        id?: string;
        index: number;
        ok: boolean;
        name?: string;
        path?: string;
        removalId?: string;
        code?: string;
        message?: string;
        trigger?: { type: string; name: string; action: string; path: string; scope?: string };
      }>;
    };

    expect(payload.ok).toBe(false);
    expect(payload.succeeded).toBe(2);
    expect(payload.failed).toBe(1);
    expect(payload.results[0]).toMatchObject({
      id: "workspace",
      index: 0,
      ok: true,
      name: "workspace-skill",
      path: join(workspaceRoot, ".opencode", "skills", "workspace-skill"),
      trigger: {
        type: "skill",
        name: "workspace-skill",
        action: "removed",
        path: join(workspaceRoot, ".opencode", "skills", "workspace-skill"),
        scope: "workspace",
      },
    });
    expect(payload.results[0]?.removalId).toBeString();
    expect(payload.results[1]).toMatchObject({
      id: "missing",
      index: 1,
      ok: false,
      code: "skill_not_found",
    });
    expect(payload.results[2]).toMatchObject({
      id: "user",
      index: 2,
      ok: true,
      name: "user-skill",
      path: join(homeDir, ".config", "opencode", "skills", "user-skill"),
      trigger: {
        type: "skill",
        name: "user-skill",
        action: "removed",
        path: join(homeDir, ".config", "opencode", "skills", "user-skill"),
        scope: "user-global",
      },
    });
    expect(payload.results[2]?.removalId).toBeString();
    expect(await exists(join(workspaceRoot, ".opencode", "skills", "workspace-skill"))).toBe(false);
    expect(await exists(join(homeDir, ".config", "opencode", "skills", "user-skill"))).toBe(false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("POST /skills/batch-remove deletes registry installations and disables rollout policies", async () => {
  const registryCalls: Array<{
    method: string;
    url: string;
    auth: string | null;
    org: string | null;
    user: string | null;
    body: unknown;
  }> = [];
  const policy = {
    id: "policy_1",
    skillId: "skill_org",
    versionId: "version_1",
    target: "workspace",
    audience: "selected-workspaces",
    catalogScope: "organization",
    orgId: "org_1",
    workspaceId: "ws_1",
    enabled: true,
    updatePolicy: "release_channel",
    releaseChannel: "stable",
    removalPolicy: "admin_removable",
    createdAt: "2026-05-26T10:00:00.000Z",
  };
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "DELETE"
        ? null
        : await request.json().catch(() => null);
      registryCalls.push({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        auth: request.headers.get("authorization"),
        org: request.headers.get("x-veslo-den-org-id"),
        user: request.headers.get("x-veslo-den-user-id"),
        body,
      });
      if (request.method === "DELETE" && url.pathname === "/v1/skill-installations/installation_1") {
        return Response.json({
          installation: {
            installationId: "installation_1",
            skillId: "skill_demo",
            versionId: "version_1",
            enabled: false,
            source: "workspace",
            installedAt: "2026-05-26T10:03:00.000Z",
          },
        });
      }
      if (request.method === "PATCH" && url.pathname === "/v1/skill-rollout-policies/policy_1") {
        return Response.json({ policy: { ...policy, enabled: false } });
      }
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const { server } = await startFixture(`http://127.0.0.1:${registry.port}`);

  const response = await fetch(`http://127.0.0.1:${server.port}/skills/batch-remove`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-veslo-host-token": "host-token",
      "x-veslo-den-token": "den-token",
      "x-veslo-den-org-id": "org_1",
      "x-veslo-den-user-id": "user_1",
    },
    body: JSON.stringify({
      items: [
        {
          id: "installation",
          scope: "workspace",
          name: "managed-install",
          registry: { installationId: "installation_1" },
        },
        {
          id: "policy",
          scope: "organization",
          name: "managed-policy",
          registry: { policyId: "policy_1" },
        },
      ],
    }),
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    ok: boolean;
    succeeded: number;
    failed: number;
    results: Array<{ id?: string; ok: boolean; registry?: { installationId?: string; policyId?: string } }>;
  };
  expect(payload).toMatchObject({
    ok: true,
    succeeded: 2,
    failed: 0,
    results: [
      { id: "installation", ok: true, registry: { installationId: "installation_1" } },
      { id: "policy", ok: true, registry: { policyId: "policy_1" } },
    ],
  });
  expect(registryCalls).toEqual([
    {
      method: "DELETE",
      url: "/v1/skill-installations/installation_1",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: null,
    },
    {
      method: "PATCH",
      url: "/v1/skill-rollout-policies/policy_1",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: { enabled: false },
    },
  ]);
});
