import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { SkillPackageFile } from "../skill-package-model.js";
import { buildSkillPackageManifest } from "../skill-package-model.js";
import type { SkillPackageArchive } from "../skill-packages.js";
import {
  VESLO_AUTOMATIONS_PLATFORM_SKILL,
  getPlatformManagedPersonalGlobalSkillSet,
} from "../platform-managed-skills.js";
import { startServer } from "../server.js";
import type { WorkspaceSkillLockfile } from "../workspace-skill-lockfile.js";

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

type MaterializedSkillPayload = {
  installationId: string;
  skillId: string;
  name: string;
  versionId: string;
  packageSha256: string;
  source: string;
  removalPolicy: string;
  target: string;
};

async function startFixture(input: { registryBaseUrl?: string } = {}) {
  const workspaceRoot = await tempDir("veslo-skill-materialization-route-");
  const dataDir = await tempDir("veslo-skill-materialization-data-");
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });

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
      reloadRequired: boolean;
      platformManaged?: {
        synced: boolean;
        desiredSkills: Array<{ name: string; source: string; removalPolicy: string }>;
      };
    };
    expect(payload.scope).toBe("personal-global");
    expect(payload.status).toBe("pending");
    expect(payload.materializedSkills).toEqual([]);
    expect(payload.registryConfigured).toBe(false);
    expect(payload.reloadRequired).toBe(true);
    expect(payload.platformManaged).toMatchObject({
      synced: false,
      desiredSkills: [
        {
          name: "veslo-automations",
          source: "platform",
          removalPolicy: "locked",
        },
      ],
    });
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

test("POST /skills/materialization/sync-global materializes platform automations skill without registry", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-platform-global-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
    const platformSkill = platformSkillSet.skills[0];
    const { server } = await startFixture();

    const response = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      scope: string;
      status: string;
      synced: boolean;
      registryConfigured: boolean;
      materializedSkills: Array<{
        installationId: string;
        skillId: string;
        name: string;
        versionId: string;
        packageSha256: string;
        target: string;
        source: string;
        removalPolicy: string;
      }>;
      backupDirs: string[];
    };
    expect(payload).toMatchObject({
      scope: "personal-global",
      status: "synced",
      synced: true,
      registryConfigured: false,
    });
    expect(payload.materializedSkills).toEqual([{
      installationId: platformSkill.installationId,
      skillId: platformSkill.skillId,
      name: "veslo-automations",
      versionId: platformSkill.versionId,
      packageSha256: platformSkill.packageSha256,
      target: "personal-global",
      source: "platform",
      removalPolicy: "locked",
    }]);
    expect(payload.backupDirs).toEqual([]);
    const skillPath = join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations", "SKILL.md");
    const skillMarkdown = await readFile(skillPath, "utf8");
    expect(skillMarkdown).toContain("Veslo Automations Disabled");
    expect(skillMarkdown).not.toContain("veslo_create_automation");
    expect(skillMarkdown).not.toContain("nextRunAt");

    const readResponse = await fetch(
      `http://127.0.0.1:${server.port}/skills/user-global/veslo-automations?path=${encodeURIComponent(skillPath)}`,
      {
        headers: { Authorization: "Bearer client-token" },
      },
    );
    expect(readResponse.status).toBe(200);
    const readPayload = await readResponse.json() as { item: { scope: string; path: string }; content: string };
    expect(readPayload.item).toMatchObject({
      scope: "global",
      path: skillPath,
    });
    expect(readPayload.content).toContain("Veslo Automations Disabled");

    const secondResponse = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });
    expect(secondResponse.status).toBe(200);
    const secondPayload = await secondResponse.json() as { backupDirs: string[] };
    expect(secondPayload.backupDirs).toEqual([]);
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

test("POST /skills/materialization/sync-global rejects unmanaged user-global veslo-automations conflict", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-platform-conflict-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const unmanagedDir = join(homeRoot, ".config", "opencode", "skills", "veslo-automations");
    await mkdir(unmanagedDir, { recursive: true });
    await writeFile(
      join(unmanagedDir, "SKILL.md"),
      "---\nname: veslo-automations\ndescription: user version\n---\n\n# User version\n",
      "utf8",
    );
    const { server } = await startFixture();

    const response = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });

    expect(response.status).toBe(409);
    const payload = await response.json() as { code: string; message: string; details?: unknown };
    expect(payload.code).toBe("managed_skill_name_conflict");
    expect(payload.message).toContain("veslo-automations");
    expect(payload.message).toContain("unmanaged");
    await expect(stat(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations")))
      .rejects.toThrow();
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

test("POST /skills/materialization/sync-global rejects unmanaged skill inside target managed root", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-platform-managed-root-conflict-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const unmanagedDir = join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations");
    await mkdir(unmanagedDir, { recursive: true });
    await writeFile(
      join(unmanagedDir, "SKILL.md"),
      "---\nname: veslo-automations\ndescription: unmanaged in managed root\n---\n\n# User version\n",
      "utf8",
    );
    const { server } = await startFixture();

    const response = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });

    expect(response.status).toBe(409);
    const payload = await response.json() as { code: string; message: string; details?: { conflicts?: Array<{ path: string }> } };
    expect(payload.code).toBe("managed_skill_name_conflict");
    expect(payload.message).toContain("veslo-automations");
    expect(payload.details?.conflicts?.[0]?.path).toBe(join(unmanagedDir, "SKILL.md"));
    expect(await readFile(join(unmanagedDir, "SKILL.md"), "utf8")).toContain("# User version");
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

test("POST /skills/materialization/sync-global rejects unmanaged global skill in non-target veslo-managed domain", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-platform-other-root-conflict-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const unmanagedDir = join(homeRoot, ".claude", "skills", "veslo-managed", "veslo-automations");
    await mkdir(unmanagedDir, { recursive: true });
    await writeFile(
      join(unmanagedDir, "SKILL.md"),
      "---\nname: veslo-automations\ndescription: unmanaged in another root\n---\n\n# Other root\n",
      "utf8",
    );
    const { server } = await startFixture();

    const response = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });

    expect(response.status).toBe(409);
    const payload = await response.json() as { code: string; details?: { conflicts?: Array<{ path: string }> } };
    expect(payload.code).toBe("managed_skill_name_conflict");
    expect(payload.details?.conflicts?.[0]?.path).toBe(join(unmanagedDir, "SKILL.md"));
    await expect(stat(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations")))
      .rejects.toThrow();
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

test("exact delete and batch remove reject materialized platform automations skill", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-platform-delete-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const { server } = await startFixture();
    const syncResponse = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });
    expect(syncResponse.status).toBe(200);

    const skillPath = join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations", "SKILL.md");
    const deleteResponse = await fetch(
      `http://127.0.0.1:${server.port}/skills/user-global/veslo-automations?path=${encodeURIComponent(skillPath)}`,
      {
        method: "DELETE",
        headers: { "x-veslo-host-token": "host-token" },
      },
    );

    expect(deleteResponse.status).toBe(409);
    const payload = await deleteResponse.json() as { code: string };
    expect(payload.code).toBe("managed_skill_read_only");
    expect(await readFile(skillPath, "utf8")).toContain("Veslo Automations Disabled");

    const batchResponse = await fetch(`http://127.0.0.1:${server.port}/skills/batch-remove`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-host-token": "host-token",
      },
      body: JSON.stringify({
        items: [
          {
            name: "veslo-automations",
            scope: "user-global",
            path: skillPath,
          },
        ],
      }),
    });
    expect(batchResponse.status).toBe(200);
    const batchPayload = await batchResponse.json() as {
      ok: boolean;
      results: Array<{
        ok: boolean;
        index: number;
        name?: string;
        scope?: string;
        code: string;
        message: string;
        status: number;
      }>;
    };
    expect(batchPayload.ok).toBe(false);
    expect(batchPayload.results).toEqual([
      {
        ok: false,
        index: 0,
        name: "veslo-automations",
        scope: "user-global",
        code: "managed_skill_read_only",
        message: "Managed materialized skills must be edited through the registry",
        status: 409,
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

test("exact user-global read and delete handle XDG_CONFIG_HOME managed skills", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-platform-xdg-home-");
  const xdgRoot = await tempDir("veslo-platform-xdg-config-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = xdgRoot;

  try {
    const { server } = await startFixture();
    const syncResponse = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });
    expect(syncResponse.status).toBe(200);

    const skillPath = join(xdgRoot, "opencode", "skills", "veslo-managed", "veslo-automations", "SKILL.md");
    const readResponse = await fetch(
      `http://127.0.0.1:${server.port}/skills/user-global/veslo-automations?path=${encodeURIComponent(skillPath)}`,
      {
        headers: { Authorization: "Bearer client-token" },
      },
    );

    expect(readResponse.status).toBe(200);
    const readPayload = await readResponse.json() as { item: { path: string }; content: string };
    expect(readPayload.item.path).toBe(skillPath);
    expect(readPayload.content).toContain("Veslo Automations Disabled");

    const deleteResponse = await fetch(
      `http://127.0.0.1:${server.port}/skills/user-global/veslo-automations?path=${encodeURIComponent(skillPath)}`,
      {
        method: "DELETE",
        headers: { "x-veslo-host-token": "host-token" },
      },
    );
    expect(deleteResponse.status).toBe(409);
    const deletePayload = await deleteResponse.json() as { code: string };
    expect(deletePayload.code).toBe("managed_skill_read_only");
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

test("POST workspace materialization sync rejects platform name conflicts before workspace writes", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-workspace-platform-conflict-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const workspacePkg = await archive("registry-tool");
    const conflictingGlobalPkg = await archive("veslo-automations");
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/workspaces/ws_1/skill-set") {
          return Response.json({
            workspaceId: "ws_1",
            skills: [
              {
                installationId: "install_workspace",
                skillId: "skill_workspace",
                versionId: "version_workspace",
                enabled: true,
                source: "workspace",
                installedAt: "2026-05-26T12:00:00.000Z",
              },
            ],
          });
        }
        if (url.pathname === "/v1/skill-installations") {
          return Response.json({
            installations: [
              {
                installationId: "install_conflicting_global",
                skillId: "skill_conflicting_global",
                versionId: "version_conflicting_global",
                enabled: true,
                source: "personal",
                installedAt: "2026-05-26T12:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/skill-rollout-policies") {
          return Response.json({ policies: [], nextCursor: null });
        }
        if (url.pathname === "/v1/skill-versions/version_workspace/package") {
          return Response.json({ versionId: "version_workspace", skillId: "skill_workspace", package: workspacePkg });
        }
        if (url.pathname === "/v1/skill-versions/version_conflicting_global/package") {
          return Response.json({
            versionId: "version_conflicting_global",
            skillId: "skill_conflicting_global",
            package: conflictingGlobalPkg,
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
        "x-veslo-den-user-id": "user_1",
      },
    });

    expect(response.status).toBe(409);
    const payload = await response.json() as { code: string; message: string };
    expect(payload.code).toBe("managed_skill_name_conflict");
    expect(payload.message).toContain("veslo-automations");
    await expect(stat(join(workspaceRoot, ".opencode", "skills", "veslo-managed", "registry-tool")))
      .rejects.toThrow();
    await expect(stat(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations")))
      .rejects.toThrow();
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

test("POST /skills/materialization/sync-global downloads personal global packages", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-global-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
    const platformSkill = platformSkillSet.skills[0];
    const pkg = await archive("global-tool");
    const rolloutPkg = await archive("global-rollout-tool");
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
        if (url.pathname === "/v1/skill-rollout-policies") {
          return Response.json({
            policies: [
              {
                id: "rollout_global",
                skillId: "skill_global_rollout",
                versionId: "version_global_rollout",
                target: "user-global",
                audience: "all-platform-users",
                catalogScope: "platform",
                enabled: true,
                updatePolicy: "pinned",
                removalPolicy: "locked",
                createdAt: "2026-05-30T10:00:00.000Z",
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
        if (url.pathname === "/v1/skill-versions/version_global_rollout/package") {
          return Response.json({
            versionId: "version_global_rollout",
            skillId: "skill_global_rollout",
            package: rolloutPkg,
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
      materializedSkills: MaterializedSkillPayload[];
    };
    expect(payload.scope).toBe("personal-global");
    expect(payload.status).toBe("synced");
    expect(payload.synced).toBe(true);
    expect(payload.materializedSkills).toEqual([{
      installationId: "install_global",
      skillId: "skill_global",
      name: "global-tool",
      versionId: "version_global",
      packageSha256: pkg.packageSha256,
      source: "personal",
      target: "personal-global",
      removalPolicy: "user_removable",
    }, {
      installationId: "rollout:rollout_global",
      skillId: "skill_global_rollout",
      name: "global-rollout-tool",
      versionId: "version_global_rollout",
      packageSha256: rolloutPkg.packageSha256,
      source: "platform",
      removalPolicy: "locked",
      target: "personal-global",
    }, {
      installationId: platformSkill.installationId,
      skillId: platformSkill.skillId,
      name: VESLO_AUTOMATIONS_PLATFORM_SKILL.name,
      versionId: platformSkill.versionId,
      packageSha256: platformSkill.packageSha256,
      source: "platform",
      removalPolicy: "locked",
      target: "personal-global",
    }]);
    expect(
      await readFile(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "global-tool", "SKILL.md"), "utf8"),
    ).toContain("# global-tool");
    expect(
      await readFile(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations", "SKILL.md"), "utf8"),
    ).toContain("Veslo Automations Disabled");
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
      {
        pathname: "/v1/skill-rollout-policies",
        search: "?target=user-global&enabled=true",
        auth: "Bearer registry-token",
      },
      {
        pathname: "/v1/skill-versions/version_global_rollout/package",
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

test("POST /skills/materialization/sync-global materializes core platform rollout skills without internal delegation artifacts", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-core-platform-global-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const docxPkg = await archive("veslo-docx");
    const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
    const platformSkill = platformSkillSet.skills[0];
    const registryCalls: Array<{ pathname: string; search: string }> = [];
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        registryCalls.push({ pathname: url.pathname, search: url.search });
        if (url.pathname === "/v1/skill-installations") {
          return Response.json({ installations: [], nextCursor: null });
        }
        if (url.pathname === "/v1/skill-rollout-policies") {
          return Response.json({
            policies: [
              {
                id: "rollout_core_platform_docx",
                skillId: "skill_core_platform_docx",
                versionId: "version_core_platform_docx_1",
                target: "user-global",
                audience: "all-platform-users",
                catalogScope: "platform",
                enabled: true,
                updatePolicy: "pinned",
                removalPolicy: "locked",
                createdAt: "2026-06-06T10:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/skill-versions/version_core_platform_docx_1/package") {
          return Response.json({
            versionId: "version_core_platform_docx_1",
            skillId: "skill_core_platform_docx",
            package: docxPkg,
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
    const { server, workspaceRoot } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

    const response = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "x-veslo-den-user-id": "user_1",
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      scope: string;
      synced: boolean;
      materializedSkills: Array<{
        installationId: string;
        skillId: string;
        name: string;
        versionId: string;
        packageSha256: string;
        source: string;
        target: string;
        removalPolicy: string;
      }>;
    };
    expect(payload.scope).toBe("personal-global");
    expect(payload.synced).toBe(true);
    expect(payload.materializedSkills).toEqual([
      {
        installationId: "rollout:rollout_core_platform_docx",
        skillId: "skill_core_platform_docx",
        name: "veslo-docx",
        versionId: "version_core_platform_docx_1",
        packageSha256: docxPkg.packageSha256,
        source: "platform",
        target: "personal-global",
        removalPolicy: "locked",
      },
      {
        installationId: platformSkill.installationId,
        skillId: platformSkill.skillId,
        name: VESLO_AUTOMATIONS_PLATFORM_SKILL.name,
        versionId: platformSkill.versionId,
        packageSha256: platformSkill.packageSha256,
        source: "platform",
        target: "personal-global",
        removalPolicy: "locked",
      },
    ]);

    const managedSkillDir = join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-docx");
    expect(await readFile(join(managedSkillDir, "SKILL.md"), "utf8")).toContain("# veslo-docx");
    const marker = JSON.parse(await readFile(join(managedSkillDir, ".veslo-managed.json"), "utf8")) as {
      installationId?: string;
      target?: string;
      skillDir?: string;
    };
    expect(marker.installationId).toBe("rollout:rollout_core_platform_docx");
    expect(marker.target).toBe("personal-global");
    expect(marker.skillDir).toBe(managedSkillDir);

    await expect(stat(join(workspaceRoot, ".opencode", "veslo", "internal"))).rejects.toThrow();
    await expect(stat(join(workspaceRoot, ".opencode", "plugins", "veslo-delegate.js"))).rejects.toThrow();
    await expect(stat(join(workspaceRoot, ".opencode", "agents", "veslo-internal-docx.md"))).rejects.toThrow();
    expect(registryCalls).toEqual([
      { pathname: "/v1/skill-installations", search: "?source=personal&target=personal-global" },
      { pathname: "/v1/skill-rollout-policies", search: "?target=user-global&enabled=true" },
      { pathname: "/v1/skill-versions/version_core_platform_docx_1/package", search: "" },
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
  const rolloutPkg = await archive("registry-rollout-tool");
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
      if (url.pathname === "/v1/skill-installations") {
        return Response.json({ installations: [], nextCursor: null });
      }
      if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "workspace") {
        return Response.json({
          policies: [
            {
              id: "rollout_workspace",
              skillId: "skill_rollout",
              versionId: "version_rollout",
              target: "workspace",
              audience: "selected-workspaces",
              catalogScope: "organization",
              orgId: "org_1",
              workspaceId: "ws_1",
              enabled: true,
              updatePolicy: "pinned",
              removalPolicy: "admin_removable",
              createdAt: "2026-05-30T10:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }
      if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "user-global") {
        return Response.json({ policies: [], nextCursor: null });
      }
      if (url.pathname === "/v1/skill-versions/version_1/package") {
        return Response.json({
          versionId: "version_1",
          skillId: "skill_1",
          package: pkg,
        });
      }
      if (url.pathname === "/v1/skill-versions/version_rollout/package") {
        return Response.json({
          versionId: "version_rollout",
          skillId: "skill_rollout",
          package: rolloutPkg,
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
    materializedSkills: MaterializedSkillPayload[];
  };
  expect(payload.status).toBe("synced");
  expect(payload.synced).toBe(true);
  expect(payload.materializedSkills).toEqual([{
    installationId: "install_1",
    skillId: "skill_1",
    name: "registry-tool",
    versionId: "version_1",
    packageSha256: pkg.packageSha256,
    source: "workspace",
    target: "workspace",
    removalPolicy: "user_removable",
  }, {
    installationId: "rollout:rollout_workspace",
    skillId: "skill_rollout",
    name: "registry-rollout-tool",
    versionId: "version_rollout",
    packageSha256: rolloutPkg.packageSha256,
    source: "organization",
    target: "workspace",
    removalPolicy: "admin_removable",
  }]);
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
    {
      pathname: "/v1/skill-installations",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
    },
    {
      pathname: "/v1/skill-rollout-policies",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
    },
    {
      pathname: "/v1/skill-versions/version_rollout/package",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
    },
    {
      pathname: "/v1/skill-rollout-policies",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
    },
  ]);
});

test("POST /workspace/:id/skills/materialization/sync reports rollout target conflicts", async () => {
  const personalPkg = await archive("conflict-user-tool");
  const workspacePkg = await archive("conflict-workspace-tool");
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/workspaces/ws_1/skill-set") {
        return Response.json({
          workspaceId: "ws_1",
          skills: [
            {
              installationId: "install_conflict_user",
              skillId: "skill_conflict",
              versionId: "version_conflict_user",
              enabled: true,
              source: "personal",
              installedAt: "2026-05-26T12:00:00.000Z",
              ownerUserId: "user_1",
            },
          ],
        });
      }
      if (url.pathname === "/v1/skill-installations") {
        return Response.json({ installations: [], nextCursor: null });
      }
      if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "workspace") {
        return Response.json({
          policies: [
            {
              id: "rollout_conflict_workspace",
              skillId: "skill_conflict",
              versionId: "version_conflict_workspace",
              target: "workspace",
              audience: "selected-workspaces",
              catalogScope: "organization",
              orgId: "org_1",
              workspaceId: "ws_1",
              enabled: true,
              updatePolicy: "pinned",
              removalPolicy: "admin_removable",
              createdAt: "2026-05-30T10:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }
      if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "user-global") {
        return Response.json({ policies: [], nextCursor: null });
      }
      if (url.pathname === "/v1/skill-versions/version_conflict_user/package") {
        return Response.json({ versionId: "version_conflict_user", skillId: "skill_conflict", package: personalPkg });
      }
      if (url.pathname === "/v1/skill-versions/version_conflict_workspace/package") {
        return Response.json({
          versionId: "version_conflict_workspace",
          skillId: "skill_conflict",
          package: workspacePkg,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const { server } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

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
    materializedSkills: Array<{ installationId: string; target: string }>;
    conflicts?: Array<{
      code: string;
      name: string;
      blockingInstallationId?: string;
      blockedInstallationId?: string;
      message: string;
    }>;
  };
  expect(payload.materializedSkills).toMatchObject([{
    installationId: "rollout:rollout_conflict_workspace",
    target: "workspace",
  }]);
  expect(payload.conflicts).toEqual([
    {
      code: "target-conflict",
      name: "conflict-user-tool",
      blockingInstallationId: "rollout:rollout_conflict_workspace",
      blockedInstallationId: "install_conflict_user",
      message: "Skill conflict-user-tool cannot be active as both user-global and workspace targets.",
    },
  ]);
});

test("POST /workspace/:id/skills/materialization/sync reports rollout-versus-rollout target conflicts", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-rollout-conflict-global-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const userGlobalPkg = await archive("rollout-user-tool");
    const workspacePkg = await archive("rollout-workspace-tool");
    const registryCalls: Array<{ pathname: string; search: string }> = [];
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        registryCalls.push({ pathname: url.pathname, search: url.search });
        if (url.pathname === "/v1/workspaces/ws_1/skill-set") {
          return Response.json({ workspaceId: "ws_1", skills: [] });
        }
        if (url.pathname === "/v1/skill-installations") {
          return Response.json({ installations: [], nextCursor: null });
        }
        if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "workspace") {
          return Response.json({
            policies: [
              {
                id: "rollout_conflict_workspace",
                skillId: "skill_rollout_conflict",
                versionId: "version_rollout_workspace",
                target: "workspace",
                audience: "selected-workspaces",
                catalogScope: "organization",
                orgId: "org_1",
                workspaceId: "ws_1",
                enabled: true,
                updatePolicy: "pinned",
                removalPolicy: "locked",
                createdAt: "2026-05-30T10:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "user-global") {
          return Response.json({
            policies: [
              {
                id: "rollout_conflict_user",
                skillId: "skill_rollout_conflict",
                versionId: "version_rollout_user",
                target: "user-global",
                audience: "all-org-users",
                catalogScope: "organization",
                orgId: "org_1",
                enabled: true,
                updatePolicy: "pinned",
                removalPolicy: "user_removable",
                createdAt: "2026-05-30T10:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/skill-versions/version_rollout_workspace/package") {
          return Response.json({
            versionId: "version_rollout_workspace",
            skillId: "skill_rollout_conflict",
            package: workspacePkg,
          });
        }
        if (url.pathname === "/v1/skill-versions/version_rollout_user/package") {
          return Response.json({
            versionId: "version_rollout_user",
            skillId: "skill_rollout_conflict",
            package: userGlobalPkg,
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
    const { server } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

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
      materializedSkills: Array<{ installationId: string; target: string }>;
      conflicts?: Array<{
        code: string;
        name: string;
        blockingInstallationId?: string;
        blockedInstallationId?: string;
        message: string;
      }>;
    };
    expect(payload.materializedSkills).toContainEqual(expect.objectContaining({
      installationId: "rollout:rollout_conflict_workspace",
      target: "workspace",
    }));
    expect(payload.materializedSkills).toContainEqual(expect.objectContaining({
      installationId: VESLO_AUTOMATIONS_PLATFORM_SKILL.installationId,
      target: "personal-global",
    }));
    expect(payload.conflicts).toEqual([
      {
        code: "target-conflict",
        name: "rollout-user-tool",
        blockingInstallationId: "rollout:rollout_conflict_workspace",
        blockedInstallationId: "rollout:rollout_conflict_user",
        message: "Skill rollout-user-tool cannot be active as both user-global and workspace targets.",
      },
    ]);
    expect(registryCalls).toContainEqual({
      pathname: "/v1/skill-rollout-policies",
      search: "?target=user-global&enabled=true",
    });
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

test("POST workspace materialization sync preserves existing personal global registry skills", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-workspace-preserve-global-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const personalPkg = await archive("personal-global-tool");
    const rolloutPkg = await archive("workspace-triggered-global-tool");
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/skill-installations") {
          return Response.json({
            installations: [
              {
                installationId: "install_personal_global",
                skillId: "skill_personal_global",
                versionId: "version_personal_global",
                enabled: true,
                source: "personal",
                installedAt: "2026-05-26T12:00:00.000Z",
                ownerUserId: "user_1",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/workspaces/ws_1/skill-set") {
          return Response.json({ workspaceId: "ws_1", skills: [] });
        }
        if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "workspace") {
          return Response.json({ policies: [], nextCursor: null });
        }
        if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "user-global") {
          return Response.json({
            policies: [
              {
                id: "rollout_user_global",
                skillId: "skill_user_global_rollout",
                versionId: "version_user_global_rollout",
                target: "user-global",
                audience: "all-org-users",
                catalogScope: "organization",
                orgId: "org_1",
                enabled: true,
                updatePolicy: "pinned",
                removalPolicy: "admin_removable",
                createdAt: "2026-05-30T10:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/skill-versions/version_personal_global/package") {
          return Response.json({
            versionId: "version_personal_global",
            skillId: "skill_personal_global",
            package: personalPkg,
          });
        }
        if (url.pathname === "/v1/skill-versions/version_user_global_rollout/package") {
          return Response.json({
            versionId: "version_user_global_rollout",
            skillId: "skill_user_global_rollout",
            package: rolloutPkg,
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
    const { server } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

    const globalResponse = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "x-veslo-den-org-id": "org_1",
        "x-veslo-den-user-id": "user_1",
      },
    });
    expect(globalResponse.status).toBe(200);

    const workspaceResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization/sync`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "x-veslo-den-org-id": "org_1",
        "x-veslo-den-user-id": "user_1",
      },
    });

    expect(workspaceResponse.status).toBe(200);
    const payload = await workspaceResponse.json() as { removedSkillNames: string[] };
    expect(payload.removedSkillNames).not.toContain("personal-global-tool");
    expect(
      await readFile(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "personal-global-tool", "SKILL.md"), "utf8"),
    ).toContain("# personal-global-tool");
    expect(
      await readFile(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "workspace-triggered-global-tool", "SKILL.md"), "utf8"),
    ).toContain("# workspace-triggered-global-tool");
    expect(
      await readFile(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations", "SKILL.md"), "utf8"),
    ).toContain("Veslo Automations Disabled");
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

test("POST workspace materialization sync removes personal global skill shadowed by workspace rollout", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-workspace-retarget-global-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const personalPkg = await archive("retargeted-tool");
    const workspacePkg = await archive("retargeted-tool");
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/skill-installations") {
          return Response.json({
            installations: [
              {
                installationId: "install_personal_global",
                skillId: "skill_retargeted",
                versionId: "version_personal_global",
                enabled: true,
                source: "personal",
                installedAt: "2026-05-26T12:00:00.000Z",
                ownerUserId: "user_1",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/workspaces/ws_1/skill-set") {
          return Response.json({ workspaceId: "ws_1", skills: [] });
        }
        if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "workspace") {
          return Response.json({
            policies: [
              {
                id: "rollout_workspace",
                skillId: "skill_retargeted",
                versionId: "version_workspace",
                target: "workspace",
                audience: "selected-workspaces",
                catalogScope: "organization",
                orgId: "org_1",
                workspaceId: "ws_1",
                enabled: true,
                updatePolicy: "pinned",
                removalPolicy: "admin_removable",
                createdAt: "2026-05-30T10:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "user-global") {
          return Response.json({ policies: [], nextCursor: null });
        }
        if (url.pathname === "/v1/skill-versions/version_personal_global/package") {
          return Response.json({
            versionId: "version_personal_global",
            skillId: "skill_retargeted",
            package: personalPkg,
          });
        }
        if (url.pathname === "/v1/skill-versions/version_workspace/package") {
          return Response.json({
            versionId: "version_workspace",
            skillId: "skill_retargeted",
            package: workspacePkg,
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
    const { server, workspaceRoot } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

    const globalResponse = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "x-veslo-den-org-id": "org_1",
        "x-veslo-den-user-id": "user_1",
      },
    });
    expect(globalResponse.status).toBe(200);

    const workspaceResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization/sync`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "x-veslo-den-org-id": "org_1",
        "x-veslo-den-user-id": "user_1",
      },
    });

    expect(workspaceResponse.status).toBe(200);
    const payload = await workspaceResponse.json() as {
      materializedSkills: Array<{ installationId: string; target: string }>;
      removedSkillNames: string[];
      conflicts?: Array<{ code: string; blockingInstallationId?: string; blockedInstallationId?: string }>;
    };
    expect(payload.materializedSkills).toContainEqual(expect.objectContaining({
      installationId: "rollout:rollout_workspace",
      target: "workspace",
    }));
    expect(payload.materializedSkills).toContainEqual(expect.objectContaining({
      installationId: VESLO_AUTOMATIONS_PLATFORM_SKILL.installationId,
      target: "personal-global",
    }));
    expect(payload.removedSkillNames).toContain("retargeted-tool");
    expect(payload.conflicts).toMatchObject([
      {
        code: "personal-global-shadowed",
        blockingInstallationId: "rollout:rollout_workspace",
        blockedInstallationId: "install_personal_global",
      },
    ]);
    expect(await readFile(join(workspaceRoot, ".opencode", "skills", "veslo-managed", "retargeted-tool", "SKILL.md"), "utf8"))
      .toContain("# retargeted-tool");
    expect(await readFile(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations", "SKILL.md"), "utf8"))
      .toContain("Veslo Automations Disabled");
    await expect(stat(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "retargeted-tool"))).rejects.toThrow();
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

test("POST workspace materialization sync skips out-of-scope user rollout package downloads", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-skip-out-of-scope-global-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const pkg = await archive("org-rollout-tool");
    const registryCalls: Array<{ pathname: string; search: string }> = [];
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        registryCalls.push({ pathname: url.pathname, search: url.search });
        if (url.pathname === "/v1/workspaces/ws_1/skill-set") {
          return Response.json({ workspaceId: "ws_1", skills: [] });
        }
        if (url.pathname === "/v1/skill-installations") {
          return Response.json({ installations: [], nextCursor: null });
        }
        if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "workspace") {
          return Response.json({ policies: [], nextCursor: null });
        }
        if (url.pathname === "/v1/skill-rollout-policies" && url.searchParams.get("target") === "user-global") {
          return Response.json({
            policies: [
              {
                id: "rollout_other_user",
                skillId: "skill_other_user",
                versionId: "version_other_user",
                target: "user-global",
                audience: "user",
                catalogScope: "organization",
                orgId: "org_1",
                userId: "user_2",
                enabled: true,
                updatePolicy: "pinned",
                removalPolicy: "user_removable",
                createdAt: "2026-05-30T10:00:00.000Z",
              },
              {
                id: "rollout_org",
                skillId: "skill_org_rollout",
                versionId: "version_org_rollout",
                target: "user-global",
                audience: "all-org-users",
                catalogScope: "organization",
                orgId: "org_1",
                enabled: true,
                updatePolicy: "pinned",
                removalPolicy: "admin_removable",
                createdAt: "2026-05-30T10:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/v1/skill-versions/version_org_rollout/package") {
          return Response.json({
            versionId: "version_org_rollout",
            skillId: "skill_org_rollout",
            package: pkg,
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
    const { server } = await startFixture({ registryBaseUrl: `http://127.0.0.1:${registry.port}` });

    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/materialization/sync`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "x-veslo-den-org-id": "org_1",
        "x-veslo-den-user-id": "user_1",
      },
    });

    expect(response.status).toBe(200);
    expect(registryCalls).toContainEqual({
      pathname: "/v1/skill-versions/version_org_rollout/package",
      search: "",
    });
    expect(registryCalls).not.toContainEqual({
      pathname: "/v1/skill-versions/version_other_user/package",
      search: "",
    });
    expect(await readFile(join(homeRoot, ".config", "opencode", "skills", "veslo-managed", "veslo-automations", "SKILL.md"), "utf8"))
      .toContain("Veslo Automations Disabled");
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
        if (url.pathname === "/v1/skill-installations") {
          return Response.json({ installations: [], nextCursor: null });
        }
        if (url.pathname === "/v1/skill-rollout-policies") {
          return Response.json({ policies: [], nextCursor: null });
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
      materializedSkills: MaterializedSkillPayload[];
      lockfilePath?: string;
    };
    expect(payload.materializedSkills).toEqual([{
      installationId: "install_org_shared",
      skillId: "skill_shared_org",
      name: "shared-tool",
      versionId: "version_org",
      packageSha256: orgPkg.packageSha256,
      source: "organization",
      target: "workspace",
      removalPolicy: "user_removable",
    }]);
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

test("GET workspace skills returns parsed local skill metadata through the server route", async () => {
  const { server, workspaceRoot } = await startFixture();
  const skillDir = join(workspaceRoot, ".opencode", "skills", "research-helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: research-helper",
      "description:   Research helper   ",
      "aliases: source lookup",
      "paths:",
      "  - docs/**",
      "disableModelInvocation: true",
      "userInvocable: false",
      "---",
      "",
      "# Research helper",
      "",
      "## When to use",
      "- Use for server route metadata checks.",
      "",
    ].join("\n"),
    "utf8",
  );

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills`, {
    headers: { Authorization: "Bearer client-token" },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    items: Array<{
      name: string;
      description: string;
      trigger?: string;
      aliases?: string[];
      paths?: string[];
      disableModelInvocation?: boolean;
      userInvocable?: boolean;
    }>;
  };
  expect(payload.items).toHaveLength(1);
  expect(payload.items[0]).toMatchObject({
    name: "research-helper",
    description: "Research helper",
    trigger: "Use for server route metadata checks.",
    aliases: ["source lookup"],
    paths: ["docs/**"],
    disableModelInvocation: true,
    userInvocable: false,
  });
});

test("GET workspace skills includes managed registry metadata for platform global skills", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeRoot = await tempDir("veslo-platform-list-home-");
  process.env.HOME = homeRoot;
  process.env.XDG_CONFIG_HOME = join(homeRoot, ".config");

  try {
    const { server } = await startFixture();
    const syncResponse = await fetch(`http://127.0.0.1:${server.port}/skills/materialization/sync-global`, {
      method: "POST",
      headers: { "x-veslo-host-token": "host-token" },
    });
    expect(syncResponse.status).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills?includeGlobal=true`, {
      headers: { Authorization: "Bearer client-token" },
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      items: Array<{
        name: string;
        scope: string;
        registry?: {
          skillId?: string;
          installationId?: string;
          policyId?: string;
          versionId?: string;
          packageSha256?: string;
          source?: string;
          removalPolicy?: string;
        };
      }>;
    };
    const item = payload.items.find((candidate) => candidate.name === "veslo-automations");

    expect(item).toMatchObject({
      name: "veslo-automations",
      scope: "global",
      registry: {
        installationId: "platform_install_veslo_automations",
        skillId: "platform_skill_veslo_automations",
        source: "platform",
        removalPolicy: "locked",
      },
    });
    expect(item?.registry?.policyId).toBeUndefined();
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
