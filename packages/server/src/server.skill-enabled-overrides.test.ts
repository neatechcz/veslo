import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { listDisabledSkills, setSkillEnabledState } from "./skill-enabled-overrides.js";
import { startServer } from "./server.js";

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

const createWorkspaceSkill = async (
  workspaceRoot: string,
  name: string,
  description = `${name} workspace skill`,
): Promise<string> => {
  const skillDir = join(workspaceRoot, ".opencode", "skills", name);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return skillPath;
};

const createGlobalSkill = async (
  homeDir: string,
  name: string,
  description = `${name} global skill`,
): Promise<string> => {
  const skillDir = join(homeDir, ".config", "opencode", "skills", name);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return skillPath;
};

async function startFixture() {
  const dataDir = await tempDir("veslo-skill-enabled-route-data-");
  const workspaceRoot = await tempDir("veslo-skill-enabled-route-workspace-");
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });

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
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  if (previousDataDir === undefined) {
    delete process.env.VESLO_DATA_DIR;
  } else {
    process.env.VESLO_DATA_DIR = previousDataDir;
  }

  return { dataDir, workspaceRoot, server };
}

const clientHeaders = {
  Authorization: "Bearer client-token",
  "x-veslo-client-id": "test-client",
};

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  return await response.json() as Record<string, unknown>;
};

test("GET /skills/disabled returns disabled records", async () => {
  const { dataDir, workspaceRoot, server } = await startFixture();
  const skillPath = await createWorkspaceSkill(workspaceRoot, "disabled-list-skill");
  await setSkillEnabledState({
    dataDir,
    target: {
      name: "disabled-list-skill",
      scope: "workspace",
      workspaceId: "ws_1",
      path: skillPath,
    },
    enabled: false,
    actor: { type: "host" },
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/skills/disabled?workspaceId=ws_1`, {
    headers: clientHeaders,
  });
  const body = await readJson(response);

  expect(response.status).toBe(200);
  expect(body.items).toMatchObject([
    {
      name: "disabled-list-skill",
      scope: "workspace",
      workspaceId: "ws_1",
      path: skillPath,
    },
  ]);
});

test("PATCH /skills/enabled-state disables a workspace skill", async () => {
  const { dataDir, workspaceRoot, server } = await startFixture();
  const skillPath = await createWorkspaceSkill(workspaceRoot, "patch-disabled-skill");

  const response = await fetch(`http://127.0.0.1:${server.port}/skills/enabled-state`, {
    method: "PATCH",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      enabled: false,
      target: {
        name: "patch-disabled-skill",
        scope: "workspace",
        workspaceId: "ws_1",
        path: skillPath,
      },
    }),
  });
  const body = await readJson(response);
  const records = await listDisabledSkills({ dataDir, workspaceId: "ws_1" });

  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    enabled: false,
    record: {
      name: "patch-disabled-skill",
      scope: "workspace",
      workspaceId: "ws_1",
      path: skillPath,
    },
  });
  expect(records).toMatchObject([
    {
      name: "patch-disabled-skill",
      scope: "workspace",
      workspaceId: "ws_1",
      path: skillPath,
    },
  ]);
});

test("GET /workspace/:id/skills excludes disabled skills by default", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await tempDir("veslo-skill-enabled-route-home-");
  process.env.HOME = homeDir;
  try {
    const { dataDir, workspaceRoot, server } = await startFixture();
    await createWorkspaceSkill(workspaceRoot, "enabled-workspace-skill");
    const disabledPath = await createWorkspaceSkill(workspaceRoot, "disabled-workspace-skill");
    await createGlobalSkill(homeDir, "enabled-global-skill");
    const disabledGlobalPath = await createGlobalSkill(homeDir, "disabled-global-skill");
    await setSkillEnabledState({
      dataDir,
      target: {
        name: "disabled-workspace-skill",
        scope: "workspace",
        workspaceId: "ws_1",
        path: disabledPath,
      },
      enabled: false,
      actor: { type: "host" },
    });
    await setSkillEnabledState({
      dataDir,
      target: {
        name: "disabled-global-skill",
        scope: "user-global",
        path: disabledGlobalPath,
      },
      enabled: false,
      actor: { type: "host" },
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills?includeGlobal=true`, {
      headers: clientHeaders,
    });
    const body = await readJson(response);
    const names = ((body.items as Array<{ name: string }>) ?? []).map((item) => item.name);

    expect(response.status).toBe(200);
    expect(names).toContain("enabled-workspace-skill");
    expect(names).toContain("enabled-global-skill");
    expect(names).not.toContain("disabled-workspace-skill");
    expect(names).not.toContain("disabled-global-skill");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("GET /workspace/:id/skills includeDisabled returns disabled skills with enabled false", async () => {
  const { dataDir, workspaceRoot, server } = await startFixture();
  const disabledPath = await createWorkspaceSkill(workspaceRoot, "included-disabled-skill");
  await setSkillEnabledState({
    dataDir,
    target: {
      name: "included-disabled-skill",
      scope: "workspace",
      workspaceId: "ws_1",
      path: disabledPath,
    },
    enabled: false,
    actor: { type: "host" },
  });

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_1/skills?includeGlobal=true&includeDisabled=true`,
    { headers: clientHeaders },
  );
  const body = await readJson(response);
  const item = ((body.items as Array<{ name: string; enabled?: boolean; disabledReason?: string }>) ?? [])
    .find((candidate) => candidate.name === "included-disabled-skill");

  expect(response.status).toBe(200);
  expect(item).toMatchObject({
    name: "included-disabled-skill",
    enabled: false,
    disabledReason: "user",
  });
});

test("POST /workspace/:id/skills/resolve ignores disabled skills", async () => {
  const { dataDir, workspaceRoot, server } = await startFixture();
  const disabledPath = await createWorkspaceSkill(
    workspaceRoot,
    "disabled-resolve-skill",
    "Use for disabled resolver intent",
  );
  await createWorkspaceSkill(workspaceRoot, "enabled-resolve-skill", "Use for enabled resolver intent");
  await setSkillEnabledState({
    dataDir,
    target: {
      name: "disabled-resolve-skill",
      scope: "workspace",
      workspaceId: "ws_1",
      path: disabledPath,
    },
    enabled: false,
    actor: { type: "host" },
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/resolve`, {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: "use disabled-resolve-skill for this",
      includeGlobal: true,
    }),
  });
  const body = await readJson(response) as {
    match?: { name: string } | null;
    candidates?: Array<{ name: string }>;
  };

  expect(response.status).toBe(200);
  expect(body.match?.name).not.toBe("disabled-resolve-skill");
  expect((body.candidates ?? []).some((candidate) => candidate.name === "disabled-resolve-skill")).toBe(false);
});
