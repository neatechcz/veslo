import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { SkillPackageFile } from "./skill-package-model.js";
import { buildSkillPackageManifest } from "./skill-package-model.js";
import type { SkillPackageArchive } from "./skill-packages.js";
import { startServer } from "./server.js";
import type { WorkspaceSkillLockfile } from "./workspace-skill-lockfile.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];

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

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

const archiveFile = (path: string, content: string): SkillPackageFile & { contentBase64: string } => {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: path.endsWith(".md") ? "text/markdown" : "text/plain",
    text: content,
    contentBase64: bytes.toString("base64"),
  };
};

const archive = async (name: string): Promise<SkillPackageArchive> => {
  const files = [
    archiveFile("SKILL.md", `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`),
    archiveFile("scripts/run.txt", "run\n"),
  ];
  return {
    ...(await buildSkillPackageManifest({ metadata: { name }, files })),
    files,
  };
};

async function startFixture(input: { registryBaseUrl?: string } = {}) {
  const workspaceRoot = await tempDir("veslo-skill-materialization-route-");
  const dataDir = await tempDir("veslo-skill-materialization-data-");

  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
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
    denApiBase: input.registryBaseUrl,
    skillRegistryBaseUrl: input.registryBaseUrl,
    skillRegistryToken: "registry-token",
  });

  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  return { server, workspaceRoot, dataDir };
}

test("GET /workspace/:id/skills/materialization returns local status without registry access", async () => {
  const { server } = await startFixture();

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization`, {
    headers: { Authorization: "Bearer client-token" },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    workspaceId: string;
    status: string;
    materializedSkills: unknown[];
    registryConfigured: boolean;
  };
  expect(payload.workspaceId).toBe("ws_1");
  expect(payload.status).toBe("not-configured");
  expect(payload.materializedSkills).toEqual([]);
  expect(payload.registryConfigured).toBe(false);
});

test("GET /skills/materialization returns personal global materialization status", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-global-status-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const { server } = await startFixture();

    const response = await fetch(`http://127.0.0.1:${server.port}/skills/materialization`, {
      headers: { Authorization: "Bearer client-token" },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      scope: string;
      status: string;
      materializedSkills: unknown[];
      registryConfigured: boolean;
    };
    expect(payload.scope).toBe("personal-global");
    expect(payload.status).toBe("not-configured");
    expect(payload.materializedSkills).toEqual([]);
    expect(payload.registryConfigured).toBe(false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
  }
});

test("POST /workspace/:id/skills/materialization/sync requires host auth", async () => {
  const { server } = await startFixture({ registryBaseUrl: "http://127.0.0.1:9" });

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization/sync`, {
    method: "POST",
    headers: { Authorization: "Bearer client-token" },
  });

  expect(response.status).toBe(401);
});

test("POST /skills/materialization/sync-global downloads personal global packages", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-global-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const pkg = await archive("global-tool");
    const registryCalls: Array<{ pathname: string; search: string; auth: string | null }> = [];
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        registryCalls.push({
          pathname: url.pathname,
          search: url.search,
          auth: request.headers.get("authorization"),
        });
        if (url.pathname === "/v1/skill-installations") {
          return Response.json({
            installations: [
              {
                installationId: "install_global",
                skillId: "skill_global",
                versionId: "version_global",
                enabled: true,
                source: "personal",
                installedAt: "2026-05-26T12:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/skill-versions/version_global/package") {
          return Response.json({
            versionId: "version_global",
            skillId: "skill_global",
            package: pkg,
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
    const { server } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

    const response = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      scope: string;
      status: string;
      synced: boolean;
      materializedSkills: Array<{ name: string; packageSha256: string }>;
    };
    expect(payload.scope).toBe("personal-global");
    expect(payload.status).toBe("synced");
    expect(payload.synced).toBe(true);
    expect(payload.materializedSkills).toEqual([{ name: "global-tool", packageSha256: pkg.packageSha256 }]);
    expect(
      await readFile(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "global-tool", "SKILL.md"), "utf8"),
    ).toContain("# global-tool");
    expect(registryCalls).toEqual([
      {
        pathname: "/v1/skill-installations",
        search: "?source=personal&target=personal-global",
        auth: "Bearer registry-token",
      },
      {
        pathname: "/v1/skill-versions/version_global/package",
        search: "",
        auth: "Bearer registry-token",
      },
    ]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
  }
});

test("POST /workspace/:id/skills/materialization/sync downloads desired packages and writes managed runtime files", async () => {
  const pkg = await archive("registry-tool");
  const registryCalls: Array<{ pathname: string; auth: string | null; org: string | null; user: string | null }> = [];
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      registryCalls.push({
        pathname: url.pathname,
        auth: request.headers.get("authorization"),
        org: request.headers.get("x-veslo-den-org-id"),
        user: request.headers.get("x-veslo-den-user-id"),
      });
      if (url.pathname === "/v1/workspaces/ws_1/skill-set") {
        return Response.json({
          workspaceId: "ws_1",
          skills: [
            {
              installationId: "install_1",
              skillId: "skill_1",
              versionId: "version_1",
              enabled: true,
              source: "workspace",
              installedAt: "2026-05-26T12:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/v1/skill-versions/version_1/package") {
        return Response.json({
          versionId: "version_1",
          skillId: "skill_1",
          package: pkg,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const { server, workspaceRoot } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization/sync`, {
    method: "POST",
    headers: {
      "x-veslo-host-token": "host-token",
      "x-veslo-den-org-id": "org_1",
      "x-veslo-den-user-id": "user_1",
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    status: string;
    synced: boolean;
    materializedSkills: Array<{ name: string; packageSha256: string }>;
  };
  expect(payload.status).toBe("synced");
  expect(payload.synced).toBe(true);
  expect(payload.materializedSkills).toEqual([{ name: "registry-tool", packageSha256: pkg.packageSha256 }]);
  expect(await readFile(join(workspaceRoot, ".opencode", "skills", "veslo-managed", "registry-tool", "SKILL.md"), "utf8"))
    .toContain("# registry-tool");
  expect(registryCalls).toEqual([
    {
      pathname: "/v1/workspaces/ws_1/skill-set",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
    },
    {
      pathname: "/v1/skill-versions/version_1/package",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
    },
  ]);
});

test("GET workspace materialization status stays pending when registry is configured and only a local manifest exists", async () => {
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => Response.json({ workspaceId: "ws_1", skills: [] }),
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const { server, workspaceRoot } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });
  const rootDir = join(workspaceRoot, ".opencode", "skills", "veslo-managed");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, ".veslo-materialization.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-05-27T00:00:00.000Z",
      entries: [],
    }),
    "utf8",
  );

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization`, {
    headers: { Authorization: "Bearer client-token" },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { status: string; registryConfigured: boolean };
  expect(payload.registryConfigured).toBe(true);
  expect(payload.status).toBe("pending");
});

test("POST workspace materialization sync resolves org skill sets, writes lockfile, and blocks personal global shadows", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-org-materialization-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const orgPkg = await archive("shared-tool");
    const personalPkg = await archive("shared-tool");
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/workspaces/ws_1/skill-set") {
          return Response.json({
            workspaceId: "ws_1",
            skillSetId: "skill_set_org_1",
            revision: "rev_org_1",
            skills: [
              {
                installationId: "install_personal_shadow",
                skillId: "skill_shared_personal",
                versionId: "version_personal",
                enabled: true,
                source: "personal",
                installedAt: "2026-05-26T12:00:00.000Z",
                ownerUserId: "user_1",
              },
              {
                installationId: "install_org_shared",
                skillId: "skill_shared_org",
                versionId: "version_org",
                enabled: true,
                source: "organization",
                installedAt: "2026-05-26T12:00:00.000Z",
                orgId: "org_1",
                approved: true,
              },
            ],
          });
        }
        if (url.pathname === "/v1/skill-versions/version_org/package") {
          return Response.json({ versionId: "version_org", skillId: "skill_shared_org", package: orgPkg });
        }
        if (url.pathname === "/v1/skill-versions/version_personal/package") {
          return Response.json({ versionId: "version_personal", skillId: "skill_shared_personal", package: personalPkg });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
    const { server, workspaceRoot } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization/sync`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "x-veslo-den-org-id": "org_1",
        "x-veslo-den-user-id": "user_1",
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      materializedSkills: Array<{ name: string; packageSha256: string }>;
      lockfilePath?: string;
    };
    expect(payload.materializedSkills).toEqual([{ name: "shared-tool", packageSha256: orgPkg.packageSha256 }]);
    expect(payload.lockfilePath).toBe(join(workspaceRoot, ".opencode", "veslo.skills.lock.json"));
    expect(await readFile(join(workspaceRoot, ".opencode", "skills", "veslo-managed", "shared-tool", "SKILL.md"), "utf8"))
      .toContain("# shared-tool");
    await expect(stat(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "shared-tool"))).rejects.toThrow();

    const lockfile = JSON.parse(
      await readFile(join(workspaceRoot, ".opencode", "veslo.skills.lock.json"), "utf8"),
    ) as WorkspaceSkillLockfile;
    expect(lockfile.skillSetId).toBe("skill_set_org_1");
    expect(lockfile.skillSetRevision).toBe("rev_org_1");
    expect(lockfile.entries).toEqual([
      {
        skillId: "skill_shared_org",
        installationId: "install_org_shared",
        versionId: "version_org",
        name: "shared-tool",
        packageSha256: orgPkg.packageSha256,
      },
    ]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
  }
});

test("POST skill upsert with an instance path updates that exact skill file instead of creating a name-only copy", async () => {
  const { server, workspaceRoot } = await startFixture();
  const directSkillDir = join(workspaceRoot, ".opencode", "skills", "nested-tool");
  const nestedSkillDir = join(workspaceRoot, ".opencode", "skills", "category", "nested-tool");
  const directSkillPath = join(directSkillDir, "SKILL.md");
  const nestedSkillPath = join(nestedSkillDir, "SKILL.md");
  await mkdir(directSkillDir, { recursive: true });
  await mkdir(nestedSkillDir, { recursive: true });
  await writeFile(directSkillPath, "---\nname: nested-tool\ndescription: direct\n---\n\n# Direct\n", "utf8");
  await writeFile(nestedSkillPath, "---\nname: nested-tool\ndescription: old\n---\n\n# Old\n", "utf8");

  const readResponse = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_1/skills/nested-tool?path=${encodeURIComponent(nestedSkillPath)}`,
    {
      headers: { Authorization: "Bearer client-token" },
    },
  );
  expect(readResponse.status).toBe(200);
  const readPayload = await readResponse.json() as { item: { path: string }; content: string };
  expect(readPayload.item.path).toBe(nestedSkillPath);
  expect(readPayload.content).toContain("# Old");

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills`, {
    method: "POST",
    headers: {
      Authorization: "Bearer client-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "nested-tool",
      path: nestedSkillPath,
      content: "---\nname: nested-tool\ndescription: new\n---\n\n# New\n",
      description: "new",
    }),
  });

  expect(response.status).toBe(200);
  expect(await readFile(nestedSkillPath, "utf8")).toContain("# New");
  expect(await readFile(directSkillPath, "utf8")).toContain("# Direct");

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_1/skills/nested-tool?path=${encodeURIComponent(nestedSkillPath)}`,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer client-token" },
    },
  );
  expect(deleteResponse.status).toBe(200);
  await expect(stat(nestedSkillPath)).rejects.toThrow();
  expect(await readFile(directSkillPath, "utf8")).toContain("# Direct");
});

test("exact skill reads allow managed materialized instances but exact deletes reject them", async () => {
  const { server, workspaceRoot } = await startFixture();
  const managedSkillDir = join(workspaceRoot, ".opencode", "skills", "veslo-managed", "managed-tool");
  const managedSkillPath = join(managedSkillDir, "SKILL.md");
  await mkdir(managedSkillDir, { recursive: true });
  await writeFile(managedSkillPath, "---\nname: managed-tool\ndescription: managed\n---\n\n# Managed\n", "utf8");

  const readResponse = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_1/skills/managed-tool?path=${encodeURIComponent(managedSkillPath)}`,
    {
      headers: { Authorization: "Bearer client-token" },
    },
  );
  expect(readResponse.status).toBe(200);
  const readPayload = await readResponse.json() as { item: { path: string }; content: string };
  expect(readPayload.item.path).toBe(managedSkillPath);
  expect(readPayload.content).toContain("# Managed");

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_1/skills/managed-tool?path=${encodeURIComponent(managedSkillPath)}`,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer client-token" },
    },
  );
  expect(deleteResponse.status).toBe(409);
  expect(await readFile(managedSkillPath, "utf8")).toContain("# Managed");
});

test("POST sync marks active runs pending without mutating managed files", async () => {
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => Response.json({ workspaceId: "ws_1", skills: [] }),
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const { server, workspaceRoot } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });
  await mkdir(join(workspaceRoot, ".opencode", "skills"), { recursive: true });

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization/sync`, {
    method: "POST",
    headers: {
      "x-veslo-host-token": "host-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ activeRun: true }),
  });

  expect(response.status).toBe(202);
  const payload = await response.json() as { status: string; reloadRequired: boolean; synced: boolean };
  expect(payload).toMatchObject({ status: "pending", reloadRequired: true, synced: false });
  await expect(readFile(join(workspaceRoot, ".opencode", "skills", "veslo-managed", ".veslo-materialization.json"), "utf8"))
    .rejects.toThrow();
});
