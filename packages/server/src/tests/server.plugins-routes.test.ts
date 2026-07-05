import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { ApprovalService } from "../approvals.js";
import { ReloadEventStore } from "../events.js";
import { listPluginPolicyOverrides } from "../plugin-policy-store.js";
import {
  OPENCODE_SCHEDULER_PLATFORM_PLUGIN,
  SUPERPOWERS_PLATFORM_PLUGIN,
} from "../platform-managed-plugins.js";
import { registerPluginRoutes } from "../routes/plugins.js";
import { matchRoute, type RequestContext, type Route } from "../routing.js";
import { TokenService } from "../tokens.js";
import type { ServerConfig } from "../types.js";
import { userOpencodeConfigPath } from "../workspace-files.js";

const tempDirs: string[] = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  while (envRestores.length) {
    envRestores.pop()!();
  }
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Plugin workspace routes", () => {
  test("registers the workspace plugin contract", () => {
    const routes: Route[] = [];
    registerRoutes(routes, {
      serverDataDir: "/tmp/veslo-plugin-policy-test",
      userOpencodeConfigDir: "/tmp/veslo-plugin-policy-test-opencode",
    });

    expect(routes).toHaveLength(6);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/workspace/demo/plugins", "client"],
      ["POST", "/workspace/demo/plugins", "client"],
      ["POST", "/workspace/demo/plugins/materialization/sync", "client"],
      ["POST", "/workspace/demo/plugins/platform.superpowers/enabled", "client"],
      ["DELETE", "/workspace/demo/plugins/platform.superpowers", "client"],
      ["POST", "/workspace/demo/plugins/platform.superpowers/restore", "client"],
    ];

    for (const [method, path, auth] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
      expect(route?.params.id).toBe("demo");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/extensions/plugins")).toBeNull();
  });

  test("normal inventory includes unmanaged project/global plugins and visible managed policies", async () => {
    const fixture = await createFixture({
      projectPlugins: ["project-only@1.0.0"],
      globalPlugins: ["global-only@2.0.0"],
    });

    const body = await invokeJson(fixture, "GET", "/workspace/ws_1/plugins?includeGlobal=true&debug=false");

    const items = inventoryItems(body);
    const inventory = policyInventoryItems(body);
    expect(inventory).toContainEqual(expect.objectContaining({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      spec: SUPERPOWERS_PLATFORM_PLUGIN.spec,
      displayName: "Superpowers",
      owner: expect.objectContaining({ kind: "platform", id: "veslo-platform" }),
      scope: "platform",
      target: "user",
      source: "policy.platform",
      visibility: "visible",
      enabled: true,
      lifecycle: "active",
      removalPolicy: "user-removable",
      enabledPolicy: "user-toggleable",
      managed: true,
    }));
    expect(inventory.map((item) => item.id)).not.toContain(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.id);
    expect(items).toContainEqual(expect.objectContaining({
      spec: "project-only@1.0.0",
      scope: "project",
      source: "config",
      managed: false,
    }));
    expect(items).toContainEqual(expect.objectContaining({
      spec: "global-only@2.0.0",
      scope: "global",
      source: "config",
      managed: false,
    }));
  });

  test("legacy items keep unmanaged project config plugins visible for current app callers", async () => {
    const fixture = await createFixture({ projectPlugins: ["legacy-visible@1.0.0"] });

    const body = await invokeJson(fixture, "GET", "/workspace/ws_1/plugins?includeGlobal=false");

    expect(inventoryItems(body)).toContainEqual(expect.objectContaining({
      spec: "legacy-visible@1.0.0",
      source: "config",
      scope: "project",
      managed: false,
    }));
    expect(policyInventoryItems(body)).toContainEqual(expect.objectContaining({
      spec: "legacy-visible@1.0.0",
      source: "config.unmanaged",
      scope: "project",
      managed: false,
    }));
  });

  test("debug inventory includes hidden locked scheduler policy", async () => {
    const fixture = await createFixture();

    const body = await invokeJson(fixture, "GET", "/workspace/ws_1/plugins?debug=true");

    expect(policyInventoryItems(body)).toContainEqual(expect.objectContaining({
      id: OPENCODE_SCHEDULER_PLATFORM_PLUGIN.id,
      spec: OPENCODE_SCHEDULER_PLATFORM_PLUGIN.spec,
      displayName: "OpenCode Scheduler",
      owner: expect.objectContaining({ kind: "platform", id: "veslo-platform" }),
      scope: "platform",
      target: "user",
      source: "policy.platform",
      visibility: "hidden-debug-only",
      debugOnly: true,
      enabled: true,
      lifecycle: "active",
      removalPolicy: "locked",
      enabledPolicy: "locked-on",
      managed: true,
    }));
  });

  test("materialization sync applies active managed policies and emits reload events", async () => {
    const fixture = await createFixture();

    const body = await invokeJson(fixture, "POST", "/workspace/ws_1/plugins/materialization/sync");
    const globalConfig = JSON.parse(await readFile(userOpencodeConfigPath(fixture.userOpencodeConfigDir), "utf8"));

    expect(body).toMatchObject({
      ok: true,
      reloadRequired: true,
      conflicts: [],
    });
    expect(globalConfig.plugin).toEqual(expect.arrayContaining([
      OPENCODE_SCHEDULER_PLATFORM_PLUGIN.spec,
      SUPERPOWERS_PLATFORM_PLUGIN.spec,
    ]));
    expect(fixture.reloadEvents.list("ws_1")).toEqual([
      expect.objectContaining({
        reason: "plugins",
        trigger: expect.objectContaining({
          type: "plugin",
          name: "veslo-managed",
          action: "updated",
        }),
      }),
    ]);
  });

  test("managed enable route disables and re-enables user-toggleable policies", async () => {
    const fixture = await createFixture();

    const disabled = await invokeJson(
      fixture,
      "POST",
      "/workspace/ws_1/plugins/platform.superpowers/enabled",
      { enabled: false },
    );

    expect(disabled.item).toMatchObject({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      enabled: false,
      lifecycle: "disabled",
    });
    expect(await listPluginPolicyOverrides({ dataDir: fixture.dataDir })).toMatchObject([
      {
        pluginId: SUPERPOWERS_PLATFORM_PLUGIN.id,
        action: "disabled",
        scope: "user",
      },
    ]);

    const enabled = await invokeJson(
      fixture,
      "POST",
      "/workspace/ws_1/plugins/platform.superpowers/enabled",
      { enabled: true },
    );

    expect(enabled.item).toMatchObject({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      enabled: true,
      lifecycle: "active",
    });
    expect(await listPluginPolicyOverrides({ dataDir: fixture.dataDir })).toEqual([]);
  });

  test("managed remove route removes and restore route restores user-removable policies", async () => {
    const fixture = await createFixture();

    const removed = await invokeJson(fixture, "DELETE", "/workspace/ws_1/plugins/platform.superpowers");

    expect(removed.item).toMatchObject({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      enabled: false,
      lifecycle: "removed",
    });
    expect(await listPluginPolicyOverrides({ dataDir: fixture.dataDir })).toMatchObject([
      {
        pluginId: SUPERPOWERS_PLATFORM_PLUGIN.id,
        action: "removed",
        scope: "user",
      },
    ]);

    const restored = await invokeJson(fixture, "POST", "/workspace/ws_1/plugins/platform.superpowers/restore");

    expect(restored.item).toMatchObject({
      id: SUPERPOWERS_PLATFORM_PLUGIN.id,
      enabled: true,
      lifecycle: "active",
    });
    expect(await listPluginPolicyOverrides({ dataDir: fixture.dataDir })).toEqual([]);
  });

  test("legacy delete route still removes unmanaged project plugin specs", async () => {
    const fixture = await createFixture({ projectPlugins: ["legacy-plugin@1.0.0"] });

    const body = await invokeJson(fixture, "DELETE", "/workspace/ws_1/plugins/legacy-plugin");
    const projectConfig = JSON.parse(await readFile(join(fixture.workspaceRoot, "opencode.json"), "utf8"));

    expect(projectConfig.plugin).toEqual([]);
    expect(inventoryItems(body).map((item) => item.spec)).not.toContain("legacy-plugin@1.0.0");
  });

  test("delete rejects ambiguous managed-policy id and unmanaged project plugin collisions", async () => {
    const fixture = await createFixture({ projectPlugins: ["platform.superpowers@1.0.0"] });

    await expect(invokeJson(fixture, "DELETE", "/workspace/ws_1/plugins/platform.superpowers"))
      .rejects.toMatchObject({
        status: 409,
        code: "plugin_delete_ambiguous",
      });

    const projectConfig = JSON.parse(await readFile(join(fixture.workspaceRoot, "opencode.json"), "utf8"));
    expect(projectConfig.plugin).toEqual(["platform.superpowers@1.0.0"]);
    expect(await listPluginPolicyOverrides({ dataDir: fixture.dataDir })).toEqual([]);
  });

  test("locked scheduler disable and remove reject without mutating override state", async () => {
    const fixture = await createFixture();

    await expect(invokeJson(
      fixture,
      "POST",
      "/workspace/ws_1/plugins/platform.opencode-scheduler/enabled",
      { enabled: false },
    )).rejects.toMatchObject({
      status: 409,
      code: "plugin_policy_locked",
    });
    await expect(invokeJson(
      fixture,
      "DELETE",
      "/workspace/ws_1/plugins/platform.opencode-scheduler",
    )).rejects.toMatchObject({
      status: 409,
      code: "plugin_policy_locked",
    });

    expect(await listPluginPolicyOverrides({ dataDir: fixture.dataDir })).toEqual([]);
  });

  test("enabled route rejects unknown managed ids and invalid payloads", async () => {
    const fixture = await createFixture();

    await expect(invokeJson(
      fixture,
      "POST",
      "/workspace/ws_1/plugins/platform.unknown/enabled",
      { enabled: false },
    )).rejects.toMatchObject({
      status: 404,
      code: "plugin_policy_not_found",
    });
    await expect(invokeJson(
      fixture,
      "POST",
      "/workspace/ws_1/plugins/platform.superpowers/enabled",
      { enabled: "false" },
    )).rejects.toMatchObject({
      status: 400,
      code: "invalid_payload",
    });
  });

  test("locked scheduler restore rejects without mutating override state", async () => {
    const fixture = await createFixture();

    await expect(invokeJson(
      fixture,
      "POST",
      "/workspace/ws_1/plugins/platform.opencode-scheduler/restore",
    )).rejects.toMatchObject({
      status: 409,
      code: "plugin_policy_locked",
    });

    expect(await listPluginPolicyOverrides({ dataDir: fixture.dataDir })).toEqual([]);
  });
});

type PluginRouteDependencies = {
  serverDataDir: string;
  userOpencodeConfigDir?: string;
};

type Fixture = {
  routes: Route[];
  config: ServerConfig;
  approvals: ApprovalService;
  reloadEvents: ReloadEventStore;
  tokens: TokenService;
  workspaceRoot: string;
  dataDir: string;
  userOpencodeConfigDir: string;
};

function registerRoutes(routes: Route[], dependencies: PluginRouteDependencies): void {
  const register = registerPluginRoutes as unknown as (
    routes: Route[],
    dependencies: PluginRouteDependencies,
  ) => void;
  register(routes, dependencies);
}

async function createFixture(input: {
  projectPlugins?: string[];
  globalPlugins?: string[];
} = {}): Promise<Fixture> {
  const root = await tempDir("veslo-plugin-routes-");
  const workspaceRoot = join(root, "workspace");
  const dataDir = join(root, "data");
  const userOpencodeConfigDir = join(root, "user-opencode");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(userOpencodeConfigDir, { recursive: true });
  await writeFile(
    join(workspaceRoot, "opencode.json"),
    `${JSON.stringify({ plugin: input.projectPlugins ?? [] }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    userOpencodeConfigPath(userOpencodeConfigDir),
    `${JSON.stringify({ plugin: input.globalPlugins ?? [] }, null, 2)}\n`,
    "utf8",
  );

  const previousDataDir = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  envRestores.push(() => {
    if (previousDataDir === undefined) {
      delete process.env.VESLO_DATA_DIR;
    } else {
      process.env.VESLO_DATA_DIR = previousDataDir;
    }
  });

  const config = serverConfig(workspaceRoot, dataDir);
  const routes: Route[] = [];
  registerRoutes(routes, { serverDataDir: dataDir, userOpencodeConfigDir });
  const approvals = new ApprovalService(config.approval);
  return {
    routes,
    config,
    approvals,
    reloadEvents: new ReloadEventStore(),
    tokens: new TokenService(config),
    workspaceRoot,
    dataDir,
    userOpencodeConfigDir,
  };
}

async function invokeJson(
  fixture: Fixture,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = new URL(`http://127.0.0.1${path}`);
  const route = matchRoute(fixture.routes, method, url.pathname);
  expect(route).not.toBeNull();
  const request = new Request(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await route!.handler({
    request,
    url,
    params: route!.params,
    config: fixture.config,
    approvals: fixture.approvals,
    reloadEvents: fixture.reloadEvents,
    tokens: fixture.tokens,
    automationRunner: {} as RequestContext["automationRunner"],
    actor: { type: "remote", clientId: "test-client", tokenHash: "test-token", scope: "owner" },
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function inventoryItems(body: Record<string, unknown>): Array<Record<string, unknown>> {
  expect(Array.isArray(body.items)).toBe(true);
  return body.items as Array<Record<string, unknown>>;
}

function policyInventoryItems(body: Record<string, unknown>): Array<Record<string, unknown>> {
  expect(Array.isArray(body.inventory)).toBe(true);
  return body.inventory as Array<Record<string, unknown>>;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function serverConfig(workspaceRoot: string, dataDir: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    configPath: join(dataDir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1 },
    corsOrigins: [],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace 1",
        path: workspaceRoot,
        workspaceType: "local",
      },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "json",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 100,
      batchMaxBytes: 1024 * 1024,
      spoolMaxBytes: 1024 * 1024,
      flushIntervalMs: 1_000,
    },
  };
}
